-- =========================================================================
-- Gayrimenkul satışı (Faz B3): RLS, yetki, denetim izi, hesap eşlemesi geri doldurma ve iş kuralları.
-- Kurallar ERRCODE ERP12 ile yükselir (API'de 422 REAL_ESTATE_RULE_VIOLATION).
-- Varsayılan eşleme kodları (380, 600, 679) genel Tekdüzen yapıya dayanır ve doğrulanmamıştır.
-- =========================================================================

INSERT INTO account_mappings (id, company_id, key, account_id)
SELECT gen_random_uuid(), c.id, m.key, a.id
FROM companies c
CROSS JOIN (VALUES
  ('deferred_revenue', '380'),
  ('property_revenue', '600'),
  ('termination_income', '679')
) AS m(key, code)
JOIN accounts a ON a.company_id = c.id AND a.code = m.code
ON CONFLICT (company_id, key) DO NOTHING;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['real_estate_units', 'sales_contracts', 'sales_installments', 'sales_terminations'] LOOP
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON real_estate_units, sales_installments TO erp_app;
    GRANT SELECT, INSERT, UPDATE ON sales_contracts, sales_terminations TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- 1) Birim
CREATE FUNCTION real_estate_units_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  pr projects%ROWTYPE;
  live text;
  ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'available' OR EXISTS (SELECT 1 FROM sales_contracts WHERE unit_id = OLD.id) THEN
      RAISE EXCEPTION 'Sözleşmesi olan birim silinemez' USING ERRCODE = 'ERP12';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR pr.kind <> 'own' THEN
      RAISE EXCEPTION 'Birim yalnızca kendi projesine (satış projesi) eklenir' USING ERRCODE = 'ERP12';
    END IF;
    IF pr.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'Tamamlanmış veya iptal edilmiş projeye birim eklenemez' USING ERRCODE = 'ERP12';
    END IF;
    IF NEW.status <> 'available' THEN
      RAISE EXCEPTION 'Birim satışa açık olarak eklenir' USING ERRCODE = 'ERP12';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.project_id <> OLD.project_id THEN
    RAISE EXCEPTION 'Birimin projesi değiştirilemez' USING ERRCODE = 'ERP12';
  END IF;
  IF NEW.status <> OLD.status THEN
    ok := (OLD.status = 'available' AND NEW.status IN ('reserved', 'sold'))
       OR (OLD.status = 'reserved' AND NEW.status IN ('available', 'sold'))
       OR (OLD.status = 'sold' AND NEW.status IN ('available', 'handed_over'));
    IF NOT ok THEN
      RAISE EXCEPTION 'Geçersiz birim durum geçişi (% → %)', OLD.status, NEW.status USING ERRCODE = 'ERP12';
    END IF;
    -- Durum, canlı sözleşmeyle tutarlı olmalıdır
    SELECT status INTO live FROM sales_contracts
     WHERE unit_id = NEW.id AND status IN ('draft', 'active', 'handed_over');
    IF NEW.status = 'available' AND live IS NOT NULL THEN
      RAISE EXCEPTION 'Canlı sözleşmesi olan birim satışa açılamaz' USING ERRCODE = 'ERP12';
    END IF;
    IF (NEW.status = 'reserved' AND live IS DISTINCT FROM 'draft')
       OR (NEW.status = 'sold' AND live IS DISTINCT FROM 'active')
       OR (NEW.status = 'handed_over' AND live IS DISTINCT FROM 'handed_over') THEN
      RAISE EXCEPTION 'Birim durumu sözleşme durumuyla uyuşmuyor' USING ERRCODE = 'ERP12';
    END IF;
  ELSIF OLD.status <> 'available' AND (NEW.block <> OLD.block OR NEW.unit_no <> OLD.unit_no) THEN
    RAISE EXCEPTION 'Sözleşmeye bağlı birimin blok ve numarası değiştirilemez' USING ERRCODE = 'ERP12';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER real_estate_units_guard
  BEFORE INSERT OR UPDATE OR DELETE ON real_estate_units
  FOR EACH ROW EXECUTE FUNCTION real_estate_units_guard();
--> statement-breakpoint

