-- =========================================================================
-- Rehber, ajanda ve görüşme notları (Faz X6): RLS, yetki, denetim izi ve iş kuralları (ERRCODE ERP21).
-- Rehber kişisi/kurumu/ajanda kalemi/görüşme notu silinmez (arşiv, iptal, birleştirme, anonimleştirme yolları vardır).
-- Görüşme notu görünürlüğü: kısıtlayıcı RLS politikası (özel not yalnızca yazarına görünür); kişi hakkındaki TÜM notlara
-- yalnızca tek amaçlı SECURITY DEFINER işlevleri (ilgili kişi dışa aktarması, birleştirme, anonimleştirme) erişir.
-- =========================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['directory_organizations', 'directory_contacts', 'directory_notes', 'agenda_items'] LOOP
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

-- Özel not yalnızca yazarına, paylaşılan not şirketteki herkese görünür (tenant_isolation ile birlikte VE'lenir)
CREATE POLICY note_visibility ON directory_notes AS RESTRICTIVE FOR SELECT
  USING (visibility = 'shared' OR author_id = app_user_id());
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON directory_organizations, directory_contacts, directory_notes, agenda_items TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- ---- Kurum ---------------------------------------------------------------------------------------------------------
CREATE FUNCTION directory_organizations_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Rehber kurumu silinemez; arşivleyin' USING ERRCODE = 'ERP21';
  END IF;
  IF NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'Kurumun şirketi değiştirilemez' USING ERRCODE = 'ERP21';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER directory_organizations_guard
  BEFORE UPDATE OR DELETE ON directory_organizations
  FOR EACH ROW EXECUTE FUNCTION directory_organizations_guard();
--> statement-breakpoint

-- ---- Kişi ----------------------------------------------------------------------------------------------------------
CREATE FUNCTION directory_contacts_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  op text := coalesce(current_setting('app.directory_op', true), '');
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
CREATE TRIGGER directory_contacts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON directory_contacts
  FOR EACH ROW EXECUTE FUNCTION directory_contacts_guard();
--> statement-breakpoint

-- ---- Görüşme notu ----------------------------------------------------------------------------------------------------
-- Yalnız eklenir. Düzenleme yalnızca yazarındır (geçmiş denetim izindedir); temizlenmiş (anonimleştirilmiş) not düzenlenmez;
-- kişi bağlantısı yalnızca birleştirme işleviyle, metin yalnızca anonimleştirme işleviyle değişir.
CREATE FUNCTION directory_notes_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  op text := coalesce(current_setting('app.directory_op', true), '');
  who text := nullif(current_setting('app.user_id', true), '');
  anon timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Görüşme notu silinemez' USING ERRCODE = 'ERP21';
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
CREATE TRIGGER directory_notes_guard
  BEFORE INSERT OR UPDATE OR DELETE ON directory_notes
  FOR EACH ROW EXECUTE FUNCTION directory_notes_guard();
--> statement-breakpoint

-- ---- Ajanda ----------------------------------------------------------------------------------------------------------
CREATE FUNCTION agenda_items_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Ajanda kalemi silinemez; iptal edin' USING ERRCODE = 'ERP21';
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Ajanda kaleminin şirketi ve oluşturanı değiştirilemez' USING ERRCODE = 'ERP21';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER agenda_items_guard
  BEFORE UPDATE OR DELETE ON agenda_items
  FOR EACH ROW EXECUTE FUNCTION agenda_items_guard();
--> statement-breakpoint

-- ---- İlgili kişi talebi: kişi (rehber) bağlantısı da değişmez ---------------------------------------------------------
CREATE OR REPLACE FUNCTION data_subject_requests_guard() RETURNS trigger LANGUAGE plpgsql AS
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
  IF NEW.kind <> OLD.kind OR NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'Talebin türü ve kişisi değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- ---- Tek amaçlı SECURITY DEFINER işlevleri (görünürlük politikasını yalnızca bu işlemler için aşar) ---------------------------
-- Çağıran şirket bağlamı app_company_id() ile doğrulanır; yetki denetimi uygulama katmanındadır.
CREATE FUNCTION directory_subject_notes(p_contact uuid) RETURNS SETOF directory_notes
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT n.* FROM directory_notes n
   WHERE n.contact_id = p_contact AND n.company_id = app_company_id()
   ORDER BY n.note_date, n.created_at
$$;
--> statement-breakpoint

CREATE FUNCTION directory_repoint_notes(p_from uuid, p_to uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM directory_contacts WHERE id = p_from AND company_id = app_company_id())
     OR NOT EXISTS (SELECT 1 FROM directory_contacts WHERE id = p_to AND company_id = app_company_id()) THEN
    RAISE EXCEPTION 'Kişi bulunamadı' USING ERRCODE = 'ERP21';
  END IF;
  PERFORM set_config('app.directory_op', 'merge', true);
  UPDATE directory_notes SET contact_id = p_to WHERE contact_id = p_from AND company_id = app_company_id();
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('app.directory_op', '', true);
  RETURN n;
END
$$;
--> statement-breakpoint

-- Anonimleştirme: ad/telefon/e-posta/adres yer tutucuya çevrilir, kişinin notlarının serbest metni temizlenir (kayıt yapısı kalır).
-- Cariye ya da personele bağlı kişi anonimleştirilemez (ilgili kayıtlar ticari/hukuki saklamaya tabidir).
CREATE FUNCTION directory_anonymize_contact(p_contact uuid, p_reason text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE
  c directory_contacts;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Anonimleştirme gerekçesi gerekli (en az 3 karakter)' USING ERRCODE = 'ERP21';
  END IF;
  SELECT * INTO c FROM directory_contacts WHERE id = p_contact AND company_id = app_company_id() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kişi bulunamadı' USING ERRCODE = 'ERP21';
  END IF;
  IF c.anonymized_at IS NOT NULL THEN
    RAISE EXCEPTION 'Kişi zaten anonimleştirilmiş' USING ERRCODE = 'ERP21';
  END IF;
  IF c.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'Birleştirilmiş kişi anonimleştirilmez; birleştirildiği kişiyi anonimleştirin' USING ERRCODE = 'ERP21';
  END IF;
  IF c.party_id IS NOT NULL OR c.employee_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cariye ya da personele bağlı rehber kişisi anonimleştirilemez; önce bağlantıyı kaldırın' USING ERRCODE = 'ERP21';
  END IF;
  PERFORM set_config('app.directory_op', 'anonymize', true);
  UPDATE directory_contacts
     SET full_name = 'Anonim kişi', title = NULL, organization_id = NULL, phone = NULL, phone2 = NULL, email = NULL, email2 = NULL,
         address = NULL, project_id = NULL, tags = '{}', note = NULL,
         is_archived = true, archived_at = coalesce(archived_at, now()),
         anonymized_at = now(), anonymized_by = app_user_id(), anonymize_reason = btrim(p_reason), updated_at = now()
   WHERE id = p_contact;
  UPDATE directory_notes SET summary = '[Anonimleştirildi]', cleared_at = now()
   WHERE contact_id = p_contact AND company_id = app_company_id() AND cleared_at IS NULL;
  UPDATE agenda_items SET title = '[Anonimleştirildi]', description = NULL, updated_at = now()
   WHERE contact_id = p_contact AND company_id = app_company_id();
  PERFORM set_config('app.directory_op', '', true);
END
$$;
