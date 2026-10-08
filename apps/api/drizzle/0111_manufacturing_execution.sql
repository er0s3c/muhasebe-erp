ALTER TABLE manufacturing_records DROP CONSTRAINT manufacturing_records_kind_check;
ALTER TABLE manufacturing_records ADD CONSTRAINT manufacturing_records_kind_check CHECK(kind IN ('resource','calendar','maintenance','schedule','transfer','bin','lot','lot_event','placement','shipment','connection','integration_event','demo_dataset','department','custom_field','attendance','supplier_profile','demand_policy','batch','work_session','rework','pattern','cut_plan','exception','cost_close','channel_mapping','inventory_outbox','command_event','service_time'));
--> statement-breakpoint
CREATE TABLE manufacturing_sales_allocations (
 id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), created_by uuid NOT NULL REFERENCES users(id),
 sales_order_line_id uuid NOT NULL, item_id uuid NOT NULL, warehouse_id uuid NOT NULL,
 quantity numeric(20,4) NOT NULL CHECK(quantity >= 0), fulfilled_qty numeric(20,4) NOT NULL DEFAULT 0 CHECK(fulfilled_qty >= 0),
 priority integer NOT NULL DEFAULT 50 CHECK(priority BETWEEN 0 AND 100), reason text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','released')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,company_id), UNIQUE(company_id,sales_order_line_id,warehouse_id),
 FOREIGN KEY(sales_order_line_id,company_id) REFERENCES sales_order_lines(id,company_id),
 FOREIGN KEY(item_id,company_id) REFERENCES items(id,company_id),
 FOREIGN KEY(warehouse_id,company_id) REFERENCES warehouses(id,company_id)
);
CREATE INDEX manufacturing_sales_allocations_stock_idx ON manufacturing_sales_allocations(company_id,item_id,warehouse_id) WHERE status='active';
ALTER TABLE manufacturing_sales_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON manufacturing_sales_allocations USING(company_id=app_company_id()) WITH CHECK(company_id=app_company_id());
GRANT SELECT,INSERT,UPDATE ON manufacturing_sales_allocations TO erp_app;
CREATE TRIGGER audit_manufacturing_sales_allocations AFTER INSERT OR UPDATE ON manufacturing_sales_allocations FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint
CREATE FUNCTION manufacturing_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.kind='command_event' THEN RAISE EXCEPTION 'Üretim komut olayları değiştirilemez'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER manufacturing_immutable_event BEFORE UPDATE OR DELETE ON manufacturing_records FOR EACH ROW EXECUTE FUNCTION manufacturing_event_guard();
