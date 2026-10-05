-- =========================================================================
-- Kullanıcı bazlı modül erişimi: RLS, yetki, iş kuralları ve denetim (ERRCODE ERP26 -> API'de 422 MODULE_ACCESS_RULE_VIOLATION).
-- Okuma: üye yalnızca KENDİ satırlarını okur (etkin izin hesabı için); sahip/yönetici şirketin tüm satırlarını okur.
-- Yazma (ekle/değiştir/sil): yalnızca şirketin sahibi/yöneticisi. Koruyucu: kendi erişimini değiştirme yok, sahibin satırı olamaz,
-- yönetici üyenin satırını yalnızca sahip yazar, hedef şirketin üyesi olmalı, yazan kişi ve zaman sunucuda damgalanır.
-- Rol değişince ya da üyelik silinince üyenin istisnaları silinir (sürpriz yetki kalmasın).
-- =========================================================================

ALTER TABLE member_module_access ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY mma_read ON member_module_access FOR SELECT
  USING (
    company_id = app_company_id()
    AND (
      user_id = app_user_id()
      OR EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = app_company_id() AND m.user_id = app_user_id() AND m.role IN ('owner', 'admin'))
    )
  );
--> statement-breakpoint
CREATE POLICY mma_insert ON member_module_access FOR INSERT
  WITH CHECK (
    company_id = app_company_id()
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = app_company_id() AND m.user_id = app_user_id() AND m.role IN ('owner', 'admin'))
  );
--> statement-breakpoint
CREATE POLICY mma_update ON member_module_access FOR UPDATE
  USING (
    company_id = app_company_id()
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = app_company_id() AND m.user_id = app_user_id() AND m.role IN ('owner', 'admin'))
  )
  WITH CHECK (
    company_id = app_company_id()
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = app_company_id() AND m.user_id = app_user_id() AND m.role IN ('owner', 'admin'))
  );
--> statement-breakpoint
CREATE POLICY mma_delete ON member_module_access FOR DELETE
  USING (
    company_id = app_company_id()
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = app_company_id() AND m.user_id = app_user_id() AND m.role IN ('owner', 'admin'))
  );
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON member_module_access TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- ---- Koruyucu ----------------------------------------------------------------------------------------------------------
CREATE FUNCTION member_module_access_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  caller uuid := app_user_id();
  caller_role text;
  target_role text;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Modül erişimi yalnızca oturum açmış bir yönetici tarafından değiştirilir' USING ERRCODE = 'ERP26';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.company_id <> OLD.company_id OR NEW.user_id <> OLD.user_id OR NEW.module_key <> OLD.module_key) THEN
    RAISE EXCEPTION 'Erişim satırının şirketi, kullanıcısı ve modülü değiştirilemez' USING ERRCODE = 'ERP26';
  END IF;
  IF NEW.user_id = caller THEN
    RAISE EXCEPTION 'Kendi modül erişiminizi değiştiremezsiniz' USING ERRCODE = 'ERP26';
  END IF;
  SELECT m.role INTO caller_role FROM memberships m WHERE m.company_id = NEW.company_id AND m.user_id = caller;
  SELECT m.role INTO target_role FROM memberships m WHERE m.company_id = NEW.company_id AND m.user_id = NEW.user_id;
  IF target_role IS NULL THEN
    RAISE EXCEPTION 'Modül erişimi yalnızca şirketin üyesi için tanımlanır' USING ERRCODE = 'ERP26';
  END IF;
  IF target_role = 'owner' THEN
    RAISE EXCEPTION 'Sahibin erişimi kısıtlanamaz' USING ERRCODE = 'ERP26';
  END IF;
  IF target_role = 'admin' AND caller_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Yöneticinin modül erişimini yalnızca sahip değiştirebilir' USING ERRCODE = 'ERP26';
  END IF;
  -- Kim ne zaman verdi sunucuda damgalanır (istemci değeri yok sayılır)
  NEW.set_by := caller;
  NEW.set_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER member_module_access_guard
  BEFORE INSERT OR UPDATE ON member_module_access
  FOR EACH ROW EXECUTE FUNCTION member_module_access_guard();
--> statement-breakpoint

-- ---- Rol değişince / üyelik silinince istisnalar silinir ------------------------------------------------------------
-- SECURITY DEFINER: kendi üyeliğini silen yöneticinin satırları da temizlenir (aksi halde RLS "yönetici mi" denetimi geçmezdi).
-- Silme denetim izine yazılır (audit_row_change tetikleyicisi).
CREATE FUNCTION member_module_access_cleanup() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.role IS NOT DISTINCT FROM OLD.role THEN
    RETURN NULL;
  END IF;
  DELETE FROM public.member_module_access WHERE company_id = OLD.company_id AND user_id = OLD.user_id;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION member_module_access_cleanup() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER member_module_access_cleanup_role
  AFTER UPDATE OF role ON memberships
  FOR EACH ROW EXECUTE FUNCTION member_module_access_cleanup();
--> statement-breakpoint
CREATE TRIGGER member_module_access_cleanup_delete
  AFTER DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION member_module_access_cleanup();
--> statement-breakpoint

-- ---- Denetim izi ---------------------------------------------------------------------------------------------------
CREATE TRIGGER audit_member_module_access
  AFTER INSERT OR UPDATE OR DELETE ON member_module_access
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
