-- =========================================================================
-- Çek/senet portföyü ve takas, banka teminat mektubu portföyü (Faz X1): RLS, yetki, denetim izi, hesap eşlemesi geri doldurma,
-- iş kuralları (ERRCODE ERP14 → CHEQUE_RULE_VIOLATION). Durum geçişleri uygulama kodundaki tabloyla (shared/cheque-calc.ts) birebir aynıdır.
-- Hesap eşlemesi varsayılanları DOĞRULANMAMIŞTIR (genel Tekdüzen yapı).
-- =========================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cheques', 'cheque_batches', 'cheque_events', 'cheque_allocations', 'bank_guarantees', 'portfolio_settings'] LOOP
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
    -- Çek/senet silinmez; olaylar, toplu işlem başlıkları ve eşleştirmeler yalnızca eklenir
    GRANT SELECT, INSERT, UPDATE ON cheques, portfolio_settings TO erp_app;
    GRANT SELECT, INSERT ON cheque_batches, cheque_events, cheque_allocations TO erp_app;
    -- Mektup: yalnızca aktifken silinebilir (tetikleyici denetler)
    GRANT SELECT, INSERT, UPDATE, DELETE ON bank_guarantees TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- Mevcut şirketler için çek/senet hesap eşlemeleri (genel Tekdüzen yapıya dayanır, doğrulanmamıştır)
INSERT INTO account_mappings (id, company_id, key, account_id)
SELECT gen_random_uuid(), c.id, m.key, a.id
FROM companies c
CROSS JOIN (VALUES
  ('cheque_portfolio', '101'),
  ('note_portfolio', '121'),
  ('docs_in_collection', '108'),
  ('cheque_issued', '103'),
  ('note_payable', '321')
) AS m(key, code)
JOIN accounts a ON a.company_id = c.id AND a.code = m.code
ON CONFLICT (company_id, key) DO NOTHING;
--> statement-breakpoint

-- Çek/senet: kayıtta başlangıç durumu; kimlik/tutar/cari/vade değişmez; durum yalnızca geçerli geçişle ve aynı işlemde yazılmış
-- olay kaydıyla değişir; silinemez.
CREATE FUNCTION cheques_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  valid boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Çek/senet silinemez' USING ERRCODE = 'ERP14';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> (CASE NEW.direction WHEN 'received' THEN 'portfolio' ELSE 'issued' END) OR NEW.holder_party_id IS NOT NULL THEN
      RAISE EXCEPTION 'Çek/senet başlangıç durumunda kaydedilmelidir (alınan: portföyde, verilen: düzenlendi)' USING ERRCODE = 'ERP14';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.company_id <> OLD.company_id OR NEW.direction <> OLD.direction OR NEW.doc_type <> OLD.doc_type OR NEW.doc_no <> OLD.doc_no
     OR NEW.bank_name <> OLD.bank_name OR NEW.party_id <> OLD.party_id OR NEW.amount <> OLD.amount OR NEW.currency_code <> OLD.currency_code
     OR NEW.issue_date <> OLD.issue_date OR NEW.due_date <> OLD.due_date OR NEW.entry_id <> OLD.entry_id THEN
    RAISE EXCEPTION 'Çek/senet numarası, cari, tutar, para birimi ve tarihleri sonradan değiştirilemez' USING ERRCODE = 'ERP14';
  END IF;

  IF NEW.status <> OLD.status THEN
    valid := CASE NEW.direction
      WHEN 'received' THEN
        (OLD.status = 'portfolio' AND NEW.status IN ('in_collection', 'endorsed', 'returned'))
        OR (OLD.status = 'in_collection' AND NEW.status IN ('collected', 'bounced'))
        OR (OLD.status = 'endorsed' AND NEW.status = 'portfolio')
      ELSE
        OLD.status = 'issued' AND NEW.status IN ('paid', 'bounced', 'cancelled')
    END;
    IF NOT valid THEN
      RAISE EXCEPTION 'Geçersiz durum geçişi: % -> %', OLD.status, NEW.status USING ERRCODE = 'ERP14';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM cheque_events e
       WHERE e.cheque_id = NEW.id AND e.company_id = NEW.company_id AND e.from_status = OLD.status AND e.to_status = NEW.status
         AND e.created_at = now()
    ) THEN
      RAISE EXCEPTION 'Durum değişikliği için aynı işlemde olay (geçmiş) kaydı gerekir' USING ERRCODE = 'ERP14';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER cheques_guard
  BEFORE INSERT OR UPDATE OR DELETE ON cheques
  FOR EACH ROW EXECUTE FUNCTION cheques_guard();
--> statement-breakpoint

