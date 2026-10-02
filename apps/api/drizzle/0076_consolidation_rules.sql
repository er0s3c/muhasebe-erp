-- =========================================================================
-- Çoklu şirket konsolidasyonu (Faz X7): RLS, yetki, denetim izi ve iş kuralları (ERRCODE ERP22).
-- Bu tablolar KULLANICIYA aittir (şirket değil): politika `owner_user_id = app_user_id()`. Şirket verisine hiçbir yeni yol, işlev
-- (SECURITY DEFINER yok) ya da geniş yetki eklenmez; şirket verisi uygulamada şirket şirket, o şirketin RLS bağlamıyla okunur.
-- =========================================================================

ALTER TABLE consolidation_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_only ON consolidation_groups
  USING (owner_user_id = app_user_id() AND organization_id = app_org_id())
  WITH CHECK (owner_user_id = app_user_id() AND organization_id = app_org_id());
--> statement-breakpoint

ALTER TABLE consolidation_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Üye satırı yalnızca grubun sahibine görünür; EKLEME ayrıca, sahibin o şirkette üyeliği olmasını ister (savunma derinliği).
CREATE POLICY group_owner_read ON consolidation_members FOR SELECT
  USING (EXISTS (SELECT 1 FROM consolidation_groups g WHERE g.id = group_id AND g.owner_user_id = app_user_id()));
--> statement-breakpoint
CREATE POLICY group_owner_delete ON consolidation_members FOR DELETE
  USING (EXISTS (SELECT 1 FROM consolidation_groups g WHERE g.id = group_id AND g.owner_user_id = app_user_id()));
--> statement-breakpoint
CREATE POLICY group_owner_insert ON consolidation_members FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM consolidation_groups g WHERE g.id = group_id AND g.owner_user_id = app_user_id())
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = member_company_id AND m.user_id = app_user_id())
  );
--> statement-breakpoint

ALTER TABLE consolidation_eliminations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY group_owner ON consolidation_eliminations
  USING (EXISTS (SELECT 1 FROM consolidation_groups g WHERE g.id = group_id AND g.owner_user_id = app_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM consolidation_groups g WHERE g.id = group_id AND g.owner_user_id = app_user_id()));
--> statement-breakpoint

ALTER TABLE consolidation_elimination_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY group_owner ON consolidation_elimination_lines
  USING (EXISTS (SELECT 1 FROM consolidation_groups g WHERE g.id = group_id AND g.owner_user_id = app_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM consolidation_groups g WHERE g.id = group_id AND g.owner_user_id = app_user_id()));
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['consolidation_groups', 'consolidation_members', 'consolidation_eliminations', 'consolidation_elimination_lines'] LOOP
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
    GRANT SELECT, INSERT, UPDATE ON consolidation_groups TO erp_app;
    GRANT SELECT, INSERT, DELETE ON consolidation_members TO erp_app;
    GRANT SELECT, INSERT, UPDATE ON consolidation_eliminations TO erp_app;
    GRANT SELECT, INSERT ON consolidation_elimination_lines TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- ---- Grup ------------------------------------------------------------------------------------------------------------
CREATE FUNCTION consolidation_groups_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Konsolidasyon grubu silinemez; arşivleyin' USING ERRCODE = 'ERP22';
  END IF;
  IF NEW.owner_user_id <> OLD.owner_user_id OR NEW.organization_id <> OLD.organization_id THEN
    RAISE EXCEPTION 'Grubun sahibi ve kuruluşu değiştirilemez' USING ERRCODE = 'ERP22';
  END IF;
  IF NEW.reporting_currency <> OLD.reporting_currency THEN
    RAISE EXCEPTION 'Grubun rapor para birimi sonradan değiştirilemez (eliminasyon tutarları bu para birimindedir)' USING ERRCODE = 'ERP22';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER consolidation_groups_guard
  BEFORE UPDATE OR DELETE ON consolidation_groups
  FOR EACH ROW EXECUTE FUNCTION consolidation_groups_guard();
--> statement-breakpoint

