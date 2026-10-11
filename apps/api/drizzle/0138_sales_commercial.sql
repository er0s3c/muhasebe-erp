CREATE TABLE "commercial_dispute_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"dispute_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_dispute_events_kind_ck" CHECK ("commercial_dispute_events"."kind" in ('created','note','status','assign'))
);
--> statement-breakpoint
CREATE TABLE "commercial_disputes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"category" text NOT NULL,
	"subject" text NOT NULL,
	"amount" numeric(19, 4),
	"currency_code" text,
	"status" text DEFAULT 'open' NOT NULL,
	"owner_id" uuid,
	"due_date" date,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_disputes_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "commercial_disputes_status_ck" CHECK ("commercial_disputes"."status" in ('open','in_review','resolved','rejected')),
	CONSTRAINT "commercial_disputes_category_ck" CHECK ("commercial_disputes"."category" in ('price','quantity','quality','delivery','payment','other')),
	CONSTRAINT "commercial_disputes_source_ck" CHECK (("commercial_disputes"."source_type" is null) = ("commercial_disputes"."source_id" is null) and ("commercial_disputes"."source_type" is null or "commercial_disputes"."source_type" in ('invoice','delivery_note','sales_order'))),
	CONSTRAINT "commercial_disputes_amount_ck" CHECK (("commercial_disputes"."amount" is null) = ("commercial_disputes"."currency_code" is null) and ("commercial_disputes"."amount" is null or "commercial_disputes"."amount" >= 0)),
	CONSTRAINT "commercial_disputes_closed_ck" CHECK (("commercial_disputes"."status" in ('resolved','rejected')) = ("commercial_disputes"."resolved_at" is not null) and ("commercial_disputes"."status" not in ('resolved','rejected') or "commercial_disputes"."resolution" is not null))
);
--> statement-breakpoint
CREATE TABLE "sales_doc_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"event" text NOT NULL,
	"revision_no" integer NOT NULL,
	"currency_code" text NOT NULL,
	"fx_rate" numeric(19, 8),
	"net_base" numeric(19, 4) NOT NULL,
	"cost_base" numeric(19, 4) NOT NULL,
	"margin_pct" numeric(9, 2),
	"min_margin_pct" numeric(7, 2),
	"credit_limit" numeric(19, 4),
	"exposure" numeric(19, 4),
	"warnings" jsonb NOT NULL,
	"override_reason" text,
	"lines" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_doc_snapshots_rev_uq" UNIQUE("order_id","event","revision_no"),
	CONSTRAINT "sales_doc_snapshots_event_ck" CHECK ("sales_doc_snapshots"."event" in ('sent','confirmed'))
);
--> statement-breakpoint
CREATE TABLE "sales_policies" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"min_margin_pct" numeric(7, 2),
	"margin_mode" text DEFAULT 'warn' NOT NULL,
	"credit_mode" text DEFAULT 'warn' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_policies_margin_mode_ck" CHECK ("sales_policies"."margin_mode" in ('off','warn','block')),
	CONSTRAINT "sales_policies_credit_mode_ck" CHECK ("sales_policies"."credit_mode" in ('off','warn','block')),
	CONSTRAINT "sales_policies_min_margin_ck" CHECK ("sales_policies"."min_margin_pct" is null or "sales_policies"."min_margin_pct" between -100 and 100)
);
--> statement-breakpoint
CREATE TABLE "sales_rep_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"from_user_id" uuid,
	"to_user_id" uuid,
	"reason" text,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_rep_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_rep_targets_uq" UNIQUE("company_id","user_id","year","month"),
	CONSTRAINT "sales_rep_targets_month_ck" CHECK ("sales_rep_targets"."month" between 1 and 12 and "sales_rep_targets"."year" between 2000 and 2100),
	CONSTRAINT "sales_rep_targets_amount_ck" CHECK ("sales_rep_targets"."amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "sales_rep_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "sales_rep_id" uuid;--> statement-breakpoint
ALTER TABLE "commercial_dispute_events" ADD CONSTRAINT "commercial_dispute_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_dispute_events" ADD CONSTRAINT "commercial_dispute_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_dispute_events" ADD CONSTRAINT "commercial_dispute_events_dispute_fk" FOREIGN KEY ("dispute_id","company_id") REFERENCES "public"."commercial_disputes"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_disputes" ADD CONSTRAINT "commercial_disputes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_disputes" ADD CONSTRAINT "commercial_disputes_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_disputes" ADD CONSTRAINT "commercial_disputes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_disputes" ADD CONSTRAINT "commercial_disputes_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_disputes" ADD CONSTRAINT "commercial_disputes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_disputes" ADD CONSTRAINT "commercial_disputes_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_doc_snapshots" ADD CONSTRAINT "sales_doc_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_doc_snapshots" ADD CONSTRAINT "sales_doc_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_doc_snapshots" ADD CONSTRAINT "sales_doc_snapshots_order_fk" FOREIGN KEY ("order_id","company_id") REFERENCES "public"."sales_orders"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_policies" ADD CONSTRAINT "sales_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_policies" ADD CONSTRAINT "sales_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_rep_changes" ADD CONSTRAINT "sales_rep_changes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_rep_changes" ADD CONSTRAINT "sales_rep_changes_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_rep_changes" ADD CONSTRAINT "sales_rep_changes_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_rep_changes" ADD CONSTRAINT "sales_rep_changes_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_rep_changes" ADD CONSTRAINT "sales_rep_changes_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_rep_targets" ADD CONSTRAINT "sales_rep_targets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_rep_targets" ADD CONSTRAINT "sales_rep_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_rep_targets" ADD CONSTRAINT "sales_rep_targets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commercial_dispute_events_dispute_idx" ON "commercial_dispute_events" USING btree ("company_id","dispute_id","created_at");--> statement-breakpoint
CREATE INDEX "commercial_disputes_party_idx" ON "commercial_disputes" USING btree ("company_id","party_id","status");--> statement-breakpoint
CREATE INDEX "commercial_disputes_source_idx" ON "commercial_disputes" USING btree ("company_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "sales_rep_changes_party_idx" ON "sales_rep_changes" USING btree ("company_id","party_id","changed_at");--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_sales_rep_id_users_id_fk" FOREIGN KEY ("sales_rep_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_sales_rep_id_users_id_fk" FOREIGN KEY ("sales_rep_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE sales_policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sales_policies USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
ALTER TABLE sales_doc_snapshots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sales_doc_snapshots USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
ALTER TABLE sales_rep_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sales_rep_changes USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
ALTER TABLE sales_rep_targets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sales_rep_targets USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
ALTER TABLE commercial_disputes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON commercial_disputes USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
ALTER TABLE commercial_dispute_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON commercial_dispute_events USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON sales_policies TO erp_app;
    GRANT SELECT, INSERT ON sales_doc_snapshots TO erp_app;
    GRANT SELECT, INSERT ON sales_rep_changes TO erp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON sales_rep_targets TO erp_app;
    GRANT SELECT, INSERT, UPDATE ON commercial_disputes TO erp_app;
    GRANT SELECT, INSERT ON commercial_dispute_events TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint
-- Ticari görüntü, sorumlu geçmişi ve itiraz olayları yalnız eklenir; değiştirilemez ve silinemez.
CREATE FUNCTION sales_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION '% kaydı değiştirilemez ve silinemez', TG_TABLE_NAME USING ERRCODE = 'ERP15';
END
$$;
--> statement-breakpoint
CREATE TRIGGER sales_doc_snapshots_guard BEFORE UPDATE OR DELETE ON sales_doc_snapshots FOR EACH ROW EXECUTE FUNCTION sales_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER sales_rep_changes_guard BEFORE UPDATE OR DELETE ON sales_rep_changes FOR EACH ROW EXECUTE FUNCTION sales_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER commercial_dispute_events_guard BEFORE UPDATE OR DELETE ON commercial_dispute_events FOR EACH ROW EXECUTE FUNCTION sales_append_only_guard();
--> statement-breakpoint
-- Kapanmış (çözülmüş/reddedilmiş) itiraz değişmez; cari, kaynak belge ve açan kişi sonradan değiştirilemez.
CREATE FUNCTION commercial_disputes_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'İtiraz dosyası silinemez; reddedilerek kapatılır' USING ERRCODE = 'ERP15';
  END IF;
  IF OLD.status IN ('resolved','rejected') THEN
    RAISE EXCEPTION 'Kapanmış itiraz dosyası değiştirilemez' USING ERRCODE = 'ERP15';
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.party_id <> OLD.party_id OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'İtiraz dosyasının carisi ve kaynak belgesi değiştirilemez' USING ERRCODE = 'ERP15';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER commercial_disputes_guard BEFORE UPDATE OR DELETE ON commercial_disputes FOR EACH ROW EXECUTE FUNCTION commercial_disputes_guard();
