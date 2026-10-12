CREATE TABLE "payment_batch_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"party_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"amount" text NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"treasury_transaction_id" uuid,
	CONSTRAINT "payment_batch_line_no" UNIQUE("batch_id","line_no"),
	CONSTRAINT "payment_batch_line_party_once" UNIQUE("batch_id","party_id"),
	CONSTRAINT "payment_batch_line_amount" CHECK ("payment_batch_lines"."amount"::numeric>0)
);
--> statement-breakpoint
CREATE TABLE "payment_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_no" text NOT NULL,
	"account_id" uuid NOT NULL,
	"payment_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text NOT NULL,
	"total" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "payment_batch_id_company" UNIQUE("id","company_id"),
	CONSTRAINT "payment_batch_no" UNIQUE("company_id","batch_no"),
	CONSTRAINT "payment_batch_status" CHECK ("payment_batches"."status" in ('draft','approved','posted','cancelled')),
	CONSTRAINT "payment_batch_total" CHECK ("payment_batches"."total"::numeric>0)
);
--> statement-breakpoint
ALTER TABLE "payment_batch_lines" ADD CONSTRAINT "payment_batch_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_lines" ADD CONSTRAINT "payment_batch_line_batch" FOREIGN KEY ("batch_id","company_id") REFERENCES "public"."payment_batches"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_lines" ADD CONSTRAINT "payment_batch_line_party" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_lines" ADD CONSTRAINT "payment_batch_line_bank" FOREIGN KEY ("bank_account_id") REFERENCES "public"."party_bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_lines" ADD CONSTRAINT "payment_batch_line_txn" FOREIGN KEY ("treasury_transaction_id","company_id") REFERENCES "public"."treasury_transactions"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batch_account" FOREIGN KEY ("account_id","company_id") REFERENCES "public"."treasury_accounts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['payment_batches','payment_batch_lines'] LOOP
EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())',t);
EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',t);
END LOOP; END $$;
--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
  GRANT SELECT, INSERT, UPDATE ON payment_batches, payment_batch_lines TO erp_app;
END IF; END $$;
--> statement-breakpoint
-- Durum yalnız ileri gider; onaylayan hazırlayandan farklıdır (tek kullanıcılı şirket uygulamada ayrıca izinlidir: approved_by=created_by
-- ancak şirketin tek etkin üyesi varsa). Kayıtlı/iptal liste ve satırları değişmez.
CREATE FUNCTION payment_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Ödeme listesi silinemez; iptal edin' USING ERRCODE='ERP19'; END IF;
 IF NEW.id<>OLD.id OR NEW.company_id<>OLD.company_id OR NEW.created_by<>OLD.created_by OR NEW.batch_no<>OLD.batch_no THEN
   RAISE EXCEPTION 'Ödeme listesi kimliği değiştirilemez' USING ERRCODE='ERP19';
 END IF;
 IF OLD.status IN ('posted','cancelled') THEN RAISE EXCEPTION 'Kayıtlı ya da iptal edilmiş ödeme listesi değiştirilemez' USING ERRCODE='ERP19'; END IF;
 IF NOT ((OLD.status=NEW.status) OR (OLD.status='draft' AND NEW.status IN ('approved','cancelled')) OR (OLD.status='approved' AND NEW.status IN ('posted','cancelled'))) THEN
   RAISE EXCEPTION 'Ödeme listesi durumu bu şekilde değişemez' USING ERRCODE='ERP19';
 END IF;
 IF OLD.status='approved' AND NEW.status='approved' AND (NEW.total<>OLD.total OR NEW.account_id<>OLD.account_id OR NEW.payment_date<>OLD.payment_date) THEN
   RAISE EXCEPTION 'Onaylı ödeme listesi değiştirilemez' USING ERRCODE='ERP19';
 END IF;
 IF NEW.status='approved' AND OLD.status='draft' AND NEW.approved_by IS NULL THEN
   RAISE EXCEPTION 'Onaylayan kaydedilmeli' USING ERRCODE='ERP19';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payment_batch_guard BEFORE UPDATE OR DELETE ON payment_batches FOR EACH ROW EXECUTE FUNCTION payment_batch_guard();
--> statement-breakpoint
CREATE FUNCTION payment_batch_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Ödeme satırı silinemez' USING ERRCODE='ERP19'; END IF;
 SELECT status INTO s FROM payment_batches WHERE id=NEW.batch_id AND company_id=NEW.company_id;
 IF TG_OP='INSERT' AND s<>'draft' THEN RAISE EXCEPTION 'Yalnız taslak listeye satır eklenir' USING ERRCODE='ERP19'; END IF;
 IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-'treasury_transaction_id')<>(to_jsonb(OLD)-'treasury_transaction_id') OR OLD.treasury_transaction_id IS NOT NULL) THEN
   RAISE EXCEPTION 'Ödeme satırı değiştirilemez; yalnız kayıtta ödeme hareketi bağlanır' USING ERRCODE='ERP19';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payment_batch_line_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_batch_lines FOR EACH ROW EXECUTE FUNCTION payment_batch_line_guard();
