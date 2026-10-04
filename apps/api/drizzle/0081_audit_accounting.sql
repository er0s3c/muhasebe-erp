-- =========================================================================
-- Denetim düzeltmeleri 2: muhasebe doğruluğu (ACC-1, ACC-2, ACC-3).
--  * Bir cari kalemin (fatura vb. borç/alacak satırı) tüm kapatmaları — kasa/banka eşleştirmesi (kaydedilmiş hareket),
--    çek/senet eşleştirmesi ve gayrimenkul fesih kapatması — TEK toplamda sayılır; toplam kalemi aşamaz (kalem satırı kilitlenir).
--  * Ters çevrilmiş (iptal edilmiş) belgenin kalemine eşleştirme yapılamaz; kapatılmış kalemi olan fiş ters çevrilemez
--    (önce tahsilat/ödeme iptal edilir). Fatura iptalindeki "ödenmiş fatura iptali" açığı veritabanında da kapanır.
--  * Aynı para biriminde kapatılan tutar (settle_amount) kalemden kapatılan tutara eşit olmalıdır: kur farkı yalnızca kur
--    ayrımından doğar, eksik/fazla ödeme kur farkı olarak yazılamaz.
-- =========================================================================

-- Bir kalemin etkin kapatma toplamı (kalem para biriminde ve defter tutarı). Çağıran kalem satırını kilitlemiş olmalıdır.
CREATE FUNCTION charge_line_used(p_line uuid, OUT amount numeric, OUT amount_base numeric)
  LANGUAGE sql STABLE AS
$$
  SELECT coalesce(sum(x.amount), 0), coalesce(sum(x.amount_base), 0)
    FROM (
      SELECT a.amount, a.amount_base
        FROM party_allocations a JOIN treasury_transactions t ON t.id = a.transaction_id AND t.status = 'posted'
       WHERE a.charge_line_id = p_line
      UNION ALL
      SELECT a.amount, a.amount_base FROM cheque_allocations a WHERE a.charge_line_id = p_line
      UNION ALL
      SELECT w.amount, w.amount_base FROM sales_writeoffs w WHERE w.charge_line_id = p_line
    ) x
$$;
--> statement-breakpoint

