-- =========================================================================
-- Denetim düzeltmeleri 1: güvenlik ve veritabanı bütünlüğü (SEC-1…13, DB-2…8).
-- Yeni hata kodu: ERP24 (ayar/başvuru verisi kuralları: kullanılmış KDV oranı ve kur) → API'de 422 SETTINGS_RULE_VIOLATION.
-- =========================================================================

-- ---- SEC-4: denetim izi işlevi; arama yolu pg_temp sabitlenir, tüm adlar şema nitelikli ---------------------------------
-- (erp_app geçici bir `audit_log` tablosuyla gerçek tabloyu gölgeleyemez.)
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE
  rec jsonb;
  old_rec jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    rec := to_jsonb(OLD);
    old_rec := rec;
  ELSIF TG_OP = 'UPDATE' THEN
    rec := to_jsonb(NEW);
    old_rec := to_jsonb(OLD);
    IF rec = old_rec THEN
      RETURN NULL;
    END IF;
  ELSE
    rec := to_jsonb(NEW);
    old_rec := NULL;
  END IF;

  INSERT INTO public.audit_log (company_id, user_id, ip, table_name, row_id, action, old_data, new_data)
  VALUES (
    CASE WHEN TG_TABLE_NAME = 'companies' THEN (rec ->> 'id')::uuid
         ELSE nullif(rec ->> 'company_id', '')::uuid END,
    public.app_user_id(),
    nullif(pg_catalog.current_setting('app.ip', true), ''),
    TG_TABLE_NAME,
    rec ->> 'id',
    TG_OP,
    old_rec,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE rec END
  );
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- Ek savunma: uygulama geçici tablo kullanmaz; PUBLIC'in geçici tablo hakkı bu veritabanında kaldırılır
-- (veritabanı sahibi rolün kendi hakkı etkilenmez; geri yüklemede yeniden PUBLIC'e dönebilir, asıl koruma yukarıdaki arama yoludur).
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END
$$;
--> statement-breakpoint

-- ---- SEC-5: üyelik ve şirket satırları yalnızca şirket bağlamında değişir ---------------------------------------------
-- Şirketin henüz üyesi yok mu (ilk sahip üyeliği için)? Politika içinden aynı tabloyu sorgulamak özyineleme olacağından
-- yalnızca evet/hayır döndüren SECURITY DEFINER işlev.
CREATE OR REPLACE FUNCTION company_has_members(p_company uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT EXISTS (SELECT 1 FROM memberships WHERE company_id = p_company) $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION company_has_members(uuid) FROM PUBLIC;
--> statement-breakpoint
DROP POLICY membership_access ON memberships;
--> statement-breakpoint
CREATE POLICY membership_read ON memberships FOR SELECT
  USING (user_id = app_user_id() OR company_id = app_company_id());
--> statement-breakpoint
-- Ekleme: şirket bağlamında (yönetici üye ekler) ya da yeni kurulan, henüz üyesi olmayan şirkete kendini SAHİP olarak.
CREATE POLICY membership_insert ON memberships FOR INSERT
  WITH CHECK (
    company_id = app_company_id()
    OR (user_id = app_user_id() AND role = 'owner'
        AND EXISTS (SELECT 1 FROM companies c WHERE c.id = company_id)
        AND NOT company_has_members(company_id))
  );
--> statement-breakpoint
CREATE POLICY membership_update ON memberships FOR UPDATE
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
CREATE POLICY membership_delete ON memberships FOR DELETE
  USING (company_id = app_company_id());
--> statement-breakpoint
DROP POLICY org_isolation ON companies;
--> statement-breakpoint
CREATE POLICY company_read ON companies FOR SELECT USING (organization_id = app_org_id());
--> statement-breakpoint
CREATE POLICY company_insert ON companies FOR INSERT WITH CHECK (organization_id = app_org_id());
--> statement-breakpoint
CREATE POLICY company_update ON companies FOR UPDATE
  USING (id = app_company_id() AND organization_id = app_org_id())
  WITH CHECK (id = app_company_id() AND organization_id = app_org_id());
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    REVOKE DELETE ON companies FROM erp_app;
    GRANT EXECUTE ON FUNCTION company_has_members(uuid) TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- ---- DB-3: kuruluşlar kiracıya göre yalıtılır -----------------------------------------------------------------------
-- Kayıt akışı yeni kuruluşun kimliğini önce bağlama (app.org_id) yazar, sonra ekler.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organization_read ON organizations FOR SELECT USING (id = app_org_id());
--> statement-breakpoint
CREATE POLICY organization_insert ON organizations FOR INSERT WITH CHECK (id = app_org_id());
--> statement-breakpoint
CREATE POLICY organization_update ON organizations FOR UPDATE USING (id = app_org_id()) WITH CHECK (id = app_org_id());
--> statement-breakpoint

-- ---- SEC-1: kurulumun sahibi kuruluş -------------------------------------------------------------------------------
-- Sabitlenmişse license_state.owner_org_id, değilse en eski şirketin (yoksa en eski kuruluşun) kuruluşu.
CREATE OR REPLACE FUNCTION installation_owner_org() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT coalesce(
      (SELECT owner_org_id FROM license_state WHERE id = 1),
      (SELECT organization_id FROM companies ORDER BY created_at, id LIMIT 1),
      (SELECT id FROM organizations ORDER BY created_at, id LIMIT 1)
    )
  $$;
--> statement-breakpoint
-- Sahip kuruluş boşsa şimdiki değeri sabitler (ilk şirket kurulurken / lisans etkinleştirilirken çağrılır).
CREATE OR REPLACE FUNCTION claim_installation_owner() RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    UPDATE license_state SET owner_org_id = installation_owner_org(), updated_at = now()
     WHERE id = 1 AND owner_org_id IS NULL AND installation_owner_org() IS NOT NULL
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION installation_owner_org() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_installation_owner() FROM PUBLIC;
--> statement-breakpoint
-- Mevcut kurulumlar: en eski şirketin kuruluşu sahip olarak sabitlenir.
UPDATE license_state SET owner_org_id = installation_owner_org() WHERE id = 1 AND owner_org_id IS NULL;
--> statement-breakpoint
-- Lisans durumu kuralları + sahip kuruluş: uygulama hesabı boş alanı bir kez doldurabilir, sonra değiştiremez
-- (değiştirmek gerekirse şema sahibi rolle; docs/OPERATIONS.md).
CREATE OR REPLACE FUNCTION license_state_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Lisans durumu silinemez' USING ERRCODE = 'ERP08';
  END IF;
  IF NEW.installation_id <> OLD.installation_id OR NEW.public_key <> OLD.public_key OR NEW.private_key_pem <> OLD.private_key_pem THEN
    RAISE EXCEPTION 'Kurulum kimliği ve anahtarı değiştirilemez' USING ERRCODE = 'ERP08';
  END IF;
  IF NEW.high_water < OLD.high_water THEN
    RAISE EXCEPTION 'Saat işareti geri alınamaz' USING ERRCODE = 'ERP08';
  END IF;
  IF OLD.owner_org_id IS NOT NULL AND NEW.owner_org_id IS DISTINCT FROM OLD.owner_org_id
     AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = TG_RELID AND pg_has_role(current_user, c.relowner, 'MEMBER')) THEN
    RAISE EXCEPTION 'Kurulumun sahibi kuruluş değiştirilemez' USING ERRCODE = 'ERP08';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- ---- SEC-2: kullanıcı üzerinde yönetim yetkisi (MFA sıfırlama, mevcut kullanıcıyı şirkete bağlama) ----------------------
-- Çağıran, hedef kullanıcının üye olduğu HER şirkette sahip/yönetici ve en az onun rütbesinde olmalı (sahip > yönetici > diğer).
CREATE OR REPLACE FUNCTION can_manage_user(p_target uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT app_user_id() IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM memberships t
       WHERE t.user_id = p_target
         AND NOT EXISTS (
           SELECT 1 FROM memberships c
            WHERE c.company_id = t.company_id AND c.user_id = app_user_id() AND c.role IN ('owner', 'admin')
              AND (CASE c.role WHEN 'owner' THEN 3 ELSE 2 END)
                  >= (CASE t.role WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 ELSE 1 END)
         )
    )
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION can_manage_user(uuid) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT EXECUTE ON FUNCTION installation_owner_org() TO erp_app;
    GRANT EXECUTE ON FUNCTION claim_installation_owner() TO erp_app;
    GRANT EXECUTE ON FUNCTION can_manage_user(uuid) TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- ---- DB-2: kayıt ile dönem/mali yıl kapanışı yarışı ------------------------------------------------------------------
-- Koruyucular dönem (ve mali yıl) satırını FOR SHARE kilitler; kapanış yolları FOR UPDATE kilitler. Böylece kapanış,
-- kaydı süren işlemi bekler (ve sonra kaydı görür) ya da kayıt kapanmış dönemi görür ve reddedilir.
CREATE OR REPLACE FUNCTION journal_entries_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  p fiscal_periods%ROWTYPE;
  line_count int;
  sum_d numeric;
  sum_c numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Yevmiye önce taslak olarak oluşturulmalı' USING ERRCODE = 'ERP01';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION 'Kaydedilmiş yevmiye silinemez; ters kayıt oluşturun' USING ERRCODE = 'ERP01';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.status = 'posted' THEN
    -- Kaydedilmiş yevmiyede yalnızca reversed_by_id (boş -> dolu) değişebilir.
    IF NEW.status <> 'posted'
       OR OLD.reversed_by_id IS NOT NULL
       OR (to_jsonb(NEW) - 'reversed_by_id' - 'updated_at')
          IS DISTINCT FROM (to_jsonb(OLD) - 'reversed_by_id' - 'updated_at') THEN
      RAISE EXCEPTION 'Kaydedilmiş yevmiye değiştirilemez; ters kayıt oluşturun' USING ERRCODE = 'ERP01';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'posted' THEN
    SELECT * INTO p FROM fiscal_periods WHERE id = NEW.period_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR NEW.entry_date < p.start_date OR NEW.entry_date > p.end_date THEN
      RAISE EXCEPTION 'Yevmiye tarihi dönemiyle uyuşmuyor' USING ERRCODE = 'ERP01';
    END IF;
    IF p.status <> 'open' THEN
      RAISE EXCEPTION 'Dönem kapalı: %-%', p.year, lpad(p.month::text, 2, '0') USING ERRCODE = 'ERP01';
    END IF;

    SELECT count(*), coalesce(sum(debit_base), 0), coalesce(sum(credit_base), 0)
      INTO line_count, sum_d, sum_c
      FROM journal_lines WHERE entry_id = NEW.id;
    IF line_count < 2 THEN
      RAISE EXCEPTION 'Yevmiye en az iki satır içermeli' USING ERRCODE = 'ERP01';
    END IF;
    IF sum_d <> sum_c THEN
      RAISE EXCEPTION 'Yevmiye dengesiz: borç % <> alacak %', sum_d, sum_c USING ERRCODE = 'ERP01';
    END IF;
    IF sum_d = 0 THEN
      RAISE EXCEPTION 'Yevmiye tutarı sıfır olamaz' USING ERRCODE = 'ERP01';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stock_documents_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  p fiscal_periods%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO p FROM fiscal_periods WHERE id = NEW.period_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR NEW.doc_date < p.start_date OR NEW.doc_date > p.end_date THEN
      RAISE EXCEPTION 'Stok belgesi tarihi dönemiyle uyuşmuyor' USING ERRCODE = 'ERP02';
    END IF;
    IF p.status <> 'open' THEN
      RAISE EXCEPTION 'Dönem kapalı: %-%', p.year, lpad(p.month::text, 2, '0') USING ERRCODE = 'ERP02';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Stok belgesi silinemez; ters belge oluşturun' USING ERRCODE = 'ERP02';
  END IF;

  -- UPDATE: yalnızca reversed_by_id (boş -> dolu) değişebilir
  IF OLD.reversed_by_id IS NOT NULL
     OR (to_jsonb(NEW) - 'reversed_by_id') IS DISTINCT FROM (to_jsonb(OLD) - 'reversed_by_id') THEN
    RAISE EXCEPTION 'Stok belgesi değiştirilemez; ters belge oluşturun' USING ERRCODE = 'ERP02';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION journal_entries_year_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  st text;
BEGIN
  IF NEW.status = 'posted' AND (TG_OP = 'INSERT' OR OLD.status <> 'posted') THEN
    -- Tarihi kapsayan mali yıl satırı paylaşımlı kilitlenir: yıl kapanışı (FOR UPDATE) bu kaydın işlemini bekler.
    SELECT f.status INTO st FROM fiscal_years f
     WHERE f.company_id = NEW.company_id AND NEW.entry_date BETWEEN f.start_date AND f.end_date
     FOR SHARE;
    IF st = 'closed' THEN
      RAISE EXCEPTION 'Mali yıl kapalı (%): bu tarihe kayıt yapılamaz', NEW.entry_date USING ERRCODE = 'ERP23';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- ---- DB-5: kayıtlı belgenin seri no satırı silinemez ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION document_line_serials_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  st text;
  tracked boolean;
  r document_line_serials%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Satıra girilen seri no değiştirilemez; silip yeniden girin' USING ERRCODE = 'ERP17';
  END IF;
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF r.delivery_line_id IS NOT NULL THEN
    SELECT n.status, i.tracks_serial INTO st, tracked
      FROM delivery_note_lines l JOIN delivery_notes n ON n.id = l.note_id JOIN items i ON i.id = l.item_id
     WHERE l.id = r.delivery_line_id AND l.company_id = r.company_id;
  ELSE
    SELECT n.status, i.tracks_serial INTO st, tracked
      FROM invoice_lines l JOIN invoices n ON n.id = l.invoice_id JOIN items i ON i.id = l.item_id
     WHERE l.id = r.invoice_line_id AND l.company_id = r.company_id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Üst satır yoksa (taslak satır/belge silinirken zincirleme) ya da belge taslaksa silinebilir.
    IF FOUND AND st IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'Kaydedilmiş belgenin seri no kaydı silinemez' USING ERRCODE = 'ERP17';
    END IF;
    RETURN OLD;
  END IF;
  IF st IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Seri no yalnızca taslak belge satırına girilir' USING ERRCODE = 'ERP17';
  END IF;
  IF NOT coalesce(tracked, false) THEN
    RAISE EXCEPTION 'Satırın stok kartı seri takipli değil' USING ERRCODE = 'ERP17';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER document_line_serials_guard ON document_line_serials;
--> statement-breakpoint
CREATE TRIGGER document_line_serials_guard BEFORE INSERT OR UPDATE OR DELETE ON document_line_serials
  FOR EACH ROW EXECUTE FUNCTION document_line_serials_guard();
--> statement-breakpoint

-- ---- DB-7: gereksiz silme yetkileri ve "kullanılmış" korumaları ----------------------------------------------------------
-- Numara sayaçları ve hesap eşlemeleri uygulamada hiç silinmez (silinmesi numara tekrarına / kayıt atılamamasına yol açar).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    REVOKE DELETE ON document_sequences, account_mappings FROM erp_app;
  END IF;
END
$$;
--> statement-breakpoint
-- KDV oranı: kayıtlı (taslak olmayan) faturada kullanılmışsa silinemez; kodu/oranı/başlangıcı değişmez, bitişi yalnızca
-- kullanılmış faturaları dışarıda bırakmayacak şekilde değişir. Ad, doğrulama ve kaynak notu serbesttir.
CREATE OR REPLACE FUNCTION tax_rate_used(p_company uuid, p_code text, p_from date, p_to date) RETURNS boolean
  LANGUAGE sql STABLE AS
$$
  SELECT EXISTS (
    SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
     WHERE l.company_id = p_company AND l.vat_code = p_code AND i.status <> 'draft'
       AND i.invoice_date >= p_from AND (p_to IS NULL OR i.invoice_date <= p_to)
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION tax_rates_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NOT tax_rate_used(OLD.company_id, OLD.code, OLD.valid_from, OLD.valid_to) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Kayıtlı faturada kullanılmış KDV oranı silinemez; yeni tarihli oran ekleyin' USING ERRCODE = 'ERP24';
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.code <> OLD.code OR NEW.rate <> OLD.rate OR NEW.valid_from <> OLD.valid_from THEN
    RAISE EXCEPTION 'Kayıtlı faturada kullanılmış KDV oranının kodu, oranı ve başlangıç tarihi değiştirilemez' USING ERRCODE = 'ERP24';
  END IF;
  IF NEW.valid_to IS DISTINCT FROM OLD.valid_to AND NEW.valid_to IS NOT NULL
     AND tax_rate_used(OLD.company_id, OLD.code, NEW.valid_to + 1, OLD.valid_to) THEN
    RAISE EXCEPTION 'Bitiş tarihi, bu oranla kaydedilmiş faturaları dışarıda bırakamaz' USING ERRCODE = 'ERP24';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tax_rates_guard BEFORE UPDATE OR DELETE ON tax_rates
  FOR EACH ROW EXECUTE FUNCTION tax_rates_guard();
--> statement-breakpoint
-- Kur: tarihi kapalı döneme düşen ya da o gün o para biriminde kaydedilmiş yevmiyede kullanılmış kur değiştirilemez/silinemez
-- (aynı değerle yeniden içe aktarma serbesttir).
CREATE OR REPLACE FUNCTION exchange_rates_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.company_id = OLD.company_id AND NEW.rate_date = OLD.rate_date AND NEW.currency_code = OLD.currency_code
     AND NEW.quote_code = OLD.quote_code AND NEW.buy = OLD.buy AND NEW.sell = OLD.sell THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM fiscal_periods p
              WHERE p.company_id = OLD.company_id AND p.status = 'closed' AND OLD.rate_date BETWEEN p.start_date AND p.end_date) THEN
    RAISE EXCEPTION 'Kapalı döneme ait kur (%) değiştirilemez ve silinemez', OLD.rate_date USING ERRCODE = 'ERP24';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
              WHERE e.company_id = OLD.company_id AND e.status = 'posted' AND e.entry_date = OLD.rate_date
                AND l.currency_code IN (OLD.currency_code, OLD.quote_code) AND l.fx_rate <> 1) THEN
    RAISE EXCEPTION 'Bu tarihte kaydedilmiş dövizli yevmiyede kullanılmış kur (%) değiştirilemez ve silinemez', OLD.rate_date USING ERRCODE = 'ERP24';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER exchange_rates_guard BEFORE UPDATE OR DELETE ON exchange_rates
  FOR EACH ROW EXECUTE FUNCTION exchange_rates_guard();
