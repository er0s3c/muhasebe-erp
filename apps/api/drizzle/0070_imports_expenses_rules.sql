-- =========================================================================
-- İthalat maliyet dağıtımı ve gider kartları (Faz X4): RLS, yetki, denetim izi, hesap eşlemesi geri doldurma ve iş kuralları.
-- İthalat kuralları ERRCODE ERP18 (API'de 422 IMPORT_RULE_VIOLATION), gider kuralları ERP19 (422 EXPENSE_RULE_VIOLATION) ile yükselir.
-- Durum geçişleri uygulama kodundaki tabloyla (shared/landed-cost.ts) birebir aynıdır; her geçiş aynı işlemde yazılmış olay kaydı ister.
-- Hesap eşlemesi varsayılanı DOĞRULANMAMIŞTIR (genel Tekdüzen yapı).
-- =========================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_files', 'import_file_lines', 'import_cost_lines', 'import_allocations', 'import_file_events', 'expense_cards', 'expense_entries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())',
      t);
    EXECUTE format(
      'CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    -- İthalat dosyası silinmez (iptal edilir); geçmiş yalnızca eklenir; satırlar taslakta değişir (tetikleyici denetler)
    GRANT SELECT, INSERT, UPDATE ON import_files, expense_entries TO erp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON import_file_lines, import_cost_lines, import_allocations, expense_cards TO erp_app;
    GRANT SELECT, INSERT ON import_file_events TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- Mevcut şirketler için ithalat maliyeti aktarım hesabı (varsayılan 632: gideri ilk yazdığınız hesap; doğrulanmamıştır)
INSERT INTO account_mappings (id, company_id, key, account_id)
SELECT gen_random_uuid(), c.id, 'import_cost_clearing', a.id
FROM companies c
JOIN accounts a ON a.company_id = c.id AND a.code = '632'
ON CONFLICT (company_id, key) DO NOTHING;
--> statement-breakpoint

-- ---- İthalat dosyası ----------------------------------------------------------------------------------------------
CREATE FUNCTION import_files_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  valid boolean;
  bad integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'İthalat dosyası silinemez; iptal edin' USING ERRCODE = 'ERP18';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'İthalat dosyası taslak olarak oluşturulur' USING ERRCODE = 'ERP18';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.company_id <> OLD.company_id OR NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'İthalat dosyası kodu değiştirilemez' USING ERRCODE = 'ERP18';
  END IF;

  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Taslak dışındaki ithalat dosyası değiştirilemez' USING ERRCODE = 'ERP18';
    END IF;
    IF NEW.allocated_at IS DISTINCT FROM OLD.allocated_at OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
       OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id OR NEW.stock_document_id IS DISTINCT FROM OLD.stock_document_id THEN
      RAISE EXCEPTION 'Muhasebe alanları yalnızca durum geçişiyle yazılır' USING ERRCODE = 'ERP18';
    END IF;
    RETURN NEW;
  END IF;

  valid := (OLD.status = 'draft' AND NEW.status IN ('allocated', 'cancelled'))
        OR (OLD.status = 'allocated' AND NEW.status IN ('draft', 'posted', 'cancelled'))
        OR (OLD.status = 'posted' AND NEW.status = 'cancelled');
  IF NOT valid THEN
    RAISE EXCEPTION 'Geçersiz durum geçişi: % -> %', OLD.status, NEW.status USING ERRCODE = 'ERP18';
  END IF;
  IF NEW.name <> OLD.name OR NEW.method <> OLD.method OR NEW.file_date <> OLD.file_date
     OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.description IS DISTINCT FROM OLD.description THEN
    RAISE EXCEPTION 'Durum değişirken başlık alanları değiştirilemez' USING ERRCODE = 'ERP18';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM import_file_events e
     WHERE e.import_file_id = NEW.id AND e.company_id = NEW.company_id AND e.from_status = OLD.status AND e.to_status = NEW.status
       AND e.created_at = now()
  ) THEN
    RAISE EXCEPTION 'Durum değişikliği için aynı işlemde olay (geçmiş) kaydı gerekir' USING ERRCODE = 'ERP18';
  END IF;

  IF NEW.status IN ('allocated', 'posted') THEN
    IF NOT EXISTS (SELECT 1 FROM import_file_lines l WHERE l.import_file_id = NEW.id AND l.is_active)
       OR NOT EXISTS (SELECT 1 FROM import_cost_lines c WHERE c.import_file_id = NEW.id) THEN
      RAISE EXCEPTION 'Dosyada en az bir mal satırı ve bir maliyet kalemi olmalı' USING ERRCODE = 'ERP18';
    END IF;
    SELECT count(*) INTO bad FROM import_cost_lines c
     WHERE c.import_file_id = NEW.id
       AND c.amount_base <> coalesce((SELECT sum(a.amount) FROM import_allocations a WHERE a.cost_line_id = c.id), 0);
    IF bad > 0 THEN
      RAISE EXCEPTION 'Her maliyet kaleminin dağıtılan payları toplamı kalem tutarına eşit olmalı' USING ERRCODE = 'ERP18';
    END IF;
  END IF;
  IF NEW.status = 'posted' THEN
    IF NEW.journal_entry_id IS NULL THEN
      RAISE EXCEPTION 'Muhasebeleşen dosyanın yevmiyesi olmalı' USING ERRCODE = 'ERP18';
    END IF;
    SELECT count(*) INTO bad FROM import_file_lines l
     WHERE l.import_file_id = NEW.id AND l.is_active
       AND (l.stocked_amount IS NULL OR l.cogs_amount IS NULL
            OR l.stocked_amount + l.cogs_amount <> coalesce((SELECT sum(a.amount) FROM import_allocations a WHERE a.file_line_id = l.id), 0));
    IF bad > 0 THEN
      RAISE EXCEPTION 'Satır payı stok maliyeti ile satılan mal maliyetinin toplamına eşit olmalı' USING ERRCODE = 'ERP18';
    END IF;
  END IF;
  IF NEW.status = 'draft' AND EXISTS (SELECT 1 FROM import_allocations a WHERE a.import_file_id = NEW.id) THEN
    RAISE EXCEPTION 'Taslağa dönmeden önce dağıtım sonuçları silinmeli' USING ERRCODE = 'ERP18';
  END IF;
  IF NEW.status = 'cancelled' THEN
    IF NEW.cancelled_at IS NULL OR coalesce(btrim(NEW.cancel_reason), '') = '' THEN
      RAISE EXCEPTION 'İptal için neden ve zaman gerekir' USING ERRCODE = 'ERP18';
    END IF;
    IF OLD.status = 'posted' AND NEW.cancel_journal_entry_id IS NULL THEN
      RAISE EXCEPTION 'Muhasebeleşmiş dosyanın iptali ters yevmiye ister' USING ERRCODE = 'ERP18';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER import_files_guard
  BEFORE INSERT OR UPDATE OR DELETE ON import_files
  FOR EACH ROW EXECUTE FUNCTION import_files_guard();
