CREATE TABLE "party_bank_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"iban_enc" text NOT NULL,
	"iban_last4" text NOT NULL,
	"iban_hash" text NOT NULL,
	"bank_name" text,
	"holder_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_note" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"verification_method" text,
	"decision_note" text,
	"revoked_by" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "party_bank_accounts_status_ck" CHECK ("party_bank_accounts"."status" in ('pending','verified','rejected','revoked')),
	CONSTRAINT "party_bank_accounts_four_eyes_ck" CHECK ("party_bank_accounts"."decided_by" is null or "party_bank_accounts"."decided_by" <> "party_bank_accounts"."requested_by"),
	CONSTRAINT "party_bank_accounts_decision_ck" CHECK (("party_bank_accounts"."status" = 'pending') = ("party_bank_accounts"."decided_at" is null)),
	CONSTRAINT "party_bank_accounts_verified_ck" CHECK ("party_bank_accounts"."status" not in ('verified','revoked') or ("party_bank_accounts"."verification_method" is not null and char_length("party_bank_accounts"."decision_note") >= 3)),
	CONSTRAINT "party_bank_accounts_holder_ck" CHECK (char_length("party_bank_accounts"."holder_name") between 2 and 140)
);
--> statement-breakpoint
ALTER TABLE "party_bank_accounts" ADD CONSTRAINT "party_bank_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_bank_accounts" ADD CONSTRAINT "party_bank_accounts_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_bank_accounts" ADD CONSTRAINT "party_bank_accounts_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_bank_accounts" ADD CONSTRAINT "party_bank_accounts_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_bank_accounts" ADD CONSTRAINT "party_bank_accounts_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "party_bank_accounts_party_idx" ON "party_bank_accounts" USING btree ("company_id","party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "party_bank_accounts_live_uq" ON "party_bank_accounts" USING btree ("company_id","party_id","iban_hash") WHERE "party_bank_accounts"."status" in ('pending','verified');--> statement-breakpoint
-- Cari banka hesapları: şirket yalıtımı; satır silinmez (değişiklik geçmişi).
ALTER TABLE party_bank_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON party_bank_accounts USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON party_bank_accounts TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint
-- Hesap bilgisi sonradan değişmez (yeni hesap yeni kayıttır); durum yalnız pending → verified/rejected, verified → revoked ilerler.
CREATE FUNCTION party_bank_accounts_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.company_id <> OLD.company_id OR NEW.party_id <> OLD.party_id OR NEW.iban_enc <> OLD.iban_enc OR NEW.iban_hash <> OLD.iban_hash
     OR NEW.iban_last4 <> OLD.iban_last4 OR NEW.holder_name <> OLD.holder_name OR NEW.bank_name IS DISTINCT FROM OLD.bank_name
     OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at OR NEW.request_note IS DISTINCT FROM OLD.request_note THEN
    RAISE EXCEPTION 'Banka hesabı bilgisi değiştirilemez; yeni hesap kaydı açın' USING ERRCODE = 'ERP25';
  END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('verified', 'rejected'))
       OR (OLD.status = 'verified' AND NEW.status = 'revoked')) THEN
    RAISE EXCEPTION 'Banka hesabı durumu bu şekilde değiştirilemez' USING ERRCODE = 'ERP25';
  END IF;
  IF OLD.status = 'verified' AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
     OR NEW.verification_method IS DISTINCT FROM OLD.verification_method OR NEW.decision_note IS DISTINCT FROM OLD.decision_note
     OR NEW.revoked_by IS NULL OR NEW.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Doğrulama kaydı değiştirilemez; hesap yalnız kaldırılabilir' USING ERRCODE = 'ERP25';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER party_bank_accounts_guard BEFORE UPDATE ON party_bank_accounts FOR EACH ROW EXECUTE FUNCTION party_bank_accounts_guard();