--> statement-breakpoint
-- Ücret şartı / sosyal güvenlik profili: onaylanmış bordroda / kesinleşmiş bildirimde ay sonunda yürürlükte olduğu için
-- kullanılmışsa silinemez (yerine yeni tarihli şart/profil eklenir).
CREATE OR REPLACE FUNCTION employee_pay_terms_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  e employees%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM payroll_lines pl JOIN payroll_runs r ON r.id = pl.run_id
       WHERE pl.company_id = OLD.company_id AND pl.employee_id = OLD.employee_id AND r.status <> 'draft'
         AND OLD.effective_from <= ((r.month || '-01')::date + interval '1 month' - interval '1 day')::date
         AND NOT EXISTS (
           SELECT 1 FROM employee_pay_terms t
            WHERE t.employee_id = OLD.employee_id AND t.company_id = OLD.company_id AND t.id <> OLD.id
              AND t.effective_from > OLD.effective_from
              AND t.effective_from <= ((r.month || '-01')::date + interval '1 month' - interval '1 day')::date)
    ) THEN
      RAISE EXCEPTION 'Onaylanmış bordroda kullanılan ücret şartı silinemez; yeni tarihli şart ekleyin' USING ERRCODE = 'ERP13';
    END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO e FROM employees WHERE id = NEW.employee_id AND company_id = NEW.company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Personel bulunamadı' USING ERRCODE = 'ERP13';
  END IF;
  IF e.hire_date IS NOT NULL AND NEW.effective_from < e.hire_date THEN
    RAISE EXCEPTION '% personelinin ücret şartı işe giriş tarihinden (%) önce başlayamaz', e.code, e.hire_date USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER employee_pay_terms_guard ON employee_pay_terms;
