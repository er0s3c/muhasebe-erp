-- Şube kapsamı erişim verme yollarında da korunur; şirket geneli güvenlik sorguları
-- etkin şube filtresini aşarken yalnızca oturumun şirketini okuyabilir.
ALTER FUNCTION app_branch_has_access(uuid,uuid) SET search_path=pg_catalog,public,pg_temp;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION company_has_finalized_records(p_company uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app_user_id() IS NOT NULL AND p_company IS DISTINCT FROM app_company_id() THEN RAISE EXCEPTION 'Şirket kapsamı dışında geçmiş sorgulanamaz' USING ERRCODE='ERP26'; END IF;
 RETURN EXISTS(SELECT 1 FROM journal_entries WHERE company_id=p_company AND status='posted')
  OR EXISTS(SELECT 1 FROM invoices WHERE company_id=p_company AND status<>'draft')
  OR EXISTS(SELECT 1 FROM payroll_runs WHERE company_id=p_company AND status<>'draft')
  OR EXISTS(SELECT 1 FROM social_declarations WHERE company_id=p_company AND status='finalized');
END $$;
REVOKE ALL ON FUNCTION company_has_finalized_records(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION company_has_finalized_records(uuid) TO erp_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION document_tax_rule_last_used_date(p_company uuid,p_rule uuid) RETURNS date
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app_user_id() IS NOT NULL AND p_company IS DISTINCT FROM app_company_id() THEN RAISE EXCEPTION 'Şirket kapsamı dışında vergi kuralı sorgulanamaz' USING ERRCODE='ERP26'; END IF;
 RETURN (SELECT max(i.invoice_date) FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id AND i.company_id=l.company_id WHERE l.company_id=p_company AND l.tax_rule_id=p_rule AND i.status<>'draft');
END $$;
REVOKE ALL ON FUNCTION document_tax_rule_last_used_date(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION document_tax_rule_last_used_date(uuid,uuid) TO erp_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION membership_scope_role_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r company_roles%ROWTYPE; caller memberships%ROWTYPE; scope_change boolean; role_change boolean;
BEGIN
 IF NEW.role='owner' AND (NEW.branch_scope_mode<>'all' OR NOT NEW.branch_allow_unassigned) THEN RAISE EXCEPTION 'Şirket sahibinin şube erişimi kısıtlanamaz' USING ERRCODE='ERP26'; END IF;
 IF NEW.custom_role_id IS NOT NULL THEN
  SELECT * INTO r FROM company_roles WHERE id=NEW.custom_role_id AND company_id=NEW.company_id;
  IF NOT FOUND OR NOT r.is_active OR r.base_role<>NEW.role OR NEW.role IN ('owner','admin') THEN RAISE EXCEPTION 'Üyelik özel rolü geçersiz veya pasif' USING ERRCODE='ERP26'; END IF;
 END IF;
 IF app_user_id() IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO caller FROM memberships WHERE company_id=NEW.company_id AND user_id=app_user_id();
 -- İlk şirketin ilk sahibi mevcut üyelik RLS kuralıyla oluşturulur.
 IF NOT FOUND THEN RETURN NEW; END IF;
 scope_change:=TG_OP='INSERT'; role_change:=TG_OP='INSERT';
 IF TG_OP='UPDATE' THEN
  scope_change:=(NEW.branch_scope_mode,NEW.branch_allow_unassigned) IS DISTINCT FROM (OLD.branch_scope_mode,OLD.branch_allow_unassigned);
  role_change:=(NEW.role,NEW.custom_role_id) IS DISTINCT FROM (OLD.role,OLD.custom_role_id);
 END IF;
 IF (scope_change OR role_change) AND caller.role NOT IN ('owner','admin') THEN RAISE EXCEPTION 'Üyelik yönetimi yönetici yetkisi ister' USING ERRCODE='ERP26'; END IF;
 IF caller.branch_scope_mode='restricted' AND (scope_change OR role_change) THEN
  IF NEW.branch_scope_mode='all' OR (NEW.branch_allow_unassigned AND NOT caller.branch_allow_unassigned) THEN RAISE EXCEPTION 'Kendi şube kapsamınızdan fazlasını veremezsiniz' USING ERRCODE='ERP26'; END IF;
  IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM member_branch_access a WHERE a.company_id=NEW.company_id AND a.user_id=NEW.user_id AND NOT EXISTS(SELECT 1 FROM member_branch_access own WHERE own.company_id=a.company_id AND own.user_id=caller.user_id AND own.branch_id=a.branch_id)) THEN RAISE EXCEPTION 'Erişim kapsamı dışındaki üyenin yetkisi değiştirilemez' USING ERRCODE='ERP26'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION branch_admin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE caller memberships%ROWTYPE;
BEGIN
 SELECT * INTO caller FROM memberships WHERE company_id=coalesce(NEW.company_id,OLD.company_id) AND user_id=app_user_id();
 IF app_user_id() IS NOT NULL AND (NOT FOUND OR caller.role NOT IN ('owner','admin')) THEN RAISE EXCEPTION 'Şube ve rol yönetimi yönetici yetkisi ister' USING ERRCODE='ERP26'; END IF;
 IF TG_TABLE_NAME IN ('company_branches','company_roles') AND app_user_id() IS NOT NULL AND caller.branch_scope_mode<>'all' THEN RAISE EXCEPTION 'Şirket şube ve rol yönetimi tüm şubelere erişim ister' USING ERRCODE='ERP26'; END IF;
 IF TG_TABLE_NAME='member_branch_access' THEN
  IF TG_OP='INSERT' AND app_user_id() IS NOT NULL AND NOT app_branch_has_access(NEW.company_id,NEW.branch_id) THEN RAISE EXCEPTION 'Kendi şube kapsamınızdan fazlasını veremezsiniz' USING ERRCODE='ERP26'; END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE FUNCTION member_module_access_branch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c memberships%ROWTYPE; target memberships%ROWTYPE; target_user uuid; target_company uuid;
BEGIN
 IF app_user_id() IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 IF TG_OP='DELETE' THEN target_user:=OLD.user_id; target_company:=OLD.company_id;
 ELSE target_user:=NEW.user_id; target_company:=NEW.company_id; END IF;
 SELECT * INTO c FROM memberships WHERE company_id=target_company AND user_id=app_user_id();
 IF NOT FOUND OR c.branch_scope_mode='all' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 SELECT * INTO target FROM memberships WHERE company_id=target_company AND user_id=target_user;
 -- Üyelik kaldırıldığında SECURITY DEFINER cleanup tetikleyicisi kalan istisnaları temizler.
 IF NOT FOUND AND TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF target.branch_scope_mode='all' OR (target.branch_allow_unassigned AND NOT c.branch_allow_unassigned)
  OR EXISTS(SELECT 1 FROM member_branch_access a WHERE a.company_id=target_company AND a.user_id=target_user AND NOT EXISTS(SELECT 1 FROM member_branch_access own WHERE own.company_id=a.company_id AND own.user_id=c.user_id AND own.branch_id=a.branch_id)) THEN
  RAISE EXCEPTION 'Erişim kapsamı dışındaki üyenin modül yetkisi değiştirilemez' USING ERRCODE='ERP26';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER member_module_access_branch_guard BEFORE INSERT OR UPDATE OR DELETE ON member_module_access FOR EACH ROW EXECUTE FUNCTION member_module_access_branch_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION member_module_access_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.role IS NOT DISTINCT FROM OLD.role AND NEW.custom_role_id IS NOT DISTINCT FROM OLD.custom_role_id THEN RETURN NULL; END IF;
 DELETE FROM public.member_module_access WHERE company_id=OLD.company_id AND user_id=OLD.user_id;
 RETURN NULL;
END $$;
DROP TRIGGER member_module_access_cleanup_role ON memberships;
CREATE TRIGGER member_module_access_cleanup_role AFTER UPDATE OF role,custom_role_id ON memberships FOR EACH ROW EXECUTE FUNCTION member_module_access_cleanup();
