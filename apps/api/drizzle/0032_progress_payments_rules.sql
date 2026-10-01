-- =========================================================================
-- Taşeron hakedişi (Faz B2c): RLS, yetki, denetim izi, hesap eşlemesi geri doldurma, iş kuralları (ERRCODE ERP10).
-- Kaydedilmiş hakediş değişmez; düzeltme yalnızca ters kayıtla iptaldir.
-- =========================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['progress_payments', 'progress_payment_lines', 'progress_payment_deductions', 'subcontract_advances', 'retention_releases'] LOOP
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON progress_payments, progress_payment_lines, progress_payment_deductions TO erp_app;
    -- Avans ve teminat iadesi yalnızca eklenir
    GRANT SELECT, INSERT ON subcontract_advances, retention_releases TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- Mevcut şirketler için yeni hesap eşlemeleri (genel Tekdüzen yapıya dayanır, doğrulanmamıştır)
INSERT INTO account_mappings (id, company_id, key, account_id)
SELECT gen_random_uuid(), c.id, m.key, a.id
FROM companies c
CROSS JOIN (VALUES
  ('subcontract_cost', '740'),
  ('retention_payable', '326'),
  ('withholding_payable', '360'),
  ('subcontract_advance', '159')
) AS m(key, code)
JOIN accounts a ON a.company_id = c.id AND a.code = m.code
ON CONFLICT (company_id, key) DO NOTHING;
--> statement-breakpoint