--> statement-breakpoint
CREATE TRIGGER employee_pay_terms_guard
  BEFORE INSERT OR DELETE ON employee_pay_terms
  FOR EACH ROW EXECUTE FUNCTION employee_pay_terms_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION employee_social_profiles_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  e employees%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM social_declaration_lines dl JOIN social_declarations d ON d.id = dl.declaration_id
       WHERE dl.company_id = OLD.company_id AND dl.employee_id = OLD.employee_id AND d.status = 'finalized'
         AND OLD.effective_from <= ((d.month || '-01')::date + interval '1 month' - interval '1 day')::date
         AND NOT EXISTS (
           SELECT 1 FROM employee_social_profiles t
            WHERE t.employee_id = OLD.employee_id AND t.company_id = OLD.company_id AND t.id <> OLD.id
              AND t.effective_from > OLD.effective_from
              AND t.effective_from <= ((d.month || '-01')::date + interval '1 month' - interval '1 day')::date)
    ) THEN
      RAISE EXCEPTION 'Kesinleşmiş bildirimde kullanılan sosyal güvenlik profili silinemez; yeni tarihli profil ekleyin' USING ERRCODE = 'ERP13';
    END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO e FROM employees WHERE id = NEW.employee_id AND company_id = NEW.company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Personel bulunamadı' USING ERRCODE = 'ERP13';
  END IF;
  IF NEW.ssn_enc IS NOT NULL AND NEW.ssn_last4 IS NULL THEN
    RAISE EXCEPTION 'Şifreli numaranın maskeli son haneleri de yazılmalı' USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER employee_social_profiles_guard ON employee_social_profiles;
