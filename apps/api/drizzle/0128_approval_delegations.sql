CREATE TABLE "approval_delegations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"delegator_user_id" uuid NOT NULL,
	"delegate_user_id" uuid NOT NULL,
	"doc_types" text[] NOT NULL,
	"max_amount" numeric(19, 4),
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "approval_delegations_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "approval_delegations_self_ck" CHECK ("approval_delegations"."delegator_user_id" <> "approval_delegations"."delegate_user_id"),
	CONSTRAINT "approval_delegations_window_ck" CHECK ("approval_delegations"."ends_at" > "approval_delegations"."starts_at" and "approval_delegations"."ends_at" <= "approval_delegations"."starts_at" + interval '90 days'),
	CONSTRAINT "approval_delegations_types_ck" CHECK (cardinality("approval_delegations"."doc_types") between 1 and 8 and "approval_delegations"."doc_types" <@ array['progress_payment','employer_claim','purchase_request','variation_order','invoice','sales_quote','payment','expense']::text[]),
	CONSTRAINT "approval_delegations_amount_ck" CHECK ("approval_delegations"."max_amount" is null or "approval_delegations"."max_amount" > 0),
	CONSTRAINT "approval_delegations_reason_ck" CHECK (char_length("approval_delegations"."reason") between 3 and 300)
);
--> statement-breakpoint
ALTER TABLE "approval_steps" ADD COLUMN "on_behalf_of" uuid;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD COLUMN "delegation_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_delegator_user_id_users_id_fk" FOREIGN KEY ("delegator_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_delegate_user_id_users_id_fk" FOREIGN KEY ("delegate_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_delegations_delegate_idx" ON "approval_delegations" USING btree ("company_id","delegate_user_id","ends_at");--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_on_behalf_of_users_id_fk" FOREIGN KEY ("on_behalf_of") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE approval_steps ADD CONSTRAINT approval_steps_delegation_fk FOREIGN KEY (delegation_id, company_id) REFERENCES approval_delegations (id, company_id);
--> statement-breakpoint
ALTER TABLE approval_steps ADD CONSTRAINT approval_steps_behalf_ck CHECK ((on_behalf_of IS NULL) = (delegation_id IS NULL));
--> statement-breakpoint
-- Onay vekâletleri: şirket yalıtımı. Satır silinmez; yalnız geri alma (bir kez) yazılabilir.
ALTER TABLE approval_delegations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON approval_delegations USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON approval_delegations TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION approval_delegations_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Geri alınmış vekâlet değiştirilemez' USING ERRCODE = 'ERP25';
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.delegator_user_id <> OLD.delegator_user_id OR NEW.delegate_user_id <> OLD.delegate_user_id
     OR NEW.doc_types <> OLD.doc_types OR NEW.max_amount IS DISTINCT FROM OLD.max_amount OR NEW.starts_at <> OLD.starts_at
     OR NEW.ends_at <> OLD.ends_at OR NEW.reason <> OLD.reason OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Vekâletin kapsamı değiştirilemez; geri alıp yenisini verin' USING ERRCODE = 'ERP25';
  END IF;
  IF NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL THEN
    RAISE EXCEPTION 'Vekâlet yalnız geri alınabilir' USING ERRCODE = 'ERP25';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER approval_delegations_guard BEFORE UPDATE ON approval_delegations FOR EACH ROW EXECUTE FUNCTION approval_delegations_guard();
