-- =========================================================================
-- Yabancı işçi belge ve teminat takibi (Faz D5): RLS, yetki, denetim izi, iş kuralları (ERRCODE ERP13 → HR_RULE_VIOLATION).
-- Belge tarihleri/numarası yalnızca yenileme (salt-eklenir geçmiş) ile değişir; teminat tutarı kayıt tarihinde geçerli, açık ve en yeni
-- kullanıcı parametresinden anlık görüntüdür. Yasal süre, tutar, ücret ve makam bilgisi DOĞRULANMAMIŞTIR ve kodda/tohumda yoktur.
-- =========================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['foreign_doc_types', 'foreign_worker_docs', 'foreign_doc_renewals', 'foreign_worker_params', 'foreign_worker_guarantees'] LOOP
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
    GRANT SELECT, INSERT, UPDATE ON foreign_doc_types TO erp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON foreign_worker_docs, foreign_worker_params, foreign_worker_guarantees TO erp_app;
    GRANT SELECT, INSERT ON foreign_doc_renewals TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- Belge türü: silinmez (pasifleştirilir); kod değişmez
CREATE FUNCTION foreign_doc_types_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Belge türü silinemez; pasifleştirin' USING ERRCODE = 'ERP13';
  END IF;
  IF NEW.code <> OLD.code OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'Belge türünün kodu değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER foreign_doc_types_guard
  BEFORE UPDATE OR DELETE ON foreign_doc_types
  FOR EACH ROW EXECUTE FUNCTION foreign_doc_types_guard();
--> statement-breakpoint

-- Yenileme geçmişi: salt-eklenir (sahip rolü dahil değiştirilemez/silinemez)
CREATE FUNCTION foreign_doc_renewals_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Belge yenileme geçmişi değiştirilemez ya da silinemez' USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER foreign_doc_renewals_guard
  BEFORE INSERT OR UPDATE OR DELETE ON foreign_doc_renewals
  FOR EACH ROW EXECUTE FUNCTION foreign_doc_renewals_guard();
--> statement-breakpoint

-- Belge: tarih/numara yalnızca aynı işlemde yazılmış bir yenileme satırıyla değişir; iptal gerekçe + oturum kullanıcısı ister ve geri alınmaz
CREATE FUNCTION foreign_worker_docs_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  who text := nullif(current_setting('app.user_id', true), '');
  t foreign_doc_types%ROWTYPE;
  changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.renewal_count > 0 OR OLD.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Yenilenmiş ya da iptal edilmiş belge silinemez' USING ERRCODE = 'ERP13';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO t FROM foreign_doc_types WHERE id = NEW.type_id AND company_id = NEW.company_id;
    IF NOT FOUND OR NOT t.active THEN
      RAISE EXCEPTION 'Belge türü bulunamadı ya da pasif' USING ERRCODE = 'ERP13';
    END IF;
    IF NEW.number_enc IS NOT NULL AND NEW.number_last4 IS NULL THEN
      RAISE EXCEPTION 'Şifreli numaranın maskeli son haneleri de yazılmalı' USING ERRCODE = 'ERP13';
    END IF;
    IF NEW.renewal_count <> 0 OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Belge yenilenmemiş ve iptal edilmemiş olarak açılır' USING ERRCODE = 'ERP13';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.company_id <> OLD.company_id OR NEW.employee_id <> OLD.employee_id OR NEW.type_id <> OLD.type_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Belgenin personeli ve türü değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason
     OR NEW.expiry_date IS DISTINCT FROM OLD.expiry_date OR NEW.issue_date IS DISTINCT FROM OLD.issue_date OR NEW.number_enc IS DISTINCT FROM OLD.number_enc) THEN
    RAISE EXCEPTION 'İptal edilmiş belge değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    IF NEW.revoke_reason IS NULL OR length(btrim(NEW.revoke_reason)) < 3 OR NEW.revoked_by IS NULL THEN
      RAISE EXCEPTION 'Belge iptali gerekçe ve kullanıcı ister' USING ERRCODE = 'ERP13';
    END IF;
    IF who IS NOT NULL AND NEW.revoked_by::text <> who THEN
      RAISE EXCEPTION 'İptal yalnızca oturumdaki kullanıcı adına yazılır' USING ERRCODE = 'ERP13';
    END IF;
  END IF;

  changed := NEW.issue_date IS DISTINCT FROM OLD.issue_date OR NEW.expiry_date IS DISTINCT FROM OLD.expiry_date
             OR NEW.number_enc IS DISTINCT FROM OLD.number_enc OR NEW.number_last4 IS DISTINCT FROM OLD.number_last4;
  IF NEW.number_enc IS NOT NULL AND NEW.number_last4 IS NULL THEN
    RAISE EXCEPTION 'Şifreli numaranın maskeli son haneleri de yazılmalı' USING ERRCODE = 'ERP13';
  END IF;
  IF NEW.renewal_count <> OLD.renewal_count THEN
    IF NEW.renewal_count <> OLD.renewal_count + 1 OR NOT changed THEN
      RAISE EXCEPTION 'Yenileme sayacı bir artmalı ve belge bilgisi değişmeli' USING ERRCODE = 'ERP13';
    END IF;
    IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'İptal edilmiş belge yenilenemez' USING ERRCODE = 'ERP13';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM foreign_doc_renewals r WHERE r.doc_id = NEW.id AND r.company_id = NEW.company_id AND r.renewed_at = now()
                   AND r.prev_expiry_date IS NOT DISTINCT FROM OLD.expiry_date AND r.new_expiry_date IS NOT DISTINCT FROM NEW.expiry_date
                   AND r.prev_issue_date IS NOT DISTINCT FROM OLD.issue_date AND r.new_issue_date IS NOT DISTINCT FROM NEW.issue_date) THEN
      RAISE EXCEPTION 'Belge tarihleri yenileme geçmişi satırı olmadan değiştirilemez' USING ERRCODE = 'ERP13';
    END IF;
  ELSIF changed THEN
    RAISE EXCEPTION 'Belge tarihleri ve numarası yalnızca yenileme ile değişir' USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER foreign_worker_docs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON foreign_worker_docs
  FOR EACH ROW EXECUTE FUNCTION foreign_worker_docs_guard();
