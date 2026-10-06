ALTER TABLE "cheque_batches" ADD COLUMN "currency_code" text;--> statement-breakpoint
ALTER TABLE "cheque_batches" ADD COLUMN "total_base" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "cheques" ADD COLUMN "amount_base" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "cheques" ADD COLUMN "fx_rate" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "cheque_batches" ADD CONSTRAINT "cheque_batches_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE cheque_batches DISABLE TRIGGER cheque_batches_guard;
UPDATE cheque_batches b SET currency_code=c.base_currency,total_base=b.total FROM companies c WHERE c.id=b.company_id;
ALTER TABLE cheque_batches ENABLE TRIGGER cheque_batches_guard;
UPDATE cheques SET amount_base=amount;
ALTER TABLE cheque_batches ALTER COLUMN currency_code SET NOT NULL;
ALTER TABLE cheque_batches ALTER COLUMN total_base SET NOT NULL;
ALTER TABLE cheques ALTER COLUMN amount_base SET NOT NULL;
CREATE FUNCTION cheque_book_value_seal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
IF TG_OP='UPDATE' AND (NEW.amount_base IS DISTINCT FROM OLD.amount_base OR NEW.fx_rate IS DISTINCT FROM OLD.fx_rate) THEN RAISE EXCEPTION 'Belgenin kayıt kuru ve defter değeri değiştirilemez' USING ERRCODE='ERP14'; END IF;
IF NEW.amount_base<=0 OR (NEW.fx_rate IS NOT NULL AND NEW.fx_rate<=0) THEN RAISE EXCEPTION 'Geçersiz belge defter değeri veya kur' USING ERRCODE='23514'; END IF;
RETURN NEW; END $$;
CREATE TRIGGER cheque_book_value_seal BEFORE INSERT OR UPDATE ON cheques FOR EACH ROW EXECUTE FUNCTION cheque_book_value_seal();
