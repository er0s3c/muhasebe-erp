-- =========================================================================
-- Fesihte kur/yuvarlama artığı kalmış kalem (kalan 0,00, defter tutarı > 0; örn. FIFO havuzundaki TL tahsilat dövizli taksidi
-- kuruşun altında bir farkla kapatmış). Artık defter para birimindeki bir cari satırıyla kapatılır; fesih kapatması kaydı kalem
-- para biriminde 0, defter tutarında artık kadardır.
--  * sales_writeoffs: kalem para birimindeki tutar 0 olabilir (defter tutarı yine > 0).
--  * Kapatılmış fiş koruması: yalnızca defter tutarı kapatılmış (kalem para biriminde 0) kalem de "kapatılmış" sayılır.
-- =========================================================================
ALTER TABLE "sales_writeoffs" DROP CONSTRAINT "sales_writeoffs_amount_ck";--> statement-breakpoint
ALTER TABLE "sales_writeoffs" ADD CONSTRAINT "sales_writeoffs_amount_ck" CHECK ("sales_writeoffs"."amount" >= 0 and "sales_writeoffs"."amount_base" > 0);--> statement-breakpoint

CREATE OR REPLACE FUNCTION journal_entries_settled_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF OLD.reversed_by_id IS NULL AND NEW.reversed_by_id IS NOT NULL THEN
    PERFORM 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id
     WHERE l.entry_id = OLD.id AND a.party_control IS NOT NULL
     ORDER BY l.id FOR UPDATE OF l;
    IF EXISTS (
      SELECT 1 FROM journal_lines l CROSS JOIN LATERAL charge_line_used(l.id) u
       WHERE l.entry_id = OLD.id
         AND (u.amount > 0 OR u.amount_base > 0)
    ) THEN
      RAISE EXCEPTION 'Bu fişin cari kalemi tahsilat/ödeme, çek/senet ya da fesihle kapatılmış; önce kapatan işlemi iptal edin'
        USING ERRCODE = 'ERP01';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
