CREATE OR REPLACE FUNCTION asset_depreciation_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref uuid;
BEGIN
 IF TG_OP='UPDATE' AND OLD.debit_reporting IS NULL AND OLD.credit_reporting IS NULL
    AND (to_jsonb(NEW)-'debit_reporting'-'credit_reporting')=(to_jsonb(OLD)-'debit_reporting'-'credit_reporting')
    AND NEW.debit_reporting IS NOT NULL AND NEW.credit_reporting IS NOT NULL THEN
   RETURN NEW;
 END IF;
 ref=CASE WHEN TG_OP='DELETE' THEN OLD.entry_id ELSE NEW.entry_id END;
 IF EXISTS(SELECT 1 FROM asset_depreciation WHERE journal_entry_id=ref) OR (TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM asset_depreciation WHERE journal_entry_id=OLD.entry_id)) THEN
   RAISE EXCEPTION 'Amortismanın hesaplanan satırları değiştirilemez; dönemden iptal edin' USING ERRCODE='ERP19';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