--> statement-breakpoint

-- Mal satırı: yalnızca taslakta eklenir/silinir; kaynak kayıtlı alış faturası (stoklu, irsaliyesiz) ya da alış irsaliyesi satırı olmalı.
CREATE FUNCTION import_file_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  f import_files%ROWTYPE;
  fid uuid;
BEGIN
  fid := CASE WHEN TG_OP = 'DELETE' THEN OLD.import_file_id ELSE NEW.import_file_id END;
  SELECT * INTO f FROM import_files WHERE id = fid FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'İthalat dosyası bulunamadı' USING ERRCODE = 'ERP18';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF f.status <> 'draft' THEN
      RAISE EXCEPTION 'Mal satırı yalnızca taslak dosyada silinebilir' USING ERRCODE = 'ERP18';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF f.status <> 'draft' THEN
      RAISE EXCEPTION 'Mal satırı yalnızca taslak dosyaya eklenebilir' USING ERRCODE = 'ERP18';
    END IF;
    IF NEW.source_kind = 'invoice' THEN
      IF NOT EXISTS (
        SELECT 1 FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
         WHERE il.id = NEW.invoice_line_id AND il.company_id = NEW.company_id AND i.type = 'purchase' AND i.status = 'posted'
           AND il.item_id = NEW.item_id AND il.delivery_line_id IS NULL
      ) THEN
        RAISE EXCEPTION 'Kaynak, kaydedilmiş alış faturasının stoklu (irsaliyesiz) satırı olmalı' USING ERRCODE = 'ERP18';
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1 FROM delivery_note_lines dl JOIN delivery_notes n ON n.id = dl.note_id
         WHERE dl.id = NEW.delivery_line_id AND dl.company_id = NEW.company_id AND n.type = 'purchase' AND n.status = 'posted'
           AND dl.item_id = NEW.item_id
      ) THEN
        RAISE EXCEPTION 'Kaynak, kaydedilmiş alış irsaliyesinin satırı olmalı' USING ERRCODE = 'ERP18';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: kimlik alanları hiçbir durumda değişmez
  IF NEW.company_id <> OLD.company_id OR NEW.import_file_id <> OLD.import_file_id OR NEW.line_no <> OLD.line_no
     OR NEW.source_kind <> OLD.source_kind OR NEW.invoice_line_id IS DISTINCT FROM OLD.invoice_line_id
     OR NEW.delivery_line_id IS DISTINCT FROM OLD.delivery_line_id OR NEW.item_id <> OLD.item_id OR NEW.warehouse_id <> OLD.warehouse_id
     OR NEW.source_doc_no <> OLD.source_doc_no OR NEW.source_date <> OLD.source_date
     OR NEW.quantity <> OLD.quantity OR NEW.value_base <> OLD.value_base THEN
    RAISE EXCEPTION 'Mal satırının kaynağı, miktarı ve değeri değiştirilemez' USING ERRCODE = 'ERP18';
  END IF;
  IF f.status = 'draft' THEN
    IF NEW.stocked_amount IS DISTINCT FROM OLD.stocked_amount OR NEW.cogs_amount IS DISTINCT FROM OLD.cogs_amount OR NEW.is_active <> OLD.is_active THEN
      RAISE EXCEPTION 'Taslakta yalnızca ağırlık değişir' USING ERRCODE = 'ERP18';
    END IF;
  ELSIF f.status = 'allocated' THEN
    IF NEW.weight IS DISTINCT FROM OLD.weight OR NEW.is_active <> OLD.is_active THEN
      RAISE EXCEPTION 'Dağıtılmış dosyada yalnızca kayıt payları yazılır' USING ERRCODE = 'ERP18';
    END IF;
  ELSIF f.status = 'cancelled' THEN
    IF NEW.weight IS DISTINCT FROM OLD.weight OR NEW.stocked_amount IS DISTINCT FROM OLD.stocked_amount OR NEW.cogs_amount IS DISTINCT FROM OLD.cogs_amount
       OR NEW.is_active OR NOT OLD.is_active THEN
      RAISE EXCEPTION 'İptal edilen dosyada satır yalnızca serbest bırakılır' USING ERRCODE = 'ERP18';
    END IF;
  ELSE
    RAISE EXCEPTION 'Muhasebeleşmiş dosyanın satırı değiştirilemez' USING ERRCODE = 'ERP18';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER import_file_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON import_file_lines
  FOR EACH ROW EXECUTE FUNCTION import_file_lines_guard();
