CREATE TABLE pos_tills (
 id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), name text NOT NULL,
 warehouse_id uuid NOT NULL, cash_account_id uuid NOT NULL, card_account_id uuid,
 walk_in_party_id uuid NOT NULL, currency_code text NOT NULL, max_discount_pct numeric(7,4) NOT NULL DEFAULT 0,
 assigned_user_ids jsonb NOT NULL DEFAULT '[]', is_active boolean NOT NULL DEFAULT true,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT pos_tills_company_id_uq UNIQUE(id,company_id), CONSTRAINT pos_tills_name_uq UNIQUE(company_id,name),CONSTRAINT pos_tills_cash_uq UNIQUE(company_id,cash_account_id),
 CONSTRAINT pos_tills_warehouse_fk FOREIGN KEY(warehouse_id,company_id) REFERENCES warehouses(id,company_id),
 CONSTRAINT pos_tills_cash_fk FOREIGN KEY(cash_account_id,company_id) REFERENCES treasury_accounts(id,company_id),
 CONSTRAINT pos_tills_card_fk FOREIGN KEY(card_account_id,company_id) REFERENCES treasury_accounts(id,company_id),
 CONSTRAINT pos_tills_party_fk FOREIGN KEY(walk_in_party_id,company_id) REFERENCES parties(id,company_id),
 CONSTRAINT pos_tills_discount_ck CHECK(max_discount_pct BETWEEN 0 AND 100),CONSTRAINT pos_tills_accounts_ck CHECK(card_account_id IS NULL OR card_account_id<>cash_account_id)
);
CREATE TABLE pos_sessions (
 id uuid PRIMARY KEY,company_id uuid NOT NULL REFERENCES companies(id),till_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'open',opening_cash numeric(19,2) NOT NULL,expected_cash numeric(19,2),counted_cash numeric(19,2),variance numeric(19,2),close_reason text,
 opened_at timestamptz NOT NULL DEFAULT now(),closed_at timestamptz,
 CONSTRAINT pos_sessions_company_id_uq UNIQUE(id,company_id),CONSTRAINT pos_sessions_till_fk FOREIGN KEY(till_id,company_id) REFERENCES pos_tills(id,company_id),
 CONSTRAINT pos_sessions_status_ck CHECK(status IN ('open','closed')),CONSTRAINT pos_sessions_cash_ck CHECK(opening_cash>=0 AND (counted_cash IS NULL OR counted_cash>=0)),
 CONSTRAINT pos_sessions_closed_ck CHECK((status='open' AND closed_at IS NULL) OR (status='closed' AND closed_at IS NOT NULL AND counted_cash IS NOT NULL AND expected_cash IS NOT NULL AND variance=counted_cash-expected_cash))
);
CREATE UNIQUE INDEX pos_sessions_open_till_uq ON pos_sessions(till_id) WHERE status='open';
CREATE UNIQUE INDEX pos_sessions_open_user_uq ON pos_sessions(company_id,user_id) WHERE status='open';
CREATE TABLE pos_sales (
 id uuid PRIMARY KEY,company_id uuid NOT NULL REFERENCES companies(id),session_id uuid NOT NULL,request_id uuid NOT NULL,
 invoice_id uuid NOT NULL,source_sale_id uuid,kind text NOT NULL,total numeric(19,2) NOT NULL,payments jsonb NOT NULL,request_hash text NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT pos_sales_company_id_uq UNIQUE(id,company_id),CONSTRAINT pos_sales_request_uq UNIQUE(company_id,request_id),CONSTRAINT pos_sales_invoice_uq UNIQUE(invoice_id),
 CONSTRAINT pos_sales_session_fk FOREIGN KEY(session_id,company_id) REFERENCES pos_sessions(id,company_id),
 CONSTRAINT pos_sales_invoice_fk FOREIGN KEY(invoice_id,company_id) REFERENCES invoices(id,company_id),
 CONSTRAINT pos_sales_source_fk FOREIGN KEY(source_sale_id,company_id) REFERENCES pos_sales(id,company_id),
 CONSTRAINT pos_sales_kind_ck CHECK((kind='sale' AND source_sale_id IS NULL) OR (kind='return' AND source_sale_id IS NOT NULL)),CONSTRAINT pos_sales_total_ck CHECK(total>0)
);
CREATE INDEX pos_sales_session_idx ON pos_sales(company_id,session_id);
DO $$ DECLARE tab text; BEGIN FOREACH tab IN ARRAY ARRAY['pos_tills','pos_sessions','pos_sales'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING (company_id = nullif(current_setting(''app.company_id'',true),'''')::uuid) WITH CHECK (company_id = nullif(current_setting(''app.company_id'',true),'''')::uuid)',tab);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO erp_app',tab);
 END LOOP; END $$;
CREATE FUNCTION pos_sales_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'POS satış kaydı değiştirilemez; iade kaydı oluşturun' USING ERRCODE='ERP05'; END $$;
CREATE TRIGGER pos_sales_immutable BEFORE UPDATE OR DELETE ON pos_sales FOR EACH ROW EXECUTE FUNCTION pos_sales_guard();
CREATE FUNCTION pos_sessions_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR OLD.status='closed' THEN RAISE EXCEPTION 'Kapanmış POS vardiyası değiştirilemez' USING ERRCODE='ERP05'; END IF;
 IF (to_jsonb(OLD)-'status'-'expected_cash'-'counted_cash'-'variance'-'close_reason'-'closed_at') <> (to_jsonb(NEW)-'status'-'expected_cash'-'counted_cash'-'variance'-'close_reason'-'closed_at') THEN RAISE EXCEPTION 'POS vardiyasının kasa/kullanıcı/açılış bilgisi değiştirilemez' USING ERRCODE='ERP05'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER pos_sessions_immutable BEFORE UPDATE OR DELETE ON pos_sessions FOR EACH ROW EXECUTE FUNCTION pos_sessions_guard();
DO $$ DECLARE tab text; BEGIN FOREACH tab IN ARRAY ARRAY['pos_tills','pos_sessions','pos_sales'] LOOP
 EXECUTE format('CREATE TRIGGER audit_%I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',tab,tab);
 END LOOP; END $$;
