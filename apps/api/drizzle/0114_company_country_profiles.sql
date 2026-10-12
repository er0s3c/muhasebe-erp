CREATE TABLE "company_profile_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"jurisdiction" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"time_zone" text NOT NULL,
	"fx_provider" text NOT NULL,
	"rule_pack_version" text NOT NULL,
	"engine_version" text NOT NULL,
	"legal_entity_type" text NOT NULL,
	"vat_registered" boolean NOT NULL,
	"activity_code" text,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_profile_versions_date_uq" UNIQUE("company_id","effective_from"),
	CONSTRAINT "company_profile_versions_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "company_profile_versions_country_ck" CHECK ("company_profile_versions"."jurisdiction" in ('TR','KKTC')),
	CONSTRAINT "company_profile_versions_range_ck" CHECK ("company_profile_versions"."effective_to" is null or "company_profile_versions"."effective_to" >= "company_profile_versions"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "employee_payroll_tax_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"profile" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "employee_payroll_tax_profiles_date_uq" UNIQUE("employee_id","effective_from")
);
--> statement-breakpoint
CREATE TABLE "payroll_country_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"jurisdiction" text NOT NULL,
	"effective_from" date NOT NULL,
	"config" jsonb NOT NULL,
	"source_note" text NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "payroll_country_configs_date_uq" UNIQUE("company_id","effective_from"),
	CONSTRAINT "payroll_country_configs_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "payroll_country_configs_country_ck" CHECK ("payroll_country_configs"."jurisdiction" in ('TR','KKTC'))
);
--> statement-breakpoint
ALTER TABLE "payroll_line_items" DROP CONSTRAINT "payroll_line_items_source_ck";--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "jurisdiction" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "profile_mode" text DEFAULT 'legacy_manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "profile_version_id" uuid;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "time_zone" text DEFAULT 'Europe/Nicosia' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "fx_provider" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "tax_setup_status" text DEFAULT 'legacy_manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "legal_entity_type" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "vat_registered" boolean;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "activity_code" text;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD COLUMN "provider" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD COLUMN "effective_buy" numeric(19, 8);--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD COLUMN "effective_sell" numeric(19, 8);--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD COLUMN "fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "legal_profile_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "legal_profile_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "affects_stamp_base" boolean;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD COLUMN "legal_calculation_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "jurisdiction" text;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "engine_version" text DEFAULT 'legacy-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "legal_profile_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "country_config_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD COLUMN "jurisdiction" text;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD COLUMN "rule_pack_version" text;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "company_profile_versions" ADD CONSTRAINT "company_profile_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_profile_versions" ADD CONSTRAINT "company_profile_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_payroll_tax_profiles" ADD CONSTRAINT "employee_payroll_tax_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_payroll_tax_profiles" ADD CONSTRAINT "employee_payroll_tax_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_payroll_tax_profiles" ADD CONSTRAINT "employee_payroll_tax_profiles_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_country_configs" ADD CONSTRAINT "payroll_country_configs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_country_configs" ADD CONSTRAINT "payroll_country_configs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_jurisdiction_ck" CHECK ("companies"."jurisdiction" is null or "companies"."jurisdiction" in ('TR','KKTC'));--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_profile_mode_ck" CHECK ("companies"."profile_mode" in ('legacy_manual','country'));--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_tax_setup_ck" CHECK ("companies"."tax_setup_status" in ('legacy_manual','needs_review','ready'));--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_fx_provider_ck" CHECK ("companies"."fx_provider" is null or "companies"."fx_provider" in ('tcmb','kktcmb'));--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_provider_ck" CHECK ("exchange_rates"."provider" in ('manual','xml','tcmb','kktcmb'));--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_effective_positive_ck" CHECK (("exchange_rates"."effective_buy" is null or "exchange_rates"."effective_buy" > 0) and ("exchange_rates"."effective_sell" is null or "exchange_rates"."effective_sell" > 0));--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_country_ref_ck" CHECK ("payroll_line_items"."source"<>'country' or ("payroll_line_items"."item_id" is null and "payroll_line_items"."param_key" is null));--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_source_ck" CHECK ("payroll_line_items"."source" in ('manual','param','country'));
--> statement-breakpoint
-- Eski kur kaynağı biliniyorsa sağlayıcı etiketini taşı; şirket ülkesini tahmin etme.
UPDATE exchange_rates SET provider='kktcmb', source_url='https://www.mb.gov.ct.tr/kur/gunluk.xml' WHERE source LIKE 'KKTCMB%';
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['company_profile_versions','payroll_country_configs','employee_payroll_tax_profiles'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(company_id=app_company_id()) WITH CHECK(company_id=app_company_id())',t);
    EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',t);
  END LOOP;
  GRANT SELECT,INSERT,UPDATE ON company_profile_versions,payroll_country_configs TO erp_app;
  GRANT SELECT,INSERT ON employee_payroll_tax_profiles TO erp_app;
END $$;
--> statement-breakpoint
CREATE FUNCTION company_has_finalized_records(p_company uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM journal_entries WHERE company_id=p_company AND status='posted')
    OR EXISTS(SELECT 1 FROM invoices WHERE company_id=p_company AND status<>'draft')
    OR EXISTS(SELECT 1 FROM payroll_runs WHERE company_id=p_company AND status<>'draft')
    OR EXISTS(SELECT 1 FROM social_declarations WHERE company_id=p_company AND status='finalized')
$$;
--> statement-breakpoint
CREATE FUNCTION company_profile_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_country text; BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Ülke profili geçmişi silinemez' USING ERRCODE='ERP24'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('company-profile:'||NEW.company_id::text,0));
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'effective_to') IS DISTINCT FROM (to_jsonb(OLD)-'effective_to') OR OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL THEN
      RAISE EXCEPTION 'Ülke profili değişmez; yeni tarihli sürüm oluşturun' USING ERRCODE='ERP24';
    END IF;
    IF EXISTS(SELECT 1 FROM invoices WHERE company_id=OLD.company_id AND status<>'draft' AND legal_profile_snapshot->>'profileVersionId'=OLD.id::text AND invoice_date>NEW.effective_to)
      OR EXISTS(SELECT 1 FROM journal_entries WHERE company_id=OLD.company_id AND status='posted' AND legal_profile_snapshot->>'profileVersionId'=OLD.id::text AND entry_date>NEW.effective_to) THEN
      RAISE EXCEPTION 'Profil bitişi kesinleşmiş belge tarihinden önce olamaz' USING ERRCODE='ERP24';
    END IF;
  END IF;
  SELECT jurisdiction INTO current_country FROM companies WHERE id=NEW.company_id;
  IF TG_OP='INSERT' AND current_country IS NOT NULL AND current_country<>NEW.jurisdiction AND company_has_finalized_records(NEW.company_id) THEN
    RAISE EXCEPTION 'Kesinleşmiş mali kayıtları bulunan şirketin ülkesi değiştirilemez' USING ERRCODE='ERP24';
  END IF;
  IF EXISTS(SELECT 1 FROM company_profile_versions p WHERE p.company_id=NEW.company_id AND p.id<>NEW.id AND p.effective_from<=coalesce(NEW.effective_to,'infinity'::date) AND coalesce(p.effective_to,'infinity'::date)>=NEW.effective_from) THEN
    RAISE EXCEPTION 'Ülke profil tarih aralıkları çakışamaz' USING ERRCODE='ERP24';
  END IF;
  IF NEW.fx_provider<>(CASE WHEN NEW.jurisdiction='TR' THEN 'tcmb' ELSE 'kktcmb' END) OR NEW.time_zone NOT IN ('Europe/Istanbul','Europe/Nicosia') OR NEW.legal_entity_type NOT IN ('sole_proprietor','company','nonprofit','other') THEN
    RAISE EXCEPTION 'Ülke profili sağlayıcı veya şirket türü geçersiz' USING ERRCODE='ERP24';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_profile_version_guard BEFORE INSERT OR UPDATE OR DELETE ON company_profile_versions FOR EACH ROW EXECUTE FUNCTION company_profile_version_guard();
