CREATE TABLE "return_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"note_line_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"note" text,
	"stock_document_id" uuid,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_decisions_decision_ck" CHECK ("return_decisions"."decision" in ('restock','scrap')),
	CONSTRAINT "return_decisions_reason_ck" CHECK ("return_decisions"."reason" in ('defective','damaged','wrong_item','unwanted','other')),
	CONSTRAINT "return_decisions_qty_ck" CHECK ("return_decisions"."quantity" > 0),
	CONSTRAINT "return_decisions_scrap_ck" CHECK (("return_decisions"."decision" = 'scrap') = ("return_decisions"."stock_document_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "delivery_notes" ADD COLUMN "inspection_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "return_decisions" ADD CONSTRAINT "return_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_decisions" ADD CONSTRAINT "return_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_decisions" ADD CONSTRAINT "return_decisions_line_fk" FOREIGN KEY ("note_line_id","company_id") REFERENCES "public"."delivery_note_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_decisions" ADD CONSTRAINT "return_decisions_stock_document_fk" FOREIGN KEY ("stock_document_id","company_id") REFERENCES "public"."stock_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "return_decisions_line_idx" ON "return_decisions" USING btree ("company_id","note_line_id");--> statement-breakpoint
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_inspection_ck" CHECK (not "delivery_notes"."inspection_required" or "delivery_notes"."type" = 'sales_return');--> statement-breakpoint
ALTER TABLE return_decisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON return_decisions USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT ON return_decisions TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint
-- Karar yalnız kaydedilmiş, kalite kararı istenen satış iadesi satırına verilir; toplam karar iade miktarını aşamaz; kayıtlar değişmez.
CREATE FUNCTION return_decisions_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  l_qty numeric;
  n_status text;
  n_type text;
  n_required boolean;
  decided numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'İade kalite kararı değiştirilemez ve silinemez' USING ERRCODE = 'ERP04';
  END IF;
  SELECT l.quantity, n.status, n.type, n.inspection_required INTO l_qty, n_status, n_type, n_required
    FROM delivery_note_lines l JOIN delivery_notes n ON n.id = l.note_id
   WHERE l.id = NEW.note_line_id
     FOR UPDATE OF l;
  IF n_status IS DISTINCT FROM 'posted' OR n_type IS DISTINCT FROM 'sales_return' OR NOT coalesce(n_required, false) THEN
    RAISE EXCEPTION 'Kalite kararı yalnız kaydedilmiş, kalite kararı istenen satış iadesine verilir' USING ERRCODE = 'ERP04';
  END IF;
  SELECT coalesce(sum(quantity), 0) INTO decided FROM return_decisions WHERE note_line_id = NEW.note_line_id;
  IF decided + NEW.quantity > l_qty THEN
    RAISE EXCEPTION 'Kalite kararı toplamı iade miktarını aşamaz' USING ERRCODE = 'ERP04';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER return_decisions_guard BEFORE INSERT OR UPDATE OR DELETE ON return_decisions FOR EACH ROW EXECUTE FUNCTION return_decisions_guard();
