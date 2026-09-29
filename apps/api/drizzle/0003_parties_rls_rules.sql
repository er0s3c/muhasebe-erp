-- =========================================================================
-- Cari (parties): RLS, yetki, denetim izi ve cari satır kuralları
-- =========================================================================
ALTER TABLE parties ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON parties
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON parties TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

CREATE TRIGGER audit_parties
  AFTER INSERT OR UPDATE OR DELETE ON parties
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint

-- Satır koruması: önceki kurallar + cari kuralları.
--  * Cari kontrol hesabı (accounts.party_control) satırında cari ZORUNLU,
--  * diğer hesaplarda cari ve vade tarihi YASAK.
CREATE OR REPLACE FUNCTION journal_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  s text;
  a accounts%ROWTYPE;
BEGIN
  SELECT status INTO s FROM journal_entries
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.entry_id ELSE NEW.entry_id END;
  -- Üst kayıt yoksa (taslak silinirken cascade) izin ver; posted ise engelle.
  IF FOUND AND s <> 'draft' THEN
    -- Tek istisna: kur sonradan girildiğinde BOŞ raporlama tutarları doldurulabilir.
    -- Defter (base) tutarlarına ve dolu raporlama tutarlarına dokunulamaz.
    IF TG_OP = 'UPDATE'
       AND OLD.debit_reporting IS NULL AND OLD.credit_reporting IS NULL
       AND (to_jsonb(NEW) - 'debit_reporting' - 'credit_reporting')
           = (to_jsonb(OLD) - 'debit_reporting' - 'credit_reporting') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Kaydedilmiş yevmiyenin satırları değiştirilemez' USING ERRCODE = 'ERP01';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.entry_id <> OLD.entry_id THEN
    RAISE EXCEPTION 'Satır başka yevmiyeye taşınamaz' USING ERRCODE = 'ERP01';
  END IF;

  SELECT * INTO a FROM accounts WHERE id = NEW.account_id AND company_id = NEW.company_id;
  IF NOT a.is_postable THEN
    RAISE EXCEPTION 'Hesaba kayıt atılamaz (alt hesapları var): %', a.code USING ERRCODE = 'ERP01';
  END IF;
  IF NOT a.is_active THEN
    RAISE EXCEPTION 'Pasif hesaba kayıt atılamaz: %', a.code USING ERRCODE = 'ERP01';
  END IF;
  IF a.currency_code IS NOT NULL AND a.currency_code <> NEW.currency_code THEN
    RAISE EXCEPTION 'Hesap % yalnızca % cinsinden hareket görür', a.code, a.currency_code
      USING ERRCODE = 'ERP01';
  END IF;

  IF a.party_control IS NOT NULL AND NEW.party_id IS NULL THEN
    RAISE EXCEPTION 'Cari hesaba (%) kayıt atarken cari seçilmeli', a.code USING ERRCODE = 'ERP01';
  END IF;
  IF a.party_control IS NULL AND NEW.party_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cari yalnızca cari kontrol hesaplarında kullanılabilir (%)', a.code
      USING ERRCODE = 'ERP01';
  END IF;
  IF NEW.due_date IS NOT NULL AND NEW.party_id IS NULL THEN
    RAISE EXCEPTION 'Vade tarihi yalnızca cari satırlarda kullanılabilir' USING ERRCODE = 'ERP01';
  END IF;
  RETURN NEW;
END
$$;