-- Kalem satırının yevmiyesi kaydedilmiş ve ters çevrilmemiş olmalı (iptal edilen belgenin kalemi kapatılamaz).
CREATE FUNCTION assert_charge_line_live(p_line uuid, p_errcode text) RETURNS void LANGUAGE plpgsql AS
$$
BEGIN
  IF EXISTS (
    SELECT 1 FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.id = p_line AND (e.status <> 'posted' OR e.reversed_by_id IS NOT NULL OR e.reversal_of_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Kalem iptal edilmiş (ters çevrilmiş) bir belgeye ait; eşleştirilemez' USING ERRCODE = p_errcode;
  END IF;
END
$$;
--> statement-breakpoint

-- 1) Kasa/banka eşleştirmesi: çek/senet ve fesih kapatmaları da toplamda; aynı para biriminde tutar eşitliği; canlı kalem
CREATE OR REPLACE FUNCTION party_allocations_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  tx treasury_transactions%ROWTYPE;
  ch journal_lines%ROWTYPE;
  st journal_lines%ROWTYPE;
  ca accounts%ROWTYPE;
  sa accounts%ROWTYPE;
  charge_amount numeric;
  charge_base numeric;
  settle_amount numeric;
  settle_base numeric;
  used record;
  tcur text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Eşleştirme kayıtları değiştirilemez ve silinemez' USING ERRCODE = 'ERP05';
  END IF;

  SELECT * INTO tx FROM treasury_transactions WHERE id = NEW.transaction_id AND company_id = NEW.company_id;
  IF NOT FOUND OR tx.status <> 'posted' OR tx.party_id IS DISTINCT FROM NEW.party_id THEN
    RAISE EXCEPTION 'Eşleştirme kaydedilmiş bir tahsilat/ödemeye ve aynı cariye ait olmalı' USING ERRCODE = 'ERP05';
  END IF;
  IF NOT ((tx.type = 'receipt' AND NEW.control = 'receivable') OR (tx.type = 'payment' AND NEW.control = 'payable')) THEN
    RAISE EXCEPTION 'Eşleştirme türü hareket türüyle uyuşmuyor' USING ERRCODE = 'ERP05';
  END IF;

  -- Aynı kaleme paralel eşleştirmeler (kasa/banka, çek/senet, fesih, belge iptali) sıraya girer
  SELECT * INTO ch FROM journal_lines WHERE id = NEW.charge_line_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Eşleştirilen kalem bulunamadı' USING ERRCODE = 'ERP05';
  END IF;
  PERFORM assert_charge_line_live(ch.id, 'ERP05');
  SELECT * INTO st FROM journal_lines WHERE id = NEW.settle_line_id AND company_id = NEW.company_id;
  IF NOT FOUND OR st.entry_id <> tx.journal_entry_id THEN
    RAISE EXCEPTION 'Kapatan satır hareketin yevmiyesinde olmalı' USING ERRCODE = 'ERP05';
  END IF;

  SELECT * INTO ca FROM accounts WHERE id = ch.account_id AND company_id = NEW.company_id;
  SELECT * INTO sa FROM accounts WHERE id = st.account_id AND company_id = NEW.company_id;
  IF ca.party_control IS DISTINCT FROM NEW.control OR sa.party_control IS DISTINCT FROM NEW.control
     OR ch.party_id IS DISTINCT FROM NEW.party_id OR st.party_id IS DISTINCT FROM NEW.party_id THEN
    RAISE EXCEPTION 'Kalem ve kapatan satır aynı cari ve cari kontrol hesabında olmalı' USING ERRCODE = 'ERP05';
  END IF;

  IF NEW.control = 'receivable' THEN
    charge_amount := ch.debit;  charge_base := ch.debit_base;
    settle_amount := st.credit; settle_base := st.credit_base;
  ELSE
    charge_amount := ch.credit; charge_base := ch.credit_base;
    settle_amount := st.debit;  settle_base := st.debit_base;
  END IF;
  IF charge_amount <= 0 OR settle_amount <= 0 THEN
    RAISE EXCEPTION 'Kalem ya da kapatan satırın yönü yanlış' USING ERRCODE = 'ERP05';
  END IF;
  IF ch.currency_code <> st.currency_code OR settle_amount <> NEW.amount OR settle_base <> NEW.amount_base THEN
    RAISE EXCEPTION 'Eşleştirme kapatan satırın tutarıyla uyuşmuyor' USING ERRCODE = 'ERP05';
  END IF;
  SELECT currency_code INTO tcur FROM treasury_accounts WHERE id = tx.account_id;
  IF tcur = ch.currency_code AND NEW.settle_amount <> NEW.amount THEN
    RAISE EXCEPTION 'Aynı para biriminde kapatılan tutar ile karşılığı eşit olmalı (eksik/fazla ödeme kur farkı değildir)' USING ERRCODE = 'ERP05';
  END IF;

  used := charge_line_used(ch.id);
  IF used.amount + NEW.amount > charge_amount OR used.amount_base + NEW.amount_base > charge_base THEN
    RAISE EXCEPTION 'Kalem için eşleştirilen tutar kalemin tutarını aşıyor (kasa/banka, çek/senet ve fesih kapatmaları birlikte)' USING ERRCODE = 'ERP05';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- 2) Çek/senet eşleştirmesi: fesih kapatmaları da toplamda; aynı para biriminde tutar eşitliği; canlı kalem