--> statement-breakpoint

-- Maliyet kalemi: yalnızca taslakta; bağlı fatura kayıtlı ve (cari verilmişse) aynı carinin olmalı.
CREATE FUNCTION import_cost_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  f import_files%ROWTYPE;
  fid uuid;
BEGIN
  fid := CASE WHEN TG_OP = 'DELETE' THEN OLD.import_file_id ELSE NEW.import_file_id END;
  SELECT * INTO f FROM import_files WHERE id = fid FOR SHARE;
  IF NOT FOUND OR f.status <> 'draft' THEN
    RAISE EXCEPTION 'Maliyet kalemi yalnızca taslak dosyada değiştirilebilir' USING ERRCODE = 'ERP18';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.invoice_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM invoices i
       WHERE i.id = NEW.invoice_id AND i.company_id = NEW.company_id AND i.status = 'posted'
         AND (NEW.party_id IS NULL OR i.party_id = NEW.party_id)
    ) THEN
      RAISE EXCEPTION 'Bağlı fatura kaydedilmiş ve ödenen carinin faturası olmalı' USING ERRCODE = 'ERP18';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER import_cost_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON import_cost_lines
  FOR EACH ROW EXECUTE FUNCTION import_cost_lines_guard();
--> statement-breakpoint

-- Dağıtım payı: yalnızca taslak/dağıtılmış dosyada eklenir ve silinir, değişmez; kalem ve satır aynı dosyaya ait olmalı.
CREATE FUNCTION import_allocations_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  f import_files%ROWTYPE;
  fid uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Dağıtım payı değiştirilemez; yeniden dağıtın' USING ERRCODE = 'ERP18';
  END IF;
  fid := CASE WHEN TG_OP = 'DELETE' THEN OLD.import_file_id ELSE NEW.import_file_id END;
  SELECT * INTO f FROM import_files WHERE id = fid FOR SHARE;
  IF NOT FOUND OR f.status NOT IN ('draft', 'allocated') THEN
    RAISE EXCEPTION 'Dağıtım payı yalnızca taslak ya da dağıtılmış dosyada değişir' USING ERRCODE = 'ERP18';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM import_cost_lines c WHERE c.id = NEW.cost_line_id AND c.import_file_id = NEW.import_file_id)
     OR NOT EXISTS (SELECT 1 FROM import_file_lines l WHERE l.id = NEW.file_line_id AND l.import_file_id = NEW.import_file_id AND l.is_active) THEN
    RAISE EXCEPTION 'Dağıtım payının kalemi ve satırı aynı dosyaya ait olmalı' USING ERRCODE = 'ERP18';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER import_allocations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON import_allocations
  FOR EACH ROW EXECUTE FUNCTION import_allocations_guard();