--> statement-breakpoint
CREATE TRIGGER employee_social_profiles_guard
  BEFORE INSERT OR DELETE ON employee_social_profiles
  FOR EACH ROW EXECUTE FUNCTION employee_social_profiles_guard();
--> statement-breakpoint

-- ---- DB-8: toplu faturalama sonucunun faturası (bileşik FK; fatura silinirse yalnız invoice_id boşalır) --------------------
CREATE OR REPLACE FUNCTION invoice_batch_items_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  -- Tek istisna: bağlı taslak fatura silindiğinde FK eylemi invoice_id'yi boşaltır (başka hiçbir alan değişmez).
  IF TG_OP = 'UPDATE' AND OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS NULL
     AND (to_jsonb(NEW) - 'invoice_id') = (to_jsonb(OLD) - 'invoice_id')
     AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = OLD.invoice_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Toplu faturalama sonuç kaydı değiştirilemez ve silinemez' USING ERRCODE = 'ERP15';
END
$$;
--> statement-breakpoint
UPDATE invoice_batch_items b SET invoice_id = NULL
 WHERE b.invoice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = b.invoice_id);
--> statement-breakpoint
ALTER TABLE invoice_batch_items ADD CONSTRAINT invoice_batch_items_invoice_fk
  FOREIGN KEY (invoice_id, company_id) REFERENCES invoices (id, company_id) ON DELETE SET NULL (invoice_id);
