CREATE TABLE "asset_depreciation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"month" text NOT NULL,
	"amount" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"reversal_entry_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_depreciation_month" CHECK ("asset_depreciation"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "asset_depreciation_amount" CHECK ("asset_depreciation"."amount"::numeric>0)
);
--> statement-breakpoint
CREATE TABLE "fixed_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"config" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_asset_code" UNIQUE("company_id","code"),
	CONSTRAINT "fixed_asset_id_company" UNIQUE("id","company_id")
);
--> statement-breakpoint
ALTER TABLE "asset_depreciation" ADD CONSTRAINT "asset_depreciation_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_depreciation" ADD CONSTRAINT "asset_depreciation_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_depreciation" ADD CONSTRAINT "asset_depreciation_asset" FOREIGN KEY ("asset_id","company_id") REFERENCES "public"."fixed_assets"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_depreciation" ADD CONSTRAINT "asset_depreciation_journal" FOREIGN KEY ("journal_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_depreciation" ADD CONSTRAINT "asset_depreciation_reversal" FOREIGN KEY ("reversal_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_depreciation_period" ON "asset_depreciation" USING btree ("asset_id","month") WHERE "asset_depreciation"."cancelled_at" is null;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['fixed_assets','asset_depreciation'] LOOP
EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(company_id=app_company_id()) WITH CHECK(company_id=app_company_id())',t);
EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON fixed_assets,asset_depreciation TO erp_app;
--> statement-breakpoint
CREATE FUNCTION fixed_assets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Demirbaş silinemez; pasifleştirin' USING ERRCODE='ERP19'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.company_id<>OLD.company_id OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at) THEN
   RAISE EXCEPTION 'Demirbaş kimliği değiştirilemez' USING ERRCODE='ERP19';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.config<>OLD.config OR NEW.code<>OLD.code) AND EXISTS(SELECT 1 FROM asset_depreciation WHERE asset_id=OLD.id) THEN
   RAISE EXCEPTION 'Amortisman geçmişi olan kartın mali bilgisi değiştirilemez' USING ERRCODE='ERP19';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fixed_assets_guard BEFORE INSERT OR UPDATE OR DELETE ON fixed_assets FOR EACH ROW EXECUTE FUNCTION fixed_assets_guard();
--> statement-breakpoint
CREATE FUNCTION asset_depreciation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j journal_entries%ROWTYPE; a fixed_assets%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Amortisman geçmişi silinemez' USING ERRCODE='ERP19'; END IF;
 SELECT * INTO j FROM journal_entries WHERE id=NEW.journal_entry_id AND company_id=NEW.company_id;
 IF NOT FOUND OR j.source_type IS DISTINCT FROM 'asset_depreciation' OR j.source_id IS DISTINCT FROM NEW.id OR j.reversal_of_id IS NOT NULL THEN
   RAISE EXCEPTION 'Amortisman kaynaklı yevmiyeye bağlı olmalı' USING ERRCODE='ERP19';
 END IF;
 IF TG_OP='INSERT' THEN
   SELECT * INTO a FROM fixed_assets WHERE id=NEW.asset_id AND company_id=NEW.company_id FOR UPDATE;
   IF NOT FOUND OR NOT a.active OR a.config<>NEW.snapshot OR NEW.cancelled_at IS NOT NULL OR NEW.reversal_entry_id IS NOT NULL THEN
     RAISE EXCEPTION 'Amortisman aktif kartın değişmez hesaplama kopyasını tutmalı' USING ERRCODE='ERP19';
   END IF;
   IF j.status<>'draft' OR to_char(j.entry_date,'YYYY-MM')<>NEW.month THEN
     RAISE EXCEPTION 'Amortisman aynı dönemde taslak yevmiye oluşturmalı' USING ERRCODE='ERP19';
   END IF;
 ELSE
   IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL OR length(btrim(coalesce(NEW.cancel_reason,'')))<3
     OR (to_jsonb(NEW)-'cancelled_at'-'cancel_reason'-'reversal_entry_id')<>(to_jsonb(OLD)-'cancelled_at'-'cancel_reason'-'reversal_entry_id') THEN
     RAISE EXCEPTION 'Amortisman yalnızca gerekçeyle bir kez iptal edilir' USING ERRCODE='ERP19';
   END IF;
   IF j.status='posted' AND NOT EXISTS(SELECT 1 FROM journal_entries r WHERE r.id=NEW.reversal_entry_id AND r.company_id=NEW.company_id AND r.status='posted' AND r.reversal_of_id=j.id AND j.reversed_by_id=r.id) THEN
     RAISE EXCEPTION 'Kayıtlı amortismanın ters yevmiyesi gerekir' USING ERRCODE='ERP19';
   END IF;
   IF j.status='draft' AND NEW.reversal_entry_id IS NOT NULL THEN
     RAISE EXCEPTION 'Taslak amortisman ters yevmiye oluşturmaz' USING ERRCODE='ERP19';
   END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER asset_depreciation_guard BEFORE INSERT OR UPDATE OR DELETE ON asset_depreciation FOR EACH ROW EXECUTE FUNCTION asset_depreciation_guard();
--> statement-breakpoint
CREATE FUNCTION asset_depreciation_journal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d asset_depreciation%ROWTYPE; n integer; v numeric;
BEGIN
 IF NEW.source_type='asset_depreciation' AND NEW.reversal_of_id IS NULL AND TG_OP='UPDATE' THEN
   SELECT * INTO d FROM asset_depreciation WHERE id=NEW.source_id AND company_id=NEW.company_id;
   IF NOT FOUND OR d.cancelled_at IS NOT NULL OR NEW.entry_date<>OLD.entry_date OR NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.source_type IS DISTINCT FROM OLD.source_type THEN
     RAISE EXCEPTION 'Amortisman taslağı iptal edilmiş veya kaynak bilgisi değişmiş' USING ERRCODE='ERP19';
   END IF;
   IF NEW.status='posted' AND OLD.status='draft' THEN
     SELECT count(*),coalesce(sum(debit_base),0) INTO n,v FROM journal_lines WHERE entry_id=NEW.id;
     IF n<>2 OR v<>d.amount::numeric OR NOT EXISTS(SELECT 1 FROM journal_lines WHERE entry_id=NEW.id AND account_id=(d.snapshot->>'expenseAccountId')::uuid AND debit_base=d.amount::numeric AND credit_base=0)
        OR NOT EXISTS(SELECT 1 FROM journal_lines WHERE entry_id=NEW.id AND account_id=(d.snapshot->>'accumulatedAccountId')::uuid AND credit_base=d.amount::numeric AND debit_base=0) THEN
       RAISE EXCEPTION 'Amortisman yevmiyesi hesaplama kopyasıyla uyuşmuyor' USING ERRCODE='ERP19';
     END IF;
   END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER asset_depreciation_journal_guard BEFORE UPDATE ON journal_entries FOR EACH ROW EXECUTE FUNCTION asset_depreciation_journal_guard();
--> statement-breakpoint
CREATE FUNCTION asset_depreciation_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref uuid;
BEGIN
 ref=CASE WHEN TG_OP='DELETE' THEN OLD.entry_id ELSE NEW.entry_id END;
 IF EXISTS(SELECT 1 FROM asset_depreciation WHERE journal_entry_id=ref) OR (TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM asset_depreciation WHERE journal_entry_id=OLD.entry_id)) THEN
   RAISE EXCEPTION 'Amortismanın hesaplanan satırları değiştirilemez; dönemden iptal edin' USING ERRCODE='ERP19';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER asset_depreciation_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION asset_depreciation_lines_guard();
