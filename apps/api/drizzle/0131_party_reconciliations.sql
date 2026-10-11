CREATE TABLE "party_reconciliations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"base_currency" text NOT NULL,
	"base_balance" numeric(19, 4) NOT NULL,
	"by_currency" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_hash" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"sent_to" text,
	"outbox_message_id" uuid,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"responded_by" uuid,
	"counter_balance" numeric(19, 4),
	"response_note" text,
	CONSTRAINT "party_reconciliations_status_ck" CHECK ("party_reconciliations"."status" in ('open','agreed','disputed','cancelled')),
	CONSTRAINT "party_reconciliations_response_ck" CHECK (("party_reconciliations"."status" in ('agreed','disputed')) = ("party_reconciliations"."responded_at" is not null)),
	CONSTRAINT "party_reconciliations_hash_ck" CHECK ("party_reconciliations"."snapshot_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "party_reconciliations" ADD CONSTRAINT "party_reconciliations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_reconciliations" ADD CONSTRAINT "party_reconciliations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_reconciliations" ADD CONSTRAINT "party_reconciliations_responded_by_users_id_fk" FOREIGN KEY ("responded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_reconciliations" ADD CONSTRAINT "party_reconciliations_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "party_reconciliations_party_idx" ON "party_reconciliations" USING btree ("company_id","party_id","as_of");--> statement-breakpoint
CREATE INDEX "party_reconciliations_status_idx" ON "party_reconciliations" USING btree ("company_id","status");--> statement-breakpoint
ALTER TABLE party_reconciliations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON party_reconciliations USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON party_reconciliations TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint
-- Mektubun içeriği (bakiye ve açık kalem görüntüsü) değişmez; açık mektup bir kez cevaplanır ya da iptal edilir.
CREATE FUNCTION party_reconciliations_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.company_id <> OLD.company_id OR NEW.party_id <> OLD.party_id OR NEW.as_of <> OLD.as_of OR NEW.base_currency <> OLD.base_currency
     OR NEW.base_balance <> OLD.base_balance OR NEW.by_currency <> OLD.by_currency OR NEW.snapshot <> OLD.snapshot
     OR NEW.snapshot_hash <> OLD.snapshot_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Mutabakat mektubunun içeriği değiştirilemez' USING ERRCODE = 'ERP25';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'Cevaplanmış ya da iptal edilmiş mutabakat değiştirilemez' USING ERRCODE = 'ERP25';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER party_reconciliations_guard BEFORE UPDATE ON party_reconciliations FOR EACH ROW EXECUTE FUNCTION party_reconciliations_guard();
