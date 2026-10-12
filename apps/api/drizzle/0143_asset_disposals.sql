CREATE TABLE "asset_disposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"disposal_date" date NOT NULL,
	"method" text NOT NULL,
	"proceeds" text NOT NULL,
	"cost" text NOT NULL,
	"accumulated" text NOT NULL,
	"book_value" text NOT NULL,
	"gain_loss" text NOT NULL,
	"accounts" jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"reversal_entry_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_disposal_method" CHECK ("asset_disposals"."method" in ('sale','scrap')),
	CONSTRAINT "asset_disposal_proceeds" CHECK ("asset_disposals"."proceeds"::numeric>=0 and ("asset_disposals"."method"='sale' or "asset_disposals"."proceeds"::numeric=0))
);
--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposal_asset" FOREIGN KEY ("asset_id","company_id") REFERENCES "public"."fixed_assets"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposal_journal" FOREIGN KEY ("journal_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposal_reversal" FOREIGN KEY ("reversal_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_disposal_active" ON "asset_disposals" USING btree ("asset_id") WHERE "asset_disposals"."cancelled_at" is null;--> statement-breakpoint
ALTER TABLE asset_disposals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON asset_disposals USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
CREATE TRIGGER audit_asset_disposals AFTER INSERT OR UPDATE OR DELETE ON asset_disposals FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN GRANT SELECT, INSERT, UPDATE ON asset_disposals TO erp_app; END IF; END $$;
--> statement-breakpoint
-- Elden çıkarma kayıtlı, kaynağı kendisi olan yevmiyeye bağlıdır; yalnız gerekçeyle bir kez ters kayıtla iptal edilir.
CREATE FUNCTION asset_disposal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j journal_entries%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Elden çıkarma kaydı silinemez; iptal edin' USING ERRCODE='ERP19'; END IF;
 SELECT * INTO j FROM journal_entries WHERE id=NEW.journal_entry_id AND company_id=NEW.company_id;
 IF NOT FOUND OR j.source_type IS DISTINCT FROM 'asset_disposal' OR j.source_id IS DISTINCT FROM NEW.id OR j.reversal_of_id IS NOT NULL OR j.status<>'posted' THEN
   RAISE EXCEPTION 'Elden çıkarma kendi kayıtlı yevmiyesine bağlı olmalı' USING ERRCODE='ERP19';
 END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.cancelled_at IS NOT NULL OR NEW.reversal_entry_id IS NOT NULL
      OR NEW.book_value::numeric<>NEW.cost::numeric-NEW.accumulated::numeric
      OR NEW.gain_loss::numeric<>NEW.proceeds::numeric-NEW.book_value::numeric
      OR NOT EXISTS(SELECT 1 FROM journal_lines WHERE entry_id=NEW.journal_entry_id AND account_id=(NEW.accounts->>'assetAccountId')::uuid AND credit_base=NEW.cost::numeric AND debit_base=0) THEN
     RAISE EXCEPTION 'Elden çıkarma tutarları yevmiyeyle uyuşmuyor' USING ERRCODE='ERP19';
   END IF;
 ELSE
   IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL OR length(btrim(coalesce(NEW.cancel_reason,'')))<3
     OR (to_jsonb(NEW)-'cancelled_at'-'cancel_reason'-'reversal_entry_id')<>(to_jsonb(OLD)-'cancelled_at'-'cancel_reason'-'reversal_entry_id')
     OR NOT EXISTS(SELECT 1 FROM journal_entries r WHERE r.id=NEW.reversal_entry_id AND r.company_id=NEW.company_id AND r.status='posted' AND r.reversal_of_id=j.id AND j.reversed_by_id=r.id) THEN
     RAISE EXCEPTION 'Elden çıkarma yalnızca gerekçe ve ters yevmiyeyle bir kez iptal edilir' USING ERRCODE='ERP19';
   END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER asset_disposal_guard BEFORE INSERT OR UPDATE OR DELETE ON asset_disposals FOR EACH ROW EXECUTE FUNCTION asset_disposal_guard();
--> statement-breakpoint
-- Elden çıkarılmış kart yeniden etkinleştirilemez (amortisman yalnız etkin karta yazılır); önce elden çıkarma iptal edilir.
CREATE FUNCTION fixed_asset_disposed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.active AND NOT OLD.active AND EXISTS(SELECT 1 FROM asset_disposals WHERE asset_id=NEW.id AND company_id=NEW.company_id AND cancelled_at IS NULL) THEN
   RAISE EXCEPTION 'Elden çıkarılmış demirbaş etkinleştirilemez' USING ERRCODE='ERP19';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fixed_asset_disposed_guard BEFORE UPDATE ON fixed_assets FOR EACH ROW EXECUTE FUNCTION fixed_asset_disposed_guard();