--> statement-breakpoint

-- Geçmiş: yalnızca eklenir; önceki durum dosyanın o anki durumudur ve geçiş geçerlidir.
CREATE FUNCTION import_file_events_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  f import_files%ROWTYPE;
  valid boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'İthalat dosyası geçmişi değiştirilemez ve silinemez' USING ERRCODE = 'ERP18';
  END IF;
  SELECT * INTO f FROM import_files WHERE id = NEW.import_file_id AND company_id = NEW.company_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'İthalat dosyası bulunamadı' USING ERRCODE = 'ERP18';
  END IF;
  IF NEW.from_status IS NULL THEN
    IF NEW.to_status <> 'draft' OR f.status <> 'draft' OR EXISTS (SELECT 1 FROM import_file_events e WHERE e.import_file_id = NEW.import_file_id) THEN
      RAISE EXCEPTION 'Oluşturma olayı dosya başına bir kez ve taslak durumunda yazılır' USING ERRCODE = 'ERP18';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.from_status <> f.status THEN
    RAISE EXCEPTION 'Olayın önceki durumu dosyanın durumuyla uyuşmuyor (% / %)', NEW.from_status, f.status USING ERRCODE = 'ERP18';
  END IF;
  valid := (NEW.from_status = 'draft' AND NEW.to_status IN ('draft', 'allocated', 'cancelled'))
        OR (NEW.from_status = 'allocated' AND NEW.to_status IN ('draft', 'posted', 'cancelled'))
        OR (NEW.from_status = 'posted' AND NEW.to_status = 'cancelled');
  IF NOT valid THEN
    RAISE EXCEPTION 'Geçersiz durum geçişi: % -> %', NEW.from_status, NEW.to_status USING ERRCODE = 'ERP18';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER import_file_events_guard
  BEFORE INSERT OR UPDATE OR DELETE ON import_file_events
  FOR EACH ROW EXECUTE FUNCTION import_file_events_guard();