CREATE OR REPLACE FUNCTION cheque_allocations_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  ev cheque_events%ROWTYPE;
  c cheques%ROWTYPE;
  ch journal_lines%ROWTYPE;
  st journal_lines%ROWTYPE;
  ca accounts%ROWTYPE;
  sa accounts%ROWTYPE;
  charge_amount numeric;
  charge_base numeric;
  settle_amount numeric;
  settle_base numeric;
  used record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Eşleştirme kayıtları değiştirilemez ve silinemez' USING ERRCODE = 'ERP14';
  END IF;

  SELECT * INTO ev FROM cheque_events WHERE id = NEW.event_id AND company_id = NEW.company_id;
  IF NOT FOUND OR ev.cheque_id <> NEW.cheque_id THEN
    RAISE EXCEPTION 'Eşleştirme belgenin olayına ait olmalı' USING ERRCODE = 'ERP14';
  END IF;
  SELECT * INTO c FROM cheques WHERE id = NEW.cheque_id AND company_id = NEW.company_id;
  IF NOT ((c.direction = 'received' AND ev.from_status IS NULL AND NEW.control = 'receivable')
       OR (c.direction = 'received' AND ev.to_status = 'endorsed' AND NEW.control = 'payable')
       OR (c.direction = 'issued' AND ev.from_status IS NULL AND NEW.control = 'payable')) THEN
    RAISE EXCEPTION 'Eşleştirme türü olayla uyuşmuyor (alınan kayıt: alacak, verilen kayıt ve ciro: borç)' USING ERRCODE = 'ERP14';
  END IF;

  SELECT * INTO ch FROM journal_lines WHERE id = NEW.charge_line_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Eşleştirilen kalem bulunamadı' USING ERRCODE = 'ERP14';
  END IF;
  PERFORM assert_charge_line_live(ch.id, 'ERP14');
  SELECT * INTO st FROM journal_lines WHERE id = NEW.settle_line_id AND company_id = NEW.company_id;
  IF NOT FOUND OR st.entry_id <> ev.entry_id THEN
    RAISE EXCEPTION 'Kapatan satır olayın yevmiyesinde olmalı' USING ERRCODE = 'ERP14';
  END IF;

  SELECT * INTO ca FROM accounts WHERE id = ch.account_id AND company_id = NEW.company_id;
  SELECT * INTO sa FROM accounts WHERE id = st.account_id AND company_id = NEW.company_id;
  IF ca.party_control IS DISTINCT FROM NEW.control OR sa.party_control IS DISTINCT FROM NEW.control
     OR ch.party_id IS DISTINCT FROM NEW.party_id OR st.party_id IS DISTINCT FROM NEW.party_id THEN
    RAISE EXCEPTION 'Kalem ve kapatan satır aynı cari ve cari kontrol hesabında olmalı' USING ERRCODE = 'ERP14';
  END IF;

  IF NEW.control = 'receivable' THEN
    charge_amount := ch.debit;  charge_base := ch.debit_base;
    settle_amount := st.credit; settle_base := st.credit_base;
  ELSE
    charge_amount := ch.credit; charge_base := ch.credit_base;
    settle_amount := st.debit;  settle_base := st.debit_base;
  END IF;
  IF charge_amount <= 0 OR settle_amount <= 0 THEN
    RAISE EXCEPTION 'Kalem ya da kapatan satırın yönü yanlış' USING ERRCODE = 'ERP14';
  END IF;
  IF ch.currency_code <> st.currency_code OR settle_amount <> NEW.amount OR settle_base <> NEW.amount_base THEN
    RAISE EXCEPTION 'Eşleştirme kapatan satırın tutarıyla uyuşmuyor' USING ERRCODE = 'ERP14';
  END IF;
  IF c.currency_code = ch.currency_code AND NEW.settle_amount <> NEW.amount THEN
    RAISE EXCEPTION 'Aynı para biriminde kapatılan tutar ile karşılığı eşit olmalı (eksik/fazla ödeme kur farkı değildir)' USING ERRCODE = 'ERP14';
  END IF;

  used := charge_line_used(ch.id);
  IF used.amount + NEW.amount > charge_amount OR used.amount_base + NEW.amount_base > charge_base THEN
    RAISE EXCEPTION 'Kalem için eşleştirilen tutar kalemin tutarını aşıyor (kasa/banka, çek/senet ve fesih kapatmaları birlikte)' USING ERRCODE = 'ERP14';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- 3) Fesih kapatması (sales_writeoffs): aynı toplam kuralı ve canlı kalem (mevcut değişmezlik tetikleyicisine ek)
CREATE FUNCTION sales_writeoffs_alloc_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  ch journal_lines%ROWTYPE;
  used record;
BEGIN
  SELECT * INTO ch FROM journal_lines WHERE id = NEW.charge_line_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kapatılan kalem bulunamadı' USING ERRCODE = 'ERP12';
  END IF;
  PERFORM assert_charge_line_live(ch.id, 'ERP12');
  used := charge_line_used(ch.id);
  IF ch.debit <= 0 OR used.amount + NEW.amount > ch.debit OR used.amount_base + NEW.amount_base > ch.debit_base THEN
    RAISE EXCEPTION 'Fesih kapatması kalemin kalan tutarını aşıyor' USING ERRCODE = 'ERP12';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER sales_writeoffs_alloc_guard
  BEFORE INSERT ON sales_writeoffs
  FOR EACH ROW EXECUTE FUNCTION sales_writeoffs_alloc_guard();
--> statement-breakpoint

-- 4) Ters kayıt: kalemi (kasa/banka, çek/senet ya da fesihle) kapatılmış fiş ters çevrilemez (ör. tahsil edilmiş fatura iptali).
--    Kalem satırları kilitlenir: aynı anda yapılan eşleştirme ya bekler ya da burada görülür.
CREATE FUNCTION journal_entries_settled_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF OLD.reversed_by_id IS NULL AND NEW.reversed_by_id IS NOT NULL THEN
    PERFORM 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id
     WHERE l.entry_id = OLD.id AND a.party_control IS NOT NULL
     ORDER BY l.id FOR UPDATE OF l;
    IF EXISTS (
      SELECT 1 FROM journal_lines l
       WHERE l.entry_id = OLD.id
         AND ((charge_line_used(l.id)).amount > 0)
    ) THEN
      RAISE EXCEPTION 'Bu fişin cari kalemi tahsilat/ödeme, çek/senet ya da fesihle kapatılmış; önce kapatan işlemi iptal edin'
        USING ERRCODE = 'ERP01';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_settled_guard
  BEFORE UPDATE OF reversed_by_id ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_settled_guard();