--> statement-breakpoint
CREATE FUNCTION company_country_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (NEW.jurisdiction,NEW.profile_mode,NEW.profile_version_id,NEW.time_zone,NEW.fx_provider,NEW.legal_entity_type,NEW.vat_registered,NEW.activity_code) IS DISTINCT FROM (OLD.jurisdiction,OLD.profile_mode,OLD.profile_version_id,OLD.time_zone,OLD.fx_provider,OLD.legal_entity_type,OLD.vat_registered,OLD.activity_code) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('company-profile:'||NEW.id::text,0));
    IF OLD.jurisdiction IS NOT NULL AND NEW.jurisdiction IS DISTINCT FROM OLD.jurisdiction AND company_has_finalized_records(NEW.id) THEN
      RAISE EXCEPTION 'Kesinleşmiş mali kayıtları bulunan şirketin ülkesi değiştirilemez' USING ERRCODE='ERP24';
    END IF;
    IF NEW.profile_mode='country' AND NOT EXISTS(SELECT 1 FROM company_profile_versions p WHERE p.company_id=NEW.id AND p.id=NEW.profile_version_id AND p.jurisdiction=NEW.jurisdiction AND p.time_zone=NEW.time_zone AND p.fx_provider=NEW.fx_provider AND p.legal_entity_type=NEW.legal_entity_type AND p.vat_registered=NEW.vat_registered AND p.activity_code IS NOT DISTINCT FROM NEW.activity_code AND p.effective_to IS NULL) THEN
      RAISE EXCEPTION 'Şirket ülke ayarı geçerli tarihli profil gerektirir' USING ERRCODE='ERP24';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_country_guard BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION company_country_guard();