--> statement-breakpoint

-- Parametre: anahtar, değer, para birimi ve tarih sonradan değişmez (yeni tarihli satır eklenir); teminatta kullanılmış parametre silinmez
CREATE FUNCTION foreign_worker_params_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM foreign_worker_guarantees g WHERE g.param_id = OLD.id) THEN
      RAISE EXCEPTION 'Teminat kaydında kullanılan parametre silinemez' USING ERRCODE = 'ERP13';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.key <> OLD.key OR NEW.value <> OLD.value OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.effective_from <> OLD.effective_from THEN
    RAISE EXCEPTION 'Parametrenin anahtarı, değeri, para birimi ve tarihi değiştirilemez; yeni tarihli satır ekleyin' USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER foreign_worker_params_guard
  BEFORE UPDATE OR DELETE ON foreign_worker_params
  FOR EACH ROW EXECUTE FUNCTION foreign_worker_params_guard();
--> statement-breakpoint

-- Teminat: tutar/para birimi kayıt tarihinde geçerli, açık ve en yeni parametreden gelir; held -> refunded | forfeited (geri dönüşsüz)
CREATE FUNCTION foreign_worker_guarantees_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  p foreign_worker_params%ROWTYPE;
  d_emp uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'held' THEN
      RAISE EXCEPTION 'Sonuçlanmış (iade/irat) teminat kaydı silinemez' USING ERRCODE = 'ERP13';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'held' OR NEW.resolved_date IS NOT NULL THEN
      RAISE EXCEPTION 'Teminat "tutuluyor" olarak açılır' USING ERRCODE = 'ERP13';
    END IF;
    SELECT * INTO p FROM foreign_worker_params WHERE id = NEW.param_id AND company_id = NEW.company_id;
    IF NOT FOUND OR p.key <> 'guarantee_amount' THEN
      RAISE EXCEPTION 'Teminat tutarı parametresi bulunamadı' USING ERRCODE = 'ERP13';
    END IF;
    IF NOT p.enabled OR p.effective_from > NEW.deposited_date
       OR EXISTS (SELECT 1 FROM foreign_worker_params q WHERE q.company_id = p.company_id AND q.key = p.key AND q.effective_from > p.effective_from AND q.effective_from <= NEW.deposited_date) THEN
      RAISE EXCEPTION 'Yatırma tarihinde geçerli, açık ve en yeni teminat parametresi yok' USING ERRCODE = 'ERP13';
    END IF;
    IF NEW.amount <> p.value OR NEW.currency <> p.currency THEN
      RAISE EXCEPTION 'Teminat tutarı ve para birimi parametreden gelmelidir' USING ERRCODE = 'ERP13';
    END IF;
    IF NEW.param_verified <> (p.verified_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Parametre doğrulama anlık görüntüsü tutarsız' USING ERRCODE = 'ERP13';
    END IF;
    IF NEW.doc_id IS NOT NULL THEN
      SELECT employee_id INTO d_emp FROM foreign_worker_docs WHERE id = NEW.doc_id AND company_id = NEW.company_id;
      IF d_emp IS NULL OR d_emp <> NEW.employee_id THEN
        RAISE EXCEPTION 'Bağlı belge aynı personele ait olmalı' USING ERRCODE = 'ERP13';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.company_id <> OLD.company_id OR NEW.employee_id <> OLD.employee_id OR NEW.doc_id IS DISTINCT FROM OLD.doc_id OR NEW.param_id <> OLD.param_id
     OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency OR NEW.deposited_date <> OLD.deposited_date OR NEW.param_verified <> OLD.param_verified
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Teminatın personeli, tutarı, para birimi ve yatırma tarihi değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;
  IF OLD.status <> 'held' THEN
    IF NEW.status <> OLD.status OR NEW.resolved_date IS DISTINCT FROM OLD.resolved_date OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note THEN
      RAISE EXCEPTION 'Sonuçlanmış teminat değiştirilemez' USING ERRCODE = 'ERP13';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'held' THEN
    IF NEW.resolved_date IS NULL THEN
      RAISE EXCEPTION 'İade/irat tarihi gerekir' USING ERRCODE = 'ERP13';
    END IF;
  ELSIF NEW.resolved_date IS NOT NULL THEN
    RAISE EXCEPTION 'Tutulan teminatın sonuç tarihi olmaz' USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER foreign_worker_guarantees_guard
  BEFORE INSERT OR UPDATE OR DELETE ON foreign_worker_guarantees
  FOR EACH ROW EXECUTE FUNCTION foreign_worker_guarantees_guard();