--> statement-breakpoint

-- ---- Gider kartı ve gider fişi -------------------------------------------------------------------------------------
CREATE FUNCTION expense_cards_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM expense_entries e WHERE e.card_id = OLD.id) THEN
      RAISE EXCEPTION 'Gider fişi olan kart silinemez; pasifleştirin' USING ERRCODE = 'ERP19';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.account_id <> OLD.account_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM accounts a
       WHERE a.id = NEW.account_id AND a.company_id = NEW.company_id AND a.type IN ('income', 'expense', 'cost') AND a.is_postable AND a.party_control IS NULL
    ) THEN
      RAISE EXCEPTION 'Gider kartının hesabı kayıt atılabilen bir gelir tablosu (gider/maliyet) hesabı olmalı' USING ERRCODE = 'ERP19';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER expense_cards_guard
  BEFORE INSERT OR UPDATE OR DELETE ON expense_cards
  FOR EACH ROW EXECUTE FUNCTION expense_cards_guard();
--> statement-breakpoint

-- Gider fişi: kayıtlı doğar (kaynaklı yevmiyesiyle); tek geçiş iptaldir ve ters yevmiye ister; silinemez.
CREATE FUNCTION expense_entries_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Gider fişi silinemez; iptal edin' USING ERRCODE = 'ERP19';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'posted' THEN
      RAISE EXCEPTION 'Gider fişi kayıtlı olarak oluşturulur' USING ERRCODE = 'ERP19';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM journal_entries j
       WHERE j.id = NEW.journal_entry_id AND j.company_id = NEW.company_id AND j.status = 'posted'
         AND j.source_type = 'expense_entry' AND j.source_id = NEW.id AND j.reversal_of_id IS NULL
    ) THEN
      RAISE EXCEPTION 'Gider fişinin kaynaklı, kaydedilmiş yevmiyesi olmalı' USING ERRCODE = 'ERP19';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'İptal edilmiş gider fişi değiştirilemez' USING ERRCODE = 'ERP19';
  END IF;
  IF NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'Kaydedilmiş gider fişi değiştirilemez; iptal edip yeniden girin' USING ERRCODE = 'ERP19';
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.entry_no <> OLD.entry_no OR NEW.entry_date <> OLD.entry_date OR NEW.card_id <> OLD.card_id
     OR NEW.description <> OLD.description OR NEW.party_id IS DISTINCT FROM OLD.party_id OR NEW.payment_kind <> OLD.payment_kind
     OR NEW.treasury_account_id IS DISTINCT FROM OLD.treasury_account_id OR NEW.net <> OLD.net OR NEW.vat <> OLD.vat
     OR NEW.withholding <> OLD.withholding OR NEW.gross <> OLD.gross OR NEW.payable <> OLD.payable
     OR NEW.document_ref IS DISTINCT FROM OLD.document_ref OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.wbs_id IS DISTINCT FROM OLD.wbs_id OR NEW.cost_code_id IS DISTINCT FROM OLD.cost_code_id
     OR NEW.journal_entry_id <> OLD.journal_entry_id THEN
    RAISE EXCEPTION 'İptalde yalnızca iptal alanları yazılır' USING ERRCODE = 'ERP19';
  END IF;
  IF coalesce(btrim(NEW.cancel_reason), '') = '' OR NOT EXISTS (
    SELECT 1 FROM journal_entries j WHERE j.id = NEW.cancel_journal_entry_id AND j.reversal_of_id = NEW.journal_entry_id
  ) THEN
    RAISE EXCEPTION 'İptal için neden ve ters yevmiye gerekir' USING ERRCODE = 'ERP19';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER expense_entries_guard
  BEFORE INSERT OR UPDATE OR DELETE ON expense_entries
  FOR EACH ROW EXECUTE FUNCTION expense_entries_guard();
