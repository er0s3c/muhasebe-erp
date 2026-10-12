CREATE TABLE "financial_obligations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"config" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_obligation_id_company" UNIQUE("id","company_id"),
	CONSTRAINT "financial_obligation_category" CHECK ("financial_obligations"."category" in ('tax','social_security','payroll','rent','loan','insurance','utility','other'))
);
--> statement-breakpoint
CREATE TABLE "obligation_completions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"period_date" date NOT NULL,
	"status" text NOT NULL,
	"paid_amount" text,
	"note" text DEFAULT '' NOT NULL,
	"completed_by" uuid NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "obligation_completion_period" UNIQUE("obligation_id","period_date"),
	CONSTRAINT "obligation_completion_status" CHECK ("obligation_completions"."status" in ('done','skipped')),
	CONSTRAINT "obligation_completion_amount" CHECK ("obligation_completions"."paid_amount" is null or "obligation_completions"."paid_amount"::numeric>=0)
);
--> statement-breakpoint
ALTER TABLE "financial_obligations" ADD CONSTRAINT "financial_obligations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_obligations" ADD CONSTRAINT "financial_obligations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligation_completions" ADD CONSTRAINT "obligation_completions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligation_completions" ADD CONSTRAINT "obligation_completions_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligation_completions" ADD CONSTRAINT "obligation_completion_obligation" FOREIGN KEY ("obligation_id","company_id") REFERENCES "public"."financial_obligations"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['financial_obligations','obligation_completions'] LOOP
EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())',t);
EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',t);
END LOOP; END $$;
--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
  GRANT SELECT, INSERT, UPDATE ON financial_obligations TO erp_app;
  GRANT SELECT, INSERT, DELETE ON obligation_completions TO erp_app;
END IF; END $$;
--> statement-breakpoint
-- Yükümlülük silinmez (pasifleştirilir); tamamlama kaydı değiştirilmez, yalnız geri alınır (silinir, denetim izinde kalır).
CREATE FUNCTION financial_obligation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Yükümlülük silinemez; pasifleştirin' USING ERRCODE='ERP19'; END IF;
 IF NEW.id<>OLD.id OR NEW.company_id<>OLD.company_id OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
   RAISE EXCEPTION 'Yükümlülük kimliği değiştirilemez' USING ERRCODE='ERP19';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER financial_obligation_guard BEFORE UPDATE OR DELETE ON financial_obligations FOR EACH ROW EXECUTE FUNCTION financial_obligation_guard();
--> statement-breakpoint
CREATE FUNCTION obligation_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Tamamlama kaydı değiştirilemez; geri alıp yeniden işaretleyin' USING ERRCODE='ERP19';
END $$;
--> statement-breakpoint
CREATE TRIGGER obligation_completion_guard BEFORE UPDATE ON obligation_completions FOR EACH ROW EXECUTE FUNCTION obligation_completion_guard();
