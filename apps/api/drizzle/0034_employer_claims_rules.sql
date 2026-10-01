-- =========================================================================
-- İşveren (alınan) hakedişi (Faz B2e): yönlü koruma fonksiyonları (CREATE OR REPLACE; payable davranışı değişmez),
-- yeni hesap eşlemelerinin mevcut şirketlere geri doldurulması (genel Tekdüzen yapıya dayanır, doğrulanmamıştır).
-- =========================================================================

INSERT INTO account_mappings (id, company_id, key, account_id)
SELECT gen_random_uuid(), c.id, m.key, a.id
FROM companies c
CROSS JOIN (VALUES
  ('claim_revenue', '600'),
  ('retention_receivable', '126'),
  ('advance_received', '340'),
  ('withholding_receivable', '193')
) AS m(key, code)
JOIN accounts a ON a.company_id = c.id AND a.code = m.code
ON CONFLICT (company_id, key) DO NOTHING;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION subcontracts_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  pr projects%ROWTYPE;
  pk text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' OR EXISTS (
         SELECT 1 FROM subcontract_revisions WHERE subcontract_id = OLD.id AND status <> 'draft') THEN
      RAISE EXCEPTION 'Yürürlüğe girmiş sözleşme silinemez' USING ERRCODE = 'ERP10';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR pr.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'Tamamlanmış veya iptal edilmiş projeye sözleşme eklenemez' USING ERRCODE = 'ERP10';
    END IF;
    SELECT kind INTO pk FROM parties WHERE id = NEW.party_id AND company_id = NEW.company_id;
    IF NEW.direction = 'receivable' THEN
      IF pk IS NULL OR pk = 'supplier' THEN
        RAISE EXCEPTION 'İşveren cari müşteri türünde olmalı' USING ERRCODE = 'ERP10';
      END IF;
      IF pr.kind <> 'contract' OR pr.client_party_id IS DISTINCT FROM NEW.party_id THEN
        RAISE EXCEPTION 'İşveren sözleşmesi yalnızca işverene yapılan iş projesinde ve proje işvereniyle yapılır' USING ERRCODE = 'ERP10';
      END IF;
    ELSIF pk IS NULL OR pk = 'customer' THEN
      RAISE EXCEPTION 'Taşeron cari tedarikçi türünde olmalı' USING ERRCODE = 'ERP10';
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Sözleşme taslak olarak açılır' USING ERRCODE = 'ERP10';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.code <> OLD.code OR NEW.project_id <> OLD.project_id OR NEW.party_id <> OLD.party_id OR NEW.currency_code <> OLD.currency_code OR NEW.direction <> OLD.direction THEN
    RAISE EXCEPTION 'Sözleşmenin kodu, projesi, taşeronu ve para birimi değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.retention_pct <> OLD.retention_pct OR NEW.advance_recoup_pct <> OLD.advance_recoup_pct OR NEW.withholding_pct <> OLD.withholding_pct) THEN
    RAISE EXCEPTION 'Yürürlükteki sözleşmenin kesinti yüzdeleri değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF OLD.status = 'draft' AND NEW.status = 'active' THEN
      IF NOT EXISTS (SELECT 1 FROM subcontract_revisions WHERE subcontract_id = NEW.id AND status = 'approved') THEN
        RAISE EXCEPTION 'Onaylı revizyonu olmayan sözleşme yürürlüğe giremez' USING ERRCODE = 'ERP10';
      END IF;
    ELSIF NOT (OLD.status = 'active' AND NEW.status IN ('completed', 'terminated')) THEN
      RAISE EXCEPTION 'Geçersiz sözleşme durum geçişi (% → %)', OLD.status, NEW.status USING ERRCODE = 'ERP10';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION progress_payments_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  sc subcontracts%ROWTYPE;
  je journal_entries%ROWTYPE;
  bad int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Taslak dışındaki hakediş silinemez' USING ERRCODE = 'ERP10';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO sc FROM subcontracts WHERE id = NEW.subcontract_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR sc.status <> 'active' THEN
      RAISE EXCEPTION 'Hakediş yalnızca yürürlükteki sözleşmeye girilir' USING ERRCODE = 'ERP10';
    END IF;
    IF NEW.currency_code <> sc.currency_code THEN
      RAISE EXCEPTION 'Hakediş sözleşmenin para biriminde olmalı' USING ERRCODE = 'ERP10';
    END IF;
    IF NEW.direction <> sc.direction THEN
      RAISE EXCEPTION 'Hakedişin yönü sözleşmeyle aynı olmalı' USING ERRCODE = 'ERP10';
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Hakediş taslak olarak açılır' USING ERRCODE = 'ERP10';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.subcontract_id <> OLD.subcontract_id OR NEW.project_id <> OLD.project_id OR NEW.payment_no <> OLD.payment_no
     OR NEW.currency_code <> OLD.currency_code OR NEW.direction <> OLD.direction OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Hakedişin sözleşmesi, sırası ve para birimi değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;

  -- Taslak ↔ onayda: tutarlar serbest, kayıt alanları boş kalmalı
  IF OLD.status IN ('draft', 'submitted') AND NEW.status IN ('draft', 'submitted') THEN
    IF NEW.status = 'submitted' AND OLD.status = 'submitted' THEN
      RAISE EXCEPTION 'Onaydaki hakediş değiştirilemez; geri çekin' USING ERRCODE = 'ERP10';
    END IF;
    IF NEW.number IS NOT NULL OR NEW.entry_id IS NOT NULL OR NEW.fx_rate IS NOT NULL OR NEW.posted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Kayıt alanları yalnızca kaydetme anında yazılır' USING ERRCODE = 'ERP10';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'submitted' AND NEW.status = 'posted' THEN
    IF (to_jsonb(NEW) - 'status' - 'number' - 'entry_id' - 'fx_rate' - 'posted_at')
       IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'number' - 'entry_id' - 'fx_rate' - 'posted_at') THEN
      RAISE EXCEPTION 'Kaydetme anında hakediş tutarları değiştirilemez' USING ERRCODE = 'ERP10';
    END IF;
    SELECT * INTO je FROM journal_entries WHERE id = NEW.entry_id AND company_id = NEW.company_id;
    IF NOT FOUND OR je.status <> 'posted' OR je.source_type IS DISTINCT FROM 'progress_payment' OR je.source_id IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'Hakedişin yevmiyesi kaydedilmiş ve kaynağı bu hakediş olmalı' USING ERRCODE = 'ERP10';
    END IF;
    -- Taşeron cari satırı net tutara (hakediş para biriminde) eşit olmalı
    IF NOT EXISTS (
      SELECT 1 FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.entry_id = NEW.entry_id AND jl.currency_code = NEW.currency_code
         AND ((NEW.direction = 'payable' AND a.party_control = 'payable' AND jl.credit = NEW.net)
           OR (NEW.direction = 'receivable' AND a.party_control = 'receivable' AND jl.debit = NEW.net))
    ) AND NEW.net > 0 THEN
      RAISE EXCEPTION 'Yevmiyedeki cari satırı net tutara eşit olmalı' USING ERRCODE = 'ERP10';
    END IF;
    -- Kümülatif miktar sözleşme miktarını aşamaz; önceki kümülatif, önceki kaydedilmiş hakedişlerin kümülatifidir
    SELECT count(*) INTO bad
      FROM progress_payment_lines l
      JOIN subcontract_revisions r ON r.subcontract_id = l.subcontract_id AND r.status = 'approved'
       AND r.revision_no = (SELECT max(r2.revision_no) FROM subcontract_revisions r2 WHERE r2.subcontract_id = l.subcontract_id AND r2.status = 'approved')
      JOIN subcontract_boq_lines b ON b.revision_id = r.id AND b.line_key = l.line_key
     WHERE l.payment_id = NEW.id AND l.cum_qty > b.quantity;
    IF bad > 0 THEN
      RAISE EXCEPTION 'Kümülatif miktar sözleşme miktarını aşamaz' USING ERRCODE = 'ERP10';
    END IF;
    SELECT count(*) INTO bad
      FROM progress_payment_lines l
     WHERE l.payment_id = NEW.id
       AND l.prev_qty <> coalesce((
         SELECT max(p.cum_qty) FROM progress_payment_lines p JOIN progress_payments pp ON pp.id = p.payment_id
          WHERE pp.subcontract_id = NEW.subcontract_id AND pp.status = 'posted' AND p.line_key = l.line_key), 0);
    IF bad > 0 THEN
      RAISE EXCEPTION 'Önceki kümülatif miktar değişmiş; hakediş yeniden hazırlanmalı' USING ERRCODE = 'ERP10';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status = 'cancelled' THEN
    IF (to_jsonb(NEW) - 'status' - 'cancelled_at' - 'cancel_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'cancelled_at' - 'cancel_reason') THEN
      RAISE EXCEPTION 'İptalde yalnızca iptal alanları yazılır' USING ERRCODE = 'ERP10';
    END IF;
    IF EXISTS (SELECT 1 FROM progress_payments p WHERE p.subcontract_id = NEW.subcontract_id AND p.status = 'posted' AND p.payment_no > NEW.payment_no) THEN
      RAISE EXCEPTION 'Yalnızca son kaydedilmiş hakediş iptal edilebilir' USING ERRCODE = 'ERP10';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = OLD.entry_id AND reversed_by_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Hakediş, yevmiyesi ters çevrilmeden iptal edilemez' USING ERRCODE = 'ERP10';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Geçersiz hakediş durum geçişi (% → %)', OLD.status, NEW.status USING ERRCODE = 'ERP10';
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION subcontract_advances_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  sc subcontracts%ROWTYPE;
  tx treasury_transactions%ROWTYPE;
  expected text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Verilen avans kaydı değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;
  SELECT * INTO sc FROM subcontracts WHERE id = NEW.subcontract_id AND company_id = NEW.company_id FOR SHARE;
  IF NOT FOUND OR sc.status <> 'active' THEN
    RAISE EXCEPTION 'Avans yalnızca yürürlükteki sözleşmeye verilir' USING ERRCODE = 'ERP10';
  END IF;
  SELECT * INTO tx FROM treasury_transactions WHERE id = NEW.transaction_id AND company_id = NEW.company_id;
  expected := 'other_payment';
  IF sc.direction = 'receivable' THEN
    expected := 'other_receipt';
  END IF;
  IF NOT FOUND OR tx.status <> 'posted' OR tx.type <> expected THEN
    RAISE EXCEPTION 'Avans, kaydedilmiş bir diğer ödeme (işverende diğer tahsilat) hareketine bağlı olmalı' USING ERRCODE = 'ERP10';
  END IF;
  RETURN NEW;
END
$$;
