-- =========================================================================
-- İnsan kaynakları ve kişisel veri (Faz D1): RLS, yetki, denetim izi, iş kuralları (ERRCODE ERP13).
-- Personel silinmez (işten çıkış girilir); erişim günlüğü salt-eklenir (sahip rolü dahil değiştirilemez/silinemez).
-- =========================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employees', 'personal_data_inventory', 'data_subject_requests', 'personal_data_access_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())',
      t);
  END LOOP;
  -- Erişim günlüğünün kendisi için ayrıca denetim izi tutulmaz
  FOREACH t IN ARRAY ARRAY['employees', 'personal_data_inventory', 'data_subject_requests'] LOOP
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
    GRANT SELECT, INSERT, UPDATE ON employees, personal_data_inventory, data_subject_requests TO erp_app;
    GRANT SELECT, INSERT ON personal_data_access_log TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- Personel: silinmez; kod değişmez; işten ayrılmış personelin kimlik alanları değişmez
CREATE FUNCTION employees_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Personel kartı silinemez; işten çıkış tarihi girin' USING ERRCODE = 'ERP13';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'Personel aktif olarak açılır' USING ERRCODE = 'ERP13';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.code <> OLD.code OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'Personel kodu değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;
  IF OLD.status = 'left' AND NEW.status = 'left'
     AND (NEW.id_kind IS DISTINCT FROM OLD.id_kind OR NEW.id_enc IS DISTINCT FROM OLD.id_enc OR NEW.id_hash IS DISTINCT FROM OLD.id_hash
          OR NEW.birth_date_enc IS DISTINCT FROM OLD.birth_date_enc OR NEW.iban_enc IS DISTINCT FROM OLD.iban_enc) THEN
    RAISE EXCEPTION 'İşten ayrılmış personelin kimlik, doğum tarihi ve IBAN bilgisi değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;
  IF NEW.status = 'left' AND NEW.leave_date IS NULL THEN
    RAISE EXCEPTION 'İşten çıkış için çıkış tarihi gerekir' USING ERRCODE = 'ERP13';
  END IF;
  IF NEW.status = 'active' AND NEW.leave_date IS NOT NULL THEN
    RAISE EXCEPTION 'Aktif personelde çıkış tarihi olamaz' USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER employees_guard
  BEFORE INSERT OR UPDATE OR DELETE ON employees
  FOR EACH ROW EXECUTE FUNCTION employees_guard();
--> statement-breakpoint

-- Envanter: silinmez, anahtar/tablo/alan değişmez
CREATE FUNCTION personal_data_inventory_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Envanter kaydı silinemez' USING ERRCODE = 'ERP13';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.key <> OLD.key OR NEW.table_name <> OLD.table_name OR NEW.field_name <> OLD.field_name OR NEW.company_id <> OLD.company_id) THEN
    RAISE EXCEPTION 'Envanter anahtarı, tablo ve alan değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER personal_data_inventory_guard
  BEFORE INSERT OR UPDATE OR DELETE ON personal_data_inventory
  FOR EACH ROW EXECUTE FUNCTION personal_data_inventory_guard();
--> statement-breakpoint

-- İlgili kişi talebi: silinmez; açık → tamamlandı/reddedildi; sonuçlanmış talep değişmez
CREATE FUNCTION data_subject_requests_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'İlgili kişi talebi silinemez' USING ERRCODE = 'ERP13';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'Talep açık olarak oluşturulur' USING ERRCODE = 'ERP13';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'Sonuçlanmış talep değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;
  IF NEW.kind <> OLD.kind OR NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'Talebin türü ve kişisi değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER data_subject_requests_guard
  BEFORE INSERT OR UPDATE OR DELETE ON data_subject_requests
  FOR EACH ROW EXECUTE FUNCTION data_subject_requests_guard();
--> statement-breakpoint

-- Erişim günlüğü: yalnızca eklenir; kaydı yazan, oturumdaki kullanıcıdır (başkası adına yazılamaz)
CREATE FUNCTION personal_data_access_log_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  who text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Kişisel veri erişim günlüğü değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;
  IF who IS NOT NULL AND NEW.user_id::text <> who THEN
    RAISE EXCEPTION 'Erişim kaydı yalnızca oturumdaki kullanıcı adına yazılır' USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER personal_data_access_log_guard
  BEFORE INSERT OR UPDATE OR DELETE ON personal_data_access_log
  FOR EACH ROW EXECUTE FUNCTION personal_data_access_log_guard();