-- 1) Hakediş başlığı
CREATE FUNCTION progress_payments_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  sc subcontracts%ROWTYPE;
  je journal_entries%ROWTYPE;
  bad int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Taslak dışındaki hakediş silinemez' USING ERRCODE = 'ERP10';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO sc FROM subcontracts WHERE id = NEW.subcontract_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR sc.status <> 'active' THEN
      RAISE EXCEPTION 'Hakediş yalnızca yürürlükteki sözleşmeye girilir' USING ERRCODE = 'ERP10';
    END IF;
    IF NEW.currency_code <> sc.currency_code THEN
      RAISE EXCEPTION 'Hakediş sözleşmenin para biriminde olmalı' USING ERRCODE = 'ERP10';
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Hakediş taslak olarak açılır' USING ERRCODE = 'ERP10';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.subcontract_id <> OLD.subcontract_id OR NEW.project_id <> OLD.project_id OR NEW.payment_no <> OLD.payment_no
     OR NEW.currency_code <> OLD.currency_code OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Hakedişin sözleşmesi, sırası ve para birimi değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;

  -- Taslak ↔ onayda: tutarlar serbest, kayıt alanları boş kalmalı
  IF OLD.status IN ('draft', 'submitted') AND NEW.status IN ('draft', 'submitted') THEN
    IF NEW.status = 'submitted' AND OLD.status = 'submitted' THEN
      RAISE EXCEPTION 'Onaydaki hakediş değiştirilemez; geri çekin' USING ERRCODE = 'ERP10';
    END IF;
    IF NEW.number IS NOT NULL OR NEW.entry_id IS NOT NULL OR NEW.fx_rate IS NOT NULL OR NEW.posted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Kayıt alanları yalnızca kaydetme anında yazılır' USING ERRCODE = 'ERP10';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'submitted' AND NEW.status = 'posted' THEN
    IF (to_jsonb(NEW) - 'status' - 'number' - 'entry_id' - 'fx_rate' - 'posted_at')
       IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'number' - 'entry_id' - 'fx_rate' - 'posted_at') THEN
      RAISE EXCEPTION 'Kaydetme anında hakediş tutarları değiştirilemez' USING ERRCODE = 'ERP10';
    END IF;
    SELECT * INTO je FROM journal_entries WHERE id = NEW.entry_id AND company_id = NEW.company_id;
    IF NOT FOUND OR je.status <> 'posted' OR je.source_type IS DISTINCT FROM 'progress_payment' OR je.source_id IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'Hakedişin yevmiyesi kaydedilmiş ve kaynağı bu hakediş olmalı' USING ERRCODE = 'ERP10';
    END IF;
    -- Taşeron cari satırı net tutara (hakediş para biriminde) eşit olmalı
    IF NOT EXISTS (
      SELECT 1 FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.entry_id = NEW.entry_id AND a.party_control = 'payable' AND jl.credit = NEW.net AND jl.currency_code = NEW.currency_code
    ) AND NEW.net > 0 THEN
      RAISE EXCEPTION 'Yevmiyedeki taşeron cari satırı net tutara eşit olmalı' USING ERRCODE = 'ERP10';
    END IF;
    -- Kümülatif miktar sözleşme miktarını aşamaz; önceki kümülatif, önceki kaydedilmiş hakedişlerin kümülatifidir
    SELECT count(*) INTO bad
      FROM progress_payment_lines l
      JOIN subcontract_revisions r ON r.subcontract_id = l.subcontract_id AND r.status = 'approved'
       AND r.revision_no = (SELECT max(r2.revision_no) FROM subcontract_revisions r2 WHERE r2.subcontract_id = l.subcontract_id AND r2.status = 'approved')
      JOIN subcontract_boq_lines b ON b.revision_id = r.id AND b.line_key = l.line_key
     WHERE l.payment_id = NEW.id AND l.cum_qty > b.quantity;
    IF bad > 0 THEN
      RAISE EXCEPTION 'Kümülatif miktar sözleşme miktarını aşamaz' USING ERRCODE = 'ERP10';
    END IF;
    SELECT count(*) INTO bad
      FROM progress_payment_lines l
     WHERE l.payment_id = NEW.id
       AND l.prev_qty <> coalesce((
         SELECT max(p.cum_qty) FROM progress_payment_lines p JOIN progress_payments pp ON pp.id = p.payment_id
          WHERE pp.subcontract_id = NEW.subcontract_id AND pp.status = 'posted' AND p.line_key = l.line_key), 0);
    IF bad > 0 THEN
      RAISE EXCEPTION 'Önceki kümülatif miktar değişmiş; hakediş yeniden hazırlanmalı' USING ERRCODE = 'ERP10';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status = 'cancelled' THEN
    IF (to_jsonb(NEW) - 'status' - 'cancelled_at' - 'cancel_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'cancelled_at' - 'cancel_reason') THEN
      RAISE EXCEPTION 'İptalde yalnızca iptal alanları yazılır' USING ERRCODE = 'ERP10';
    END IF;
    IF EXISTS (SELECT 1 FROM progress_payments p WHERE p.subcontract_id = NEW.subcontract_id AND p.status = 'posted' AND p.payment_no > NEW.payment_no) THEN
      RAISE EXCEPTION 'Yalnızca son kaydedilmiş hakediş iptal edilebilir' USING ERRCODE = 'ERP10';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = OLD.entry_id AND reversed_by_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Hakediş, yevmiyesi ters çevrilmeden iptal edilemez' USING ERRCODE = 'ERP10';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Geçersiz hakediş durum geçişi (% → %)', OLD.status, NEW.status USING ERRCODE = 'ERP10';
END
$$;
--> statement-breakpoint
CREATE TRIGGER progress_payments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON progress_payments
  FOR EACH ROW EXECUTE FUNCTION progress_payments_guard();
--> statement-breakpoint

-- 2) Hakediş satırı ve kesintisi: yalnızca taslak hakedişte (üst belge FOR SHARE kilitli: gönderme/kaydetme ile yarışır)
CREATE FUNCTION progress_payment_children_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  p progress_payments%ROWTYPE;
  pid uuid;
