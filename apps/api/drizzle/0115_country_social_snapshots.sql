ALTER TABLE "social_declaration_lines" ADD COLUMN "employee_provident" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "social_declaration_lines" ADD COLUMN "employer_provident" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "social_declaration_lines" ADD COLUMN "employer_local_employment" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "social_declaration_lines" ADD COLUMN "legal_calculation_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "social_declarations" ADD COLUMN "jurisdiction" text;--> statement-breakpoint
ALTER TABLE "social_declarations" ADD COLUMN "legal_profile_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "social_declarations" ADD COLUMN "country_config_snapshot" jsonb;
--> statement-breakpoint
CREATE FUNCTION social_country_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.status='finalized' AND (NEW.jurisdiction,NEW.legal_profile_snapshot,NEW.country_config_snapshot) IS DISTINCT FROM (OLD.jurisdiction,OLD.legal_profile_snapshot,OLD.country_config_snapshot) THEN
    RAISE EXCEPTION 'Kesinleşmiş sosyal bildirimin ülke anlık görüntüsü değiştirilemez' USING ERRCODE='ERP13';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER social_country_snapshot_guard BEFORE UPDATE ON social_declarations FOR EACH ROW EXECUTE FUNCTION social_country_snapshot_guard();
ALTER TABLE social_declaration_lines ADD CONSTRAINT social_country_components_positive_ck CHECK(employee_provident>=0 AND employer_provident>=0 AND employer_local_employment>=0);