-- ---- Üye ---------------------------------------------------------------------------------------------------------------
-- Ekleme: sahibin o şirkette üyeliği olmalı, şirket grupla aynı kuruluşta olmalı, grup arşivli olmamalı. Güncelleme yok.
CREATE FUNCTION consolidation_members_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  g consolidation_groups%ROWTYPE;
  c_org uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Grup üyesi güncellenemez; çıkarıp yeniden ekleyin' USING ERRCODE = 'ERP22';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  SELECT * INTO g FROM consolidation_groups WHERE id = NEW.group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Grup bulunamadı' USING ERRCODE = 'ERP22';
  END IF;
  IF g.is_archived THEN
    RAISE EXCEPTION 'Arşivlenmiş gruba şirket eklenemez' USING ERRCODE = 'ERP22';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE company_id = NEW.member_company_id AND user_id = g.owner_user_id) THEN
    RAISE EXCEPTION 'Grubun sahibi bu şirketin üyesi değil' USING ERRCODE = 'ERP22';
  END IF;
  SELECT organization_id INTO c_org FROM companies WHERE id = NEW.member_company_id;
  IF c_org IS NULL OR c_org <> g.organization_id THEN
    RAISE EXCEPTION 'Şirket grubun kuruluşunda değil' USING ERRCODE = 'ERP22';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER consolidation_members_guard
  BEFORE INSERT OR UPDATE OR DELETE ON consolidation_members
  FOR EACH ROW EXECUTE FUNCTION consolidation_members_guard();
--> statement-breakpoint

-- ---- Eliminasyon başlığı -------------------------------------------------------------------------------------------------
-- Salt eklenir: silinmez; güncelleme yalnızca iptal bilgisini (voided_*) bir kez yazar.
CREATE FUNCTION consolidation_eliminations_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  g consolidation_groups%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Eliminasyon kaydı silinemez; gerekçeyle iptal edin' USING ERRCODE = 'ERP22';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO g FROM consolidation_groups WHERE id = NEW.group_id;
    IF NOT FOUND OR g.is_archived THEN
      RAISE EXCEPTION 'Arşivlenmiş gruba eliminasyon girilemez' USING ERRCODE = 'ERP22';
    END IF;
    IF NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'Eliminasyon iptal edilmiş olarak oluşturulamaz' USING ERRCODE = 'ERP22';
    END IF;
    IF NEW.created_by <> app_user_id() THEN
      RAISE EXCEPTION 'Eliminasyon yalnızca oturumdaki kullanıcı adına girilir' USING ERRCODE = 'ERP22';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'İptal edilmiş eliminasyon değiştirilemez' USING ERRCODE = 'ERP22';
  END IF;
  IF NEW.voided_at IS NULL OR NEW.voided_by IS NULL OR NEW.void_reason IS NULL OR length(btrim(NEW.void_reason)) < 3 THEN
    RAISE EXCEPTION 'Eliminasyon yalnızca gerekçeli iptal ile değişir' USING ERRCODE = 'ERP22';
  END IF;
  IF NEW.voided_by <> app_user_id() THEN
    RAISE EXCEPTION 'İptal yalnızca oturumdaki kullanıcı adına yazılır' USING ERRCODE = 'ERP22';
  END IF;
  IF NEW.group_id <> OLD.group_id OR NEW.period_from <> OLD.period_from OR NEW.period_to <> OLD.period_to OR NEW.kind <> OLD.kind
     OR NEW.description <> OLD.description OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Eliminasyon içeriği değiştirilemez' USING ERRCODE = 'ERP22';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER consolidation_eliminations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON consolidation_eliminations
  FOR EACH ROW EXECUTE FUNCTION consolidation_eliminations_guard();
--> statement-breakpoint

-- İşlem sonunda (ertelenmiş): her eliminasyonun en az iki satırı olmalı ve borç = alacak
CREATE FUNCTION consolidation_eliminations_balanced() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  n int;
  d numeric;
  c numeric;
BEGIN
  SELECT count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0) INTO n, d, c
    FROM consolidation_elimination_lines WHERE elimination_id = NEW.id;
  IF n < 2 THEN
    RAISE EXCEPTION 'Eliminasyonda en az iki satır olmalı' USING ERRCODE = 'ERP22';
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'Eliminasyon dengesiz: borç % <> alacak %', d, c USING ERRCODE = 'ERP22';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER consolidation_eliminations_balanced
  AFTER INSERT ON consolidation_eliminations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION consolidation_eliminations_balanced();
--> statement-breakpoint

-- ---- Eliminasyon satırı ------------------------------------------------------------------------------------------------
CREATE FUNCTION consolidation_elimination_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  h consolidation_eliminations%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Eliminasyon satırı değiştirilemez ya da silinemez' USING ERRCODE = 'ERP22';
  END IF;
  SELECT * INTO h FROM consolidation_eliminations WHERE id = NEW.elimination_id;
  IF NOT FOUND OR h.group_id <> NEW.group_id THEN
    RAISE EXCEPTION 'Eliminasyon satırı başlığın grubuna ait olmalı' USING ERRCODE = 'ERP22';
  END IF;
  IF h.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'İptal edilmiş eliminasyona satır eklenemez' USING ERRCODE = 'ERP22';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER consolidation_elimination_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON consolidation_elimination_lines
  FOR EACH ROW EXECUTE FUNCTION consolidation_elimination_lines_guard();