-- Olay: yalnızca eklenir; önceki durum belgenin o anki durumudur ve geçiş geçerlidir; kayıt olayı (önceki durum boş) belge başına tektir.
CREATE FUNCTION cheque_events_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  c cheques%ROWTYPE;
  valid boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Çek/senet geçmişi değiştirilemez ve silinemez' USING ERRCODE = 'ERP14';
  END IF;
  SELECT * INTO c FROM cheques WHERE id = NEW.cheque_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Çek/senet bulunamadı' USING ERRCODE = 'ERP14';
  END IF;
  IF NEW.from_status IS NULL THEN
    IF EXISTS (SELECT 1 FROM cheque_events e WHERE e.cheque_id = NEW.cheque_id) OR NEW.to_status <> c.status THEN
      RAISE EXCEPTION 'Kayıt olayı belge başına bir kez ve başlangıç durumunda yazılır' USING ERRCODE = 'ERP14';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.from_status <> c.status THEN
    RAISE EXCEPTION 'Olayın önceki durumu belgenin durumuyla uyuşmuyor (% / %)', NEW.from_status, c.status USING ERRCODE = 'ERP14';
  END IF;
  valid := CASE c.direction
    WHEN 'received' THEN
      (NEW.from_status = 'portfolio' AND NEW.to_status IN ('in_collection', 'endorsed', 'returned'))
      OR (NEW.from_status = 'in_collection' AND NEW.to_status IN ('collected', 'bounced'))
      OR (NEW.from_status = 'endorsed' AND NEW.to_status = 'portfolio')
    ELSE
      NEW.from_status = 'issued' AND NEW.to_status IN ('paid', 'bounced', 'cancelled')
  END;
  IF NOT valid THEN
    RAISE EXCEPTION 'Geçersiz durum geçişi: % -> %', NEW.from_status, NEW.to_status USING ERRCODE = 'ERP14';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER cheque_events_guard
  BEFORE INSERT OR UPDATE OR DELETE ON cheque_events
  FOR EACH ROW EXECUTE FUNCTION cheque_events_guard();
--> statement-breakpoint

CREATE FUNCTION cheque_batches_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Toplu işlem kaydı değiştirilemez ve silinemez' USING ERRCODE = 'ERP14';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER cheque_batches_guard
  BEFORE INSERT OR UPDATE OR DELETE ON cheque_batches
  FOR EACH ROW EXECUTE FUNCTION cheque_batches_guard();
--> statement-breakpoint

