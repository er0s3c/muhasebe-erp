-- =========================================================================
-- Altyapı fonları ve harçlar (Faz B4): tarife tablosu için RLS/yetki/denetim, hesap eşlemesi geri doldurma,
-- satış sözleşmesi koruması (fon/harç satırları bedele sayılmaz). Varsayılan 329 doğrulanmamıştır.
-- =========================================================================

INSERT INTO account_mappings (id, company_id, key, account_id)
SELECT gen_random_uuid(), c.id, 'fee_payable', a.id
FROM companies c
JOIN accounts a ON a.company_id = c.id AND a.code = '329'
ON CONFLICT (company_id, key) DO NOTHING;
--> statement-breakpoint

ALTER TABLE fee_schedules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON fee_schedules
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
CREATE TRIGGER audit_fee_schedules AFTER INSERT OR UPDATE OR DELETE ON fee_schedules
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON fee_schedules TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION sales_contracts_guard() RETURNS trigger LANGUAGE plpgsql AS
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
    SELECT count(*) FILTER (WHERE kind <> 'fee'), coalesce(sum(amount) FILTER (WHERE kind <> 'fee'), 0) INTO n, total
      FROM sales_installments WHERE contract_id = NEW.id;
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