-- 2) Satış sözleşmesi
CREATE FUNCTION sales_contracts_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  pr projects%ROWTYPE;
  un real_estate_units%ROWTYPE;
  pk text;
  ok boolean;
  n int;
  total numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Satış sözleşmesi silinemez; iptal edilir' USING ERRCODE = 'ERP12';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Satış sözleşmesi taslak olarak açılır' USING ERRCODE = 'ERP12';
    END IF;
    SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR pr.kind <> 'own' OR pr.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'Satış sözleşmesi açık, kendi projesine ait birim için yapılır' USING ERRCODE = 'ERP12';
    END IF;
    SELECT * INTO un FROM real_estate_units WHERE id = NEW.unit_id AND company_id = NEW.company_id FOR UPDATE;
    IF NOT FOUND OR un.status <> 'available' THEN
      RAISE EXCEPTION 'Birim satışa açık değil' USING ERRCODE = 'ERP12';
    END IF;
    SELECT kind INTO pk FROM parties WHERE id = NEW.party_id AND company_id = NEW.company_id;
    IF pk IS NULL OR pk = 'supplier' THEN
      RAISE EXCEPTION 'Alıcı müşteri türünde bir cari olmalı' USING ERRCODE = 'ERP12';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.code <> OLD.code OR NEW.unit_id <> OLD.unit_id OR NEW.project_id <> OLD.project_id
     OR NEW.party_id <> OLD.party_id OR NEW.currency_code <> OLD.currency_code THEN
    RAISE EXCEPTION 'Sözleşmenin kodu, birimi, alıcısı ve para birimi değiştirilemez' USING ERRCODE = 'ERP12';
  END IF;

  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'draft'
       AND (to_jsonb(NEW) - 'penalty_note') IS DISTINCT FROM (to_jsonb(OLD) - 'penalty_note') THEN
      RAISE EXCEPTION 'Taslak dışındaki sözleşme değiştirilemez' USING ERRCODE = 'ERP12';
    END IF;
    RETURN NEW;
  END IF;

  ok := (OLD.status = 'draft' AND NEW.status IN ('active', 'cancelled'))
     OR (OLD.status = 'active' AND NEW.status IN ('handed_over', 'terminated', 'cancelled'));
  IF NOT ok THEN
    RAISE EXCEPTION 'Geçersiz sözleşme durum geçişi (% → %)', OLD.status, NEW.status USING ERRCODE = 'ERP12';
  END IF;

  IF NEW.status = 'active' THEN
    SELECT count(*), coalesce(sum(amount), 0) INTO n, total FROM sales_installments WHERE contract_id = NEW.id;
    IF n = 0 THEN
      RAISE EXCEPTION 'Taksit planı olmayan sözleşme etkinleştirilemez' USING ERRCODE = 'ERP12';
    END IF;
    IF total <> NEW.price THEN
      RAISE EXCEPTION 'Taksit toplamı (%) sözleşme bedeline (%) eşit olmalı', total, NEW.price USING ERRCODE = 'ERP12';
    END IF;
    IF EXISTS (SELECT 1 FROM sales_installments WHERE contract_id = NEW.id AND journal_line_id IS NULL) THEN
      RAISE EXCEPTION 'Etkinleşmede her taksit bir cari kaleme bağlanmalı' USING ERRCODE = 'ERP12';
    END IF;
  END IF;

  IF NEW.status = 'terminated' AND NOT EXISTS (SELECT 1 FROM sales_terminations WHERE contract_id = NEW.id) THEN
    RAISE EXCEPTION 'Fesih kaydı olmadan sözleşme feshedilemez' USING ERRCODE = 'ERP12';
  END IF;

  IF NEW.status = 'cancelled' AND OLD.status = 'active' AND EXISTS (
       SELECT 1
         FROM sales_installments si
         JOIN party_allocations pa ON pa.charge_line_id = si.journal_line_id
         JOIN treasury_transactions t ON t.id = pa.transaction_id AND t.status = 'posted'
        WHERE si.contract_id = NEW.id) THEN
    RAISE EXCEPTION 'Tahsilatı olan sözleşme iptal edilemez; fesih kaydı açın' USING ERRCODE = 'ERP12';
  END IF;
  IF NEW.status = 'cancelled' AND NEW.cancel_reason IS NULL THEN
    RAISE EXCEPTION 'İptal nedeni gerekli' USING ERRCODE = 'ERP12';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER sales_contracts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON sales_contracts
  FOR EACH ROW EXECUTE FUNCTION sales_contracts_guard();
--> statement-breakpoint

-- 3) Taksit planı: yalnızca taslak sözleşmede düzenlenir
CREATE FUNCTION sales_installments_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  c sales_contracts%ROWTYPE;
  cid uuid;
BEGIN
  cid := CASE WHEN TG_OP = 'DELETE' THEN OLD.contract_id ELSE NEW.contract_id END;
  SELECT * INTO c FROM sales_contracts WHERE id = cid FOR SHARE;
  IF NOT FOUND OR c.status <> 'draft' THEN
    RAISE EXCEPTION 'Taksit planı yalnızca taslak sözleşmede değiştirilebilir' USING ERRCODE = 'ERP12';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.contract_id <> OLD.contract_id THEN
    RAISE EXCEPTION 'Taksidin sözleşmesi değiştirilemez' USING ERRCODE = 'ERP12';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
CREATE TRIGGER sales_installments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON sales_installments
  FOR EACH ROW EXECUTE FUNCTION sales_installments_guard();
--> statement-breakpoint

-- 4) Fesih kaydı: yalnızca etkin sözleşme için eklenir; iade hareketi sonradan bir kez bağlanır
CREATE FUNCTION sales_terminations_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  c sales_contracts%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Fesih kaydı silinemez' USING ERRCODE = 'ERP12';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO c FROM sales_contracts WHERE id = NEW.contract_id AND company_id = NEW.company_id FOR UPDATE;
    IF NOT FOUND OR c.status <> 'active' THEN
      RAISE EXCEPTION 'Yalnızca etkin sözleşme feshedilir (teslimden sonra fesih desteklenmez)' USING ERRCODE = 'ERP12';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'refund_transaction_id') IS DISTINCT FROM (to_jsonb(OLD) - 'refund_transaction_id')
     OR (OLD.refund_transaction_id IS NOT NULL AND NEW.refund_transaction_id IS DISTINCT FROM OLD.refund_transaction_id) THEN
    RAISE EXCEPTION 'Fesih kaydı değiştirilemez' USING ERRCODE = 'ERP12';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER sales_terminations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON sales_terminations
  FOR EACH ROW EXECUTE FUNCTION sales_terminations_guard();