BEGIN
  pid := CASE WHEN TG_OP = 'DELETE' THEN OLD.payment_id ELSE NEW.payment_id END;
  SELECT * INTO p FROM progress_payments WHERE id = pid FOR SHARE;
  IF NOT FOUND THEN
    -- Üst belge yoksa (taslak silinirken cascade) izin ver
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF p.status <> 'draft' THEN
    RAISE EXCEPTION 'Yalnızca taslak hakedişin satırları eklenir, değiştirilir veya silinir' USING ERRCODE = 'ERP10';
  END IF;
  IF TG_OP <> 'DELETE' AND TG_TABLE_NAME = 'progress_payment_lines' THEN
    IF NEW.subcontract_id <> p.subcontract_id OR NEW.project_id <> p.project_id THEN
      RAISE EXCEPTION 'Satır hakedişin sözleşmesine ait olmalı' USING ERRCODE = 'ERP10';
    END IF;
    PERFORM project_wbs_require_leaf(NEW.wbs_id, NEW.project_id, false);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
CREATE TRIGGER progress_payment_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON progress_payment_lines
  FOR EACH ROW EXECUTE FUNCTION progress_payment_children_guard();
--> statement-breakpoint
CREATE TRIGGER progress_payment_deductions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON progress_payment_deductions
  FOR EACH ROW EXECUTE FUNCTION progress_payment_children_guard();
--> statement-breakpoint

-- 3) Avans: ödeme, kaydedilmiş "diğer ödeme" hareketi olmalı; yürürlükteki sözleşmeye
CREATE FUNCTION subcontract_advances_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  sc subcontracts%ROWTYPE;
  tx treasury_transactions%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Verilen avans kaydı değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;
  SELECT * INTO sc FROM subcontracts WHERE id = NEW.subcontract_id AND company_id = NEW.company_id FOR SHARE;
  IF NOT FOUND OR sc.status <> 'active' THEN
    RAISE EXCEPTION 'Avans yalnızca yürürlükteki sözleşmeye verilir' USING ERRCODE = 'ERP10';
  END IF;
  SELECT * INTO tx FROM treasury_transactions WHERE id = NEW.transaction_id AND company_id = NEW.company_id;
  IF NOT FOUND OR tx.status <> 'posted' OR tx.type <> 'other_payment' THEN
    RAISE EXCEPTION 'Avans, kaydedilmiş bir diğer ödeme hareketine bağlı olmalı' USING ERRCODE = 'ERP10';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER subcontract_advances_guard
  BEFORE INSERT OR UPDATE OR DELETE ON subcontract_advances
  FOR EACH ROW EXECUTE FUNCTION subcontract_advances_guard();
--> statement-breakpoint

-- 4) Teminat iadesi: kaynak yevmiyesi kaydedilmiş olmalı ve tutulan teminat bakiyesini aşamaz (sözleşme kilitli)
CREATE FUNCTION retention_releases_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  sc subcontracts%ROWTYPE;
  je journal_entries%ROWTYPE;
  held numeric;
  released numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Teminat iadesi kaydı değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;
  SELECT * INTO sc FROM subcontracts WHERE id = NEW.subcontract_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sözleşme bulunamadı' USING ERRCODE = 'ERP10';
  END IF;
  SELECT * INTO je FROM journal_entries WHERE id = NEW.entry_id AND company_id = NEW.company_id;
  IF NOT FOUND OR je.status <> 'posted' OR je.source_type IS DISTINCT FROM 'retention_release' THEN
    RAISE EXCEPTION 'Teminat iadesinin yevmiyesi kaydedilmiş ve kaynağı teminat iadesi olmalı' USING ERRCODE = 'ERP10';
  END IF;
  SELECT coalesce(sum(retention), 0) INTO held FROM progress_payments WHERE subcontract_id = NEW.subcontract_id AND status = 'posted';
  SELECT coalesce(sum(amount), 0) INTO released FROM retention_releases WHERE subcontract_id = NEW.subcontract_id;
  IF released + NEW.amount > held THEN
    RAISE EXCEPTION 'İade tutarı tutulan teminat bakiyesini aşamaz' USING ERRCODE = 'ERP10';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER retention_releases_guard
  BEFORE INSERT OR UPDATE OR DELETE ON retention_releases
  FOR EACH ROW EXECUTE FUNCTION retention_releases_guard();
