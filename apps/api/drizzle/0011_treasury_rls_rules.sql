-- =========================================================================
-- Kasa ve banka: RLS, yetki, denetim izi, varsayılan eşlemeler ve iş kuralları.
-- Kasa/banka kuralları ERRCODE ERP05 ile yükselir (API'de 422 TREASURY_RULE_VIOLATION);
-- ERP01 defter, ERP02 stok, ERP03 fatura, ERP04 irsaliye kuralları içindir.
-- =========================================================================

-- 1) Satır düzeyinde güvenlik
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['treasury_accounts', 'treasury_transactions', 'party_allocations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- 2) Yetkiler (erp_app şema sahibi değildir). Hareketlerde silme yetkisi hiç yok; eşleştirmeler yalnızca eklenir.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON treasury_accounts, treasury_transactions TO erp_app;
    GRANT SELECT, INSERT ON party_allocations TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- 3) Denetim izi (eşleştirmeler değişmez kayıttır)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['treasury_accounts', 'treasury_transactions'] LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- 4) Mevcut şirketler için kambiyo kârı/zararı eşlemeleri (genel Tekdüzen yapıya dayanır, doğrulanmamıştır)
INSERT INTO account_mappings (id, company_id, key, account_id)
SELECT gen_random_uuid(), c.id, m.key, a.id
FROM companies c
CROSS JOIN (VALUES ('fx_gain', '646'), ('fx_loss', '656')) AS m(key, code)
JOIN accounts a ON a.company_id = c.id AND a.code = m.code
ON CONFLICT (company_id, key) DO NOTHING;
--> statement-breakpoint

-- 5) Kasa/banka hesabı: yalnızca 100.x/102.x yaprak hesabına ve uyumlu para birimine bağlanır;
--    tür, para birimi ve muhasebe hesabı sonradan değişmez; silinemez (pasifleştirilir).
CREATE FUNCTION treasury_accounts_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  a accounts%ROWTYPE;
  base text;
  prefix text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Kasa/banka hesabı silinemez; pasifleştirin' USING ERRCODE = 'ERP05';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.account_id <> OLD.account_id OR NEW.currency_code <> OLD.currency_code OR NEW.kind <> OLD.kind THEN
      RAISE EXCEPTION 'Kasa/banka hesabının türü, para birimi ve muhasebe hesabı değiştirilemez' USING ERRCODE = 'ERP05';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO a FROM accounts WHERE id = NEW.account_id AND company_id = NEW.company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Muhasebe hesabı bulunamadı' USING ERRCODE = 'ERP05';
  END IF;
  IF NEW.kind = 'cash' THEN
    prefix := '100';
  ELSE
    prefix := '102';
  END IF;
  IF a.code <> prefix AND a.code NOT LIKE prefix || '.%' THEN
    RAISE EXCEPTION 'Muhasebe hesabı % grubunda olmalı (%)', prefix, a.code USING ERRCODE = 'ERP05';
  END IF;
  IF NOT a.is_postable OR NOT a.is_active OR a.party_control IS NOT NULL THEN
    RAISE EXCEPTION 'Muhasebe hesabı kayıt atılabilir, aktif ve cari kontrol dışı olmalı (%)', a.code USING ERRCODE = 'ERP05';
  END IF;
  SELECT base_currency INTO base FROM companies WHERE id = NEW.company_id;
  IF coalesce(a.currency_code, base) <> NEW.currency_code THEN
    RAISE EXCEPTION 'Muhasebe hesabının para birimi (%) kasa/banka para birimiyle (%) uyuşmuyor',
      coalesce(a.currency_code, base), NEW.currency_code USING ERRCODE = 'ERP05';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER treasury_accounts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON treasury_accounts
  FOR EACH ROW EXECUTE FUNCTION treasury_accounts_guard();
--> statement-breakpoint