--> statement-breakpoint
CREATE INDEX invoice_batch_items_invoice_idx ON invoice_batch_items (invoice_id) WHERE invoice_id IS NOT NULL;
--> statement-breakpoint

-- ---- SEC-12: rehber koruyucuları işlem bayrağına (app.directory_op) yalnızca tanımlı işlevler içinden güvenir ---------------
-- Bayrak erp_app tarafından da yazılabildiği için, yalnızca tablo sahibi rolle (SECURITY DEFINER işlev içinde) çalışırken dikkate
-- alınır; oturumda kullanıcı yoksa (app.user_id boş) uygulama hesabı not yazamaz/düzenleyemez.
CREATE OR REPLACE FUNCTION directory_trusted_op(p_rel oid) RETURNS text LANGUAGE sql STABLE AS
$$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = p_rel AND pg_has_role(current_user, c.relowner, 'MEMBER'))
              THEN coalesce(current_setting('app.directory_op', true), '') ELSE '' END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION directory_contacts_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  op text := directory_trusted_op(TG_RELID);
  k text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Rehber kişisi silinemez; arşivleyin, birleştirin ya da anonimleştirin' USING ERRCODE = 'ERP21';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.anonymized_at IS NOT NULL OR NEW.merged_into_id IS NOT NULL OR NEW.is_archived THEN
      RAISE EXCEPTION 'Kişi etkin olarak oluşturulur' USING ERRCODE = 'ERP21';
    END IF;
  ELSE
    IF NEW.company_id <> OLD.company_id THEN
      RAISE EXCEPTION 'Kişinin şirketi değiştirilemez' USING ERRCODE = 'ERP21';
    END IF;
    IF OLD.anonymized_at IS NOT NULL THEN
      RAISE EXCEPTION 'Anonimleştirilmiş kişi değiştirilemez' USING ERRCODE = 'ERP21';
    END IF;
    IF OLD.merged_into_id IS NOT NULL THEN
      RAISE EXCEPTION 'Başka kişiyle birleştirilmiş kişi değiştirilemez' USING ERRCODE = 'ERP21';
    END IF;
    IF NEW.anonymized_at IS NOT NULL AND op <> 'anonymize' THEN
      RAISE EXCEPTION 'Kişi yalnızca anonimleştirme işleviyle anonimleştirilir' USING ERRCODE = 'ERP21';
    END IF;
    IF NEW.merged_into_id IS NOT NULL AND op <> 'merge' THEN
      RAISE EXCEPTION 'Kişi yalnızca birleştirme işleviyle birleştirilir' USING ERRCODE = 'ERP21';
    END IF;
  END IF;
  IF NEW.party_id IS NOT NULL THEN
    SELECT kind INTO k FROM parties WHERE id = NEW.party_id AND company_id = NEW.company_id;
    IF k = 'employee' THEN
      RAISE EXCEPTION 'Rehber kişisi personel carisine bağlanamaz; personel verisi personel kartındadır' USING ERRCODE = 'ERP21';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION directory_notes_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  op text := directory_trusted_op(TG_RELID);
  who text := nullif(current_setting('app.user_id', true), '');
  privileged boolean := EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = TG_RELID AND pg_has_role(current_user, c.relowner, 'MEMBER'));
  anon timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Görüşme notu silinemez' USING ERRCODE = 'ERP21';
  END IF;
  IF who IS NULL AND NOT privileged THEN
    RAISE EXCEPTION 'Görüşme notu yalnızca oturumdaki kullanıcı adına yazılır' USING ERRCODE = 'ERP21';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF who IS NOT NULL AND NEW.author_id::text <> who THEN
      RAISE EXCEPTION 'Görüşme notu yalnızca oturumdaki kullanıcı adına yazılır' USING ERRCODE = 'ERP21';
    END IF;
    IF NEW.cleared_at IS NOT NULL THEN
      RAISE EXCEPTION 'Not temizlenmiş olarak oluşturulamaz' USING ERRCODE = 'ERP21';
    END IF;
    IF NEW.contact_id IS NOT NULL THEN
      SELECT anonymized_at INTO anon FROM directory_contacts WHERE id = NEW.contact_id AND company_id = NEW.company_id AND merged_into_id IS NULL;
      IF NOT FOUND OR anon IS NOT NULL THEN
        RAISE EXCEPTION 'Anonimleştirilmiş ya da birleştirilmiş kişiye not yazılamaz' USING ERRCODE = 'ERP21';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.company_id <> OLD.company_id OR NEW.author_id <> OLD.author_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Notun şirketi, yazarı ve oluşturma zamanı değiştirilemez' USING ERRCODE = 'ERP21';
  END IF;
  IF op = 'merge' THEN
    IF NEW.summary <> OLD.summary OR NEW.kind <> OLD.kind OR NEW.note_date <> OLD.note_date OR NEW.visibility <> OLD.visibility
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
      RAISE EXCEPTION 'Birleştirme yalnızca notun kişi bağlantısını değiştirir' USING ERRCODE = 'ERP21';
    END IF;
    RETURN NEW;
  END IF;
  IF op = 'anonymize' THEN
    IF NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.kind <> OLD.kind
       OR NEW.note_date <> OLD.note_date OR NEW.visibility <> OLD.visibility OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
      RAISE EXCEPTION 'Anonimleştirme yalnızca not metnini temizler' USING ERRCODE = 'ERP21';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.cleared_at IS NOT NULL OR NEW.cleared_at IS DISTINCT FROM OLD.cleared_at THEN
    RAISE EXCEPTION 'Temizlenmiş not değiştirilemez' USING ERRCODE = 'ERP21';
  END IF;
  IF NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'Notun bağlı olduğu kişi/kurum değiştirilemez' USING ERRCODE = 'ERP21';
  END IF;
  IF who IS NOT NULL AND OLD.author_id::text <> who THEN
    RAISE EXCEPTION 'Notu yalnızca yazarı düzenleyebilir' USING ERRCODE = 'ERP21';
  END IF;
  IF NEW.summary <> OLD.summary OR NEW.kind <> OLD.kind OR NEW.note_date <> OLD.note_date OR NEW.visibility <> OLD.visibility THEN
    NEW.edited_at := now();
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- Birleştirmenin son adımı (kaynak kişiyi "birleştirildi" olarak işaretleme) artık bu işlevdedir; uygulama bayrağı kendisi yazamaz.
CREATE OR REPLACE FUNCTION directory_mark_merged(p_drop uuid, p_keep uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
BEGIN
  IF p_drop = p_keep
     OR NOT EXISTS (SELECT 1 FROM directory_contacts WHERE id = p_drop AND company_id = app_company_id())
     OR NOT EXISTS (SELECT 1 FROM directory_contacts WHERE id = p_keep AND company_id = app_company_id() AND merged_into_id IS NULL AND anonymized_at IS NULL) THEN
    RAISE EXCEPTION 'Kişi bulunamadı' USING ERRCODE = 'ERP21';
  END IF;
  PERFORM set_config('app.directory_op', 'merge', true);
  UPDATE directory_contacts
     SET is_archived = true, archived_at = now(), merged_into_id = p_keep, phone = NULL, phone2 = NULL, email = NULL, email2 = NULL,
         address = NULL, title = NULL, tags = '{}', note = NULL, updated_at = now()
   WHERE id = p_drop AND company_id = app_company_id();
  PERFORM set_config('app.directory_op', '', true);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION directory_mark_merged(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT EXECUTE ON FUNCTION directory_mark_merged(uuid, uuid) TO erp_app;
  END IF;
END
$$;