--> statement-breakpoint
CREATE FUNCTION company_legal_profile_snapshot(p_company uuid,p_date date) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('jurisdiction',jurisdiction,'profileVersionId',id,'rulePackVersion',rule_pack_version,'engineVersion',engine_version,'effectiveFrom',effective_from,'legalEntityType',legal_entity_type,'vatRegistered',vat_registered,'activityCode',activity_code,'sourceRefs',source_refs)
  FROM company_profile_versions WHERE company_id=p_company AND effective_from<=p_date AND (effective_to IS NULL OR effective_to>=p_date) ORDER BY effective_from DESC LIMIT 1
$$;
--> statement-breakpoint
CREATE FUNCTION financial_legal_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='UPDATE' AND OLD.status<>'draft' AND NEW.legal_profile_snapshot IS DISTINCT FROM OLD.legal_profile_snapshot THEN
    RAISE EXCEPTION 'Kesinleşmiş belgenin ülke anlık görüntüsü değiştirilemez' USING ERRCODE='ERP24';
  END IF;
  IF NEW.status='posted' AND (TG_OP='INSERT' OR OLD.status='draft') THEN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('company-profile:'||NEW.company_id::text,0));
    IF TG_TABLE_NAME='invoices' THEN
      IF NEW.return_of_id IS NOT NULL THEN SELECT legal_profile_snapshot INTO NEW.legal_profile_snapshot FROM invoices WHERE id=NEW.return_of_id AND company_id=NEW.company_id;
      ELSE NEW.legal_profile_snapshot:=company_legal_profile_snapshot(NEW.company_id,NEW.invoice_date); END IF;
    ELSE
      IF NEW.reversal_of_id IS NOT NULL THEN SELECT legal_profile_snapshot INTO NEW.legal_profile_snapshot FROM journal_entries WHERE id=NEW.reversal_of_id AND company_id=NEW.company_id;
      ELSE NEW.legal_profile_snapshot:=company_legal_profile_snapshot(NEW.company_id,NEW.entry_date); END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_legal_snapshot_guard BEFORE INSERT OR UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION financial_legal_snapshot_guard();
CREATE TRIGGER financial_legal_snapshot_guard BEFORE INSERT OR UPDATE ON journal_entries FOR EACH ROW EXECUTE FUNCTION financial_legal_snapshot_guard();
--> statement-breakpoint
CREATE FUNCTION tax_rate_country_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p jsonb; BEGIN
  p:=company_legal_profile_snapshot(NEW.company_id,NEW.valid_from);
  IF NEW.jurisdiction IS NULL THEN NEW.jurisdiction:=p->>'jurisdiction'; END IF;
  IF NEW.rule_pack_version IS NULL THEN NEW.rule_pack_version:=p->>'rulePackVersion'; END IF;
  IF p IS NOT NULL AND NEW.jurisdiction IS DISTINCT FROM p->>'jurisdiction' THEN RAISE EXCEPTION 'KDV oranının ülkesi tarihli şirket profiline uymalı' USING ERRCODE='ERP24'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_rate_country_guard BEFORE INSERT ON tax_rates FOR EACH ROW EXECUTE FUNCTION tax_rate_country_guard();
--> statement-breakpoint
CREATE FUNCTION payroll_country_config_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Bordro ülke yapılandırması silinemez' USING ERRCODE='ERP13'; END IF;
  IF (to_jsonb(NEW)-ARRAY['enabled','verified_at','verified_by','source_note']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['enabled','verified_at','verified_by','source_note']) THEN RAISE EXCEPTION 'Bordro ülke yapılandırması değişmez; yeni tarihli sürüm ekleyin' USING ERRCODE='ERP13'; END IF;
  IF NEW.source_note IS DISTINCT FROM OLD.source_note THEN NEW.verified_at:=NULL; NEW.verified_by:=NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_country_config_guard BEFORE UPDATE OR DELETE ON payroll_country_configs FOR EACH ROW EXECUTE FUNCTION payroll_country_config_guard();
--> statement-breakpoint
CREATE FUNCTION employee_payroll_tax_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Personel vergi profili değişmez; yeni tarihli sürüm ekleyin' USING ERRCODE='ERP13';
END $$;
CREATE TRIGGER employee_payroll_tax_profile_guard BEFORE UPDATE OR DELETE ON employee_payroll_tax_profiles FOR EACH ROW EXECUTE FUNCTION employee_payroll_tax_profile_guard();
--> statement-breakpoint
CREATE FUNCTION payroll_country_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.status<>'draft' AND (NEW.jurisdiction,NEW.engine_version,NEW.legal_profile_snapshot,NEW.country_config_snapshot) IS DISTINCT FROM (OLD.jurisdiction,OLD.engine_version,OLD.legal_profile_snapshot,OLD.country_config_snapshot) THEN
    RAISE EXCEPTION 'Kesinleşmiş bordro ülke hesabı değiştirilemez' USING ERRCODE='ERP13';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_country_snapshot_guard BEFORE UPDATE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION payroll_country_snapshot_guard();