-- 6) Kasa/banka hareketi: silinemez; kaydedilmiş hareket yalnızca iptal alanlarıyla değişir; kaydedilirken
--    yevmiye kaynağı, tarih ve kasa/banka tutarları hareketle tutarlı olmalı; iptal yevmiyesi ters kayıt olmalı.
CREATE FUNCTION treasury_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  je journal_entries%ROWTYPE;
  ta treasury_accounts%ROWTYPE;
  tb treasury_accounts%ROWTYPE;
  gl_sum numeric;
  gl_sum2 numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Kasa/banka hareketi silinemez; iptal edin' USING ERRCODE = 'ERP05';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'cancelled' THEN
      RAISE EXCEPTION 'İptal edilmiş hareket değiştirilemez' USING ERRCODE = 'ERP05';
    END IF;
    IF NEW.status <> 'cancelled'
       OR (to_jsonb(NEW) - 'status' - 'cancelled_at' - 'cancelled_by' - 'cancel_reason' - 'cancel_journal_entry_id')
          IS DISTINCT FROM
          (to_jsonb(OLD) - 'status' - 'cancelled_at' - 'cancelled_by' - 'cancel_reason' - 'cancel_journal_entry_id') THEN
      RAISE EXCEPTION 'Kaydedilmiş hareket değiştirilemez; iptal edin' USING ERRCODE = 'ERP05';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM journal_entries r
       WHERE r.id = NEW.cancel_journal_entry_id AND r.company_id = NEW.company_id
         AND r.reversal_of_id = OLD.journal_entry_id AND r.status = 'posted'
    ) THEN
      RAISE EXCEPTION 'İptal yevmiyesi, hareketin yevmiyesinin ters kaydı olmalı' USING ERRCODE = 'ERP05';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT
  IF NEW.status <> 'posted' THEN
    RAISE EXCEPTION 'Hareket kaydedilmiş olarak oluşturulmalı' USING ERRCODE = 'ERP05';
  END IF;
  SELECT * INTO je FROM journal_entries WHERE id = NEW.journal_entry_id AND company_id = NEW.company_id;
  IF NOT FOUND OR je.status <> 'posted' OR je.source_type IS DISTINCT FROM 'treasury'
     OR je.source_id IS DISTINCT FROM NEW.id OR je.entry_date <> NEW.txn_date THEN
    RAISE EXCEPTION 'Hareketin yevmiyesi bulunamadı veya bu harekete ait değil' USING ERRCODE = 'ERP05';
  END IF;

  SELECT * INTO ta FROM treasury_accounts WHERE id = NEW.account_id AND company_id = NEW.company_id;
  IF NOT FOUND OR NOT ta.is_active OR ta.currency_code <> NEW.currency_code THEN
    RAISE EXCEPTION 'Kasa/banka hesabı geçersiz, pasif ya da para birimi uyuşmuyor' USING ERRCODE = 'ERP05';
  END IF;
  SELECT coalesce(sum(l.debit + l.credit), 0) INTO gl_sum
    FROM journal_lines l WHERE l.entry_id = NEW.journal_entry_id AND l.account_id = ta.account_id;
  IF gl_sum <> NEW.amount THEN
    RAISE EXCEPTION 'Hareket tutarı (%) yevmiyedeki kasa/banka tutarıyla (%) uyuşmuyor', NEW.amount, gl_sum
      USING ERRCODE = 'ERP05';
  END IF;

  IF NEW.type IN ('transfer', 'exchange') THEN
    SELECT * INTO tb FROM treasury_accounts WHERE id = NEW.to_account_id AND company_id = NEW.company_id;
    IF NOT FOUND OR NOT tb.is_active THEN
      RAISE EXCEPTION 'Hedef kasa/banka hesabı geçersiz veya pasif' USING ERRCODE = 'ERP05';
    END IF;
    SELECT coalesce(sum(l.debit + l.credit), 0) INTO gl_sum2
      FROM journal_lines l WHERE l.entry_id = NEW.journal_entry_id AND l.account_id = tb.account_id;
    IF NEW.type = 'transfer' THEN
      IF tb.currency_code <> NEW.currency_code OR gl_sum2 <> NEW.amount THEN
        RAISE EXCEPTION 'Virman aynı para biriminde ve aynı tutarda olmalı' USING ERRCODE = 'ERP05';
      END IF;
    ELSE
      IF tb.currency_code = NEW.currency_code OR NEW.counter_amount IS NULL OR gl_sum2 <> NEW.counter_amount THEN
        RAISE EXCEPTION 'Döviz işlemi farklı para birimleri ve yevmiyeyle tutarlı hedef tutar gerektirir'
          USING ERRCODE = 'ERP05';
      END IF;
    END IF;
  END IF;

  IF NEW.type IN ('receipt', 'payment') AND NEW.party_id IS NULL THEN
    RAISE EXCEPTION 'Tahsilat/ödemede cari zorunlu' USING ERRCODE = 'ERP05';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER treasury_transactions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON treasury_transactions
  FOR EACH ROW EXECUTE FUNCTION treasury_transactions_guard();
--> statement-breakpoint

-- 7) Cari eşleştirmesi: yalnızca eklenir; hareketin cari ve yevmiyesiyle, kalemin cari/kontrol hesabı/yönüyle
--    tutarlı olmalı; bir kalem için eşleştirilen toplam kalemi aşamaz (kalem satırı kilitlenir).
CREATE FUNCTION party_allocations_guard() RETURNS trigger LANGUAGE plpgsql AS
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
  used_amount numeric;
  used_base numeric;
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

  -- Aynı kaleme paralel eşleştirmeler sıraya girer
  SELECT * INTO ch FROM journal_lines WHERE id = NEW.charge_line_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Eşleştirilen kalem bulunamadı' USING ERRCODE = 'ERP05';
  END IF;
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

  SELECT coalesce(sum(a.amount), 0), coalesce(sum(a.amount_base), 0) INTO used_amount, used_base
    FROM party_allocations a JOIN treasury_transactions t ON t.id = a.transaction_id
   WHERE a.charge_line_id = NEW.charge_line_id AND t.status = 'posted';
  IF used_amount + NEW.amount > charge_amount OR used_base + NEW.amount_base > charge_base THEN
    RAISE EXCEPTION 'Kalem için eşleştirilen tutar kalemin tutarını aşıyor' USING ERRCODE = 'ERP05';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER party_allocations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON party_allocations
  FOR EACH ROW EXECUTE FUNCTION party_allocations_guard();