-- Eşleştirme: yalnızca eklenir; olayın yevmiyesindeki cari satırı bir kalemi kapatır; tür belge yönüne ve olaya uyar (alınan kayıt = alacak,
-- verilen kayıt ve ciro = borç); bir kalem için eşleştirilen toplam (kasa/banka + çek/senet) kalemi aşamaz (kalem satırı kilitlenir).
CREATE FUNCTION cheque_allocations_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  ev cheque_events%ROWTYPE;
  c cheques%ROWTYPE;
  ch journal_lines%ROWTYPE;
  st journal_lines%ROWTYPE;
  ca accounts%ROWTYPE;
  sa accounts%ROWTYPE;
  charge_amount numeric;
  charge_base numeric;
  settle_amount numeric;
  settle_base numeric;
  used_amount numeric;
  used_base numeric;
  used_amount2 numeric;
  used_base2 numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Eşleştirme kayıtları değiştirilemez ve silinemez' USING ERRCODE = 'ERP14';
  END IF;

  SELECT * INTO ev FROM cheque_events WHERE id = NEW.event_id AND company_id = NEW.company_id;
  IF NOT FOUND OR ev.cheque_id <> NEW.cheque_id THEN
    RAISE EXCEPTION 'Eşleştirme belgenin olayına ait olmalı' USING ERRCODE = 'ERP14';
  END IF;
  SELECT * INTO c FROM cheques WHERE id = NEW.cheque_id AND company_id = NEW.company_id;
  IF NOT ((c.direction = 'received' AND ev.from_status IS NULL AND NEW.control = 'receivable')
       OR (c.direction = 'received' AND ev.to_status = 'endorsed' AND NEW.control = 'payable')
       OR (c.direction = 'issued' AND ev.from_status IS NULL AND NEW.control = 'payable')) THEN
    RAISE EXCEPTION 'Eşleştirme türü olayla uyuşmuyor (alınan kayıt: alacak, verilen kayıt ve ciro: borç)' USING ERRCODE = 'ERP14';
  END IF;

  SELECT * INTO ch FROM journal_lines WHERE id = NEW.charge_line_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Eşleştirilen kalem bulunamadı' USING ERRCODE = 'ERP14';
  END IF;
  SELECT * INTO st FROM journal_lines WHERE id = NEW.settle_line_id AND company_id = NEW.company_id;
  IF NOT FOUND OR st.entry_id <> ev.entry_id THEN
    RAISE EXCEPTION 'Kapatan satır olayın yevmiyesinde olmalı' USING ERRCODE = 'ERP14';
  END IF;

  SELECT * INTO ca FROM accounts WHERE id = ch.account_id AND company_id = NEW.company_id;
  SELECT * INTO sa FROM accounts WHERE id = st.account_id AND company_id = NEW.company_id;
  IF ca.party_control IS DISTINCT FROM NEW.control OR sa.party_control IS DISTINCT FROM NEW.control
     OR ch.party_id IS DISTINCT FROM NEW.party_id OR st.party_id IS DISTINCT FROM NEW.party_id THEN
    RAISE EXCEPTION 'Kalem ve kapatan satır aynı cari ve cari kontrol hesabında olmalı' USING ERRCODE = 'ERP14';
  END IF;

  IF NEW.control = 'receivable' THEN
    charge_amount := ch.debit;  charge_base := ch.debit_base;
    settle_amount := st.credit; settle_base := st.credit_base;
  ELSE
    charge_amount := ch.credit; charge_base := ch.credit_base;
    settle_amount := st.debit;  settle_base := st.debit_base;
  END IF;
  IF charge_amount <= 0 OR settle_amount <= 0 THEN
    RAISE EXCEPTION 'Kalem ya da kapatan satırın yönü yanlış' USING ERRCODE = 'ERP14';
  END IF;
  IF ch.currency_code <> st.currency_code OR settle_amount <> NEW.amount OR settle_base <> NEW.amount_base THEN
    RAISE EXCEPTION 'Eşleştirme kapatan satırın tutarıyla uyuşmuyor' USING ERRCODE = 'ERP14';
  END IF;

  SELECT coalesce(sum(a.amount), 0), coalesce(sum(a.amount_base), 0) INTO used_amount, used_base
    FROM party_allocations a JOIN treasury_transactions t ON t.id = a.transaction_id
   WHERE a.charge_line_id = NEW.charge_line_id AND t.status = 'posted';
  SELECT coalesce(sum(a.amount), 0), coalesce(sum(a.amount_base), 0) INTO used_amount2, used_base2
    FROM cheque_allocations a WHERE a.charge_line_id = NEW.charge_line_id;
  IF used_amount + used_amount2 + NEW.amount > charge_amount OR used_base + used_base2 + NEW.amount_base > charge_base THEN
    RAISE EXCEPTION 'Kalem için eşleştirilen tutar kalemin tutarını aşıyor' USING ERRCODE = 'ERP14';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER cheque_allocations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON cheque_allocations
  FOR EACH ROW EXECUTE FUNCTION cheque_allocations_guard();
--> statement-breakpoint

-- Teminat mektubu: kimlik/tutar/taraf değişmez; active -> returned | liquidated | expired tek yönlüdür; sonuçlanmış mektup donar;
-- yalnızca aktif mektup silinir; proje ve sözleşme (varsa) tutarlı olmalı.
CREATE FUNCTION bank_guarantees_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  sp uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'active' THEN
      RAISE EXCEPTION 'Sonuçlanmış teminat mektubu silinemez' USING ERRCODE = 'ERP14';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'Teminat mektubu aktif olarak kaydedilir' USING ERRCODE = 'ERP14';
    END IF;
  ELSE
    IF NEW.company_id <> OLD.company_id OR NEW.direction <> OLD.direction OR NEW.letter_no <> OLD.letter_no OR NEW.bank_name <> OLD.bank_name
       OR NEW.party_id IS DISTINCT FROM OLD.party_id OR NEW.counterparty_name <> OLD.counterparty_name OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.subcontract_id IS DISTINCT FROM OLD.subcontract_id OR NEW.amount <> OLD.amount OR NEW.currency_code <> OLD.currency_code
       OR NEW.issue_date <> OLD.issue_date THEN
      RAISE EXCEPTION 'Mektup numarası, banka, taraf, bağlantı, tutar, para birimi ve düzenleme tarihi sonradan değiştirilemez' USING ERRCODE = 'ERP14';
    END IF;
    IF OLD.status <> 'active' THEN
      RAISE EXCEPTION 'Sonuçlanmış teminat mektubu değiştirilemez' USING ERRCODE = 'ERP14';
    END IF;
  END IF;
  IF NEW.subcontract_id IS NOT NULL THEN
    SELECT s.project_id INTO sp FROM subcontracts s WHERE s.id = NEW.subcontract_id AND s.company_id = NEW.company_id;
    IF NEW.project_id IS NOT NULL AND sp IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'Sözleşme seçilen projeye ait değil' USING ERRCODE = 'ERP14';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER bank_guarantees_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bank_guarantees
  FOR EACH ROW EXECUTE FUNCTION bank_guarantees_guard();
