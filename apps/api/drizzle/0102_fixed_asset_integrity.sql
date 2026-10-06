-- Preserve source identity even when a caller attempts to remove source_type.
CREATE FUNCTION asset_source_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM asset_depreciation WHERE journal_entry_id=OLD.id) AND
   (NEW.id<>OLD.id OR NEW.company_id<>OLD.company_id OR NEW.source_type IS DISTINCT FROM OLD.source_type OR NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.reversal_of_id IS DISTINCT FROM OLD.reversal_of_id OR NEW.entry_date<>OLD.entry_date OR NEW.period_id<>OLD.period_id) THEN
   RAISE EXCEPTION 'Amortisman yevmiyesinin kaynak kimliği ve dönemi değiştirilemez' USING ERRCODE='ERP19';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER asset_source_identity_guard BEFORE UPDATE ON journal_entries FOR EACH ROW EXECUTE FUNCTION asset_source_identity_guard();
--> statement-breakpoint
CREATE FUNCTION asset_calculation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE idx integer; months integer; base numeric; expected numeric; n integer; v numeric;
BEGIN
 idx=(substring(NEW.month,1,4)::integer-substring(NEW.snapshot->>'startMonth',1,4)::integer)*12
     +substring(NEW.month,6,2)::integer-substring(NEW.snapshot->>'startMonth',6,2)::integer;
 months=(NEW.snapshot->>'usefulMonths')::integer;
 base=(NEW.snapshot->>'cost')::numeric-(NEW.snapshot->>'salvage')::numeric;
 IF months NOT BETWEEN 1 AND 600 OR idx<0 OR idx>=months OR base<=0 THEN
   RAISE EXCEPTION 'Amortisman dönemi kullanım planıyla uyuşmuyor' USING ERRCODE='ERP19';
 END IF;
 expected=round(base*(idx+1)/months,2)-round(base*idx/months,2);
 SELECT count(*),coalesce(sum(debit_base),0) INTO n,v FROM journal_lines WHERE entry_id=NEW.journal_entry_id;
 IF NEW.amount::numeric<>expected OR n<>2 OR v<>expected
    OR NOT EXISTS(SELECT 1 FROM journal_lines WHERE entry_id=NEW.journal_entry_id AND account_id=(NEW.snapshot->>'expenseAccountId')::uuid AND debit_base=expected AND credit_base=0)
    OR NOT EXISTS(SELECT 1 FROM journal_lines WHERE entry_id=NEW.journal_entry_id AND account_id=(NEW.snapshot->>'accumulatedAccountId')::uuid AND credit_base=expected AND debit_base=0) THEN
   RAISE EXCEPTION 'Amortisman tutarı ve yevmiyesi kayıtlı hesaplama planıyla uyuşmuyor' USING ERRCODE='ERP19';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER asset_calculation_guard BEFORE INSERT ON asset_depreciation FOR EACH ROW EXECUTE FUNCTION asset_calculation_guard();
