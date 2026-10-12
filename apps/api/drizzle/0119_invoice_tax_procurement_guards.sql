-- Vergi kaynakları ve satır hesapları doğrulanmadan cari tutarı azaltılamaz.
CREATE FUNCTION invoice_tax_expected_payable(p invoices) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE
 l invoice_lines%ROWTYPE; src invoice_lines%ROWTYPE; r document_tax_rules%ROWTYPE;
 c jsonb; cfg jsonb; k text; amount_value numeric; vat_hold numeric; income_hold numeric; stamp_amount numeric;
 group_net numeric; group_gross numeric; group_stamp numeric; stamp_base numeric; allocated numeric; last_no int;
 previous_qty numeric; previous_vat numeric; previous_income numeric; previous_stamp numeric;
 has_tax boolean:=false; total_vat numeric:=0; total_income numeric:=0; total_stamp numeric:=0;
 base_vat numeric:=0; base_income numeric:=0; base_stamp numeric:=0; fx numeric:=coalesce(p.fx_rate,1);
 expected_doc numeric; expected_base numeric; party_status text; group_key jsonb;
BEGIN
 FOR l IN SELECT * FROM invoice_lines WHERE invoice_id=p.id AND company_id=p.company_id ORDER BY line_no LOOP
  IF l.tax_calculation IS NULL AND l.tax_rule_snapshot IS NULL AND l.tax_rule_id IS NULL THEN CONTINUE; END IF;
  has_tax:=true;
  IF l.tax_calculation IS NULL OR l.tax_rule_snapshot IS NULL OR l.tax_rule_id IS NULL THEN RAISE EXCEPTION 'Vergi kuralı, kaynak görüntüsü ve hesap birlikte bulunmalı' USING ERRCODE='ERP03'; END IF;
  c:=l.tax_calculation;cfg:=l.tax_rule_snapshot->'config';
  IF c->>'engineVersion' IS DISTINCT FROM 'document-tax-v1' OR c->>'direction' IS DISTINCT FROM 'normal' THEN RAISE EXCEPTION 'Belge vergi hesap sürümü geçersiz' USING ERRCODE='ERP03'; END IF;
  FOREACH k IN ARRAY ARRAY['netAmount','vat','grossAmount','vatWithheld','vatPayableToSeller','incomeWithheld','stamp','payableToSeller'] LOOP
   IF coalesce(c->>k,'')!~'^\d{1,15}(\.\d{1,2})?$' THEN RAISE EXCEPTION 'Vergi hesap tutarı geçersiz: %',k USING ERRCODE='ERP03'; END IF;
  END LOOP;
  IF (c->>'netAmount')::numeric IS DISTINCT FROM l.net OR (c->>'vat')::numeric IS DISTINCT FROM l.vat OR (c->>'grossAmount')::numeric IS DISTINCT FROM l.gross OR l.gross<>l.net+l.vat THEN RAISE EXCEPTION 'Vergi hesap tutarları fatura satırıyla uyuşmuyor' USING ERRCODE='ERP03'; END IF;
  IF c->'input'->>'netAmount' IS DISTINCT FROM to_char(l.net,'FM999999999999999990.00')
   OR (c->'input'->>'vatRatePct')::numeric IS DISTINCT FROM l.vat_rate
   OR c->'input'->>'jurisdiction' IS DISTINCT FROM l.tax_rule_snapshot->>'jurisdiction'
   OR c->'input'->>'rulePackVersion' IS DISTINCT FROM l.tax_rule_snapshot->>'version'
   OR c->'input'->'sourceRefs' IS DISTINCT FROM l.tax_rule_snapshot->'sourceRefs'
   OR c->'input'->'vatWithholding' IS DISTINCT FROM cfg->'vatWithholding'
   OR c->'input'->'incomeWithholding' IS DISTINCT FROM cfg->'incomeWithholding'
   OR c->'input'->'stamp' IS DISTINCT FROM cfg->'stamp' THEN RAISE EXCEPTION 'Vergi hesabının girdisi doğrulanmış kaynakla uyuşmuyor' USING ERRCODE='ERP03'; END IF;
  IF l.source_line_id IS NOT NULL THEN
   SELECT * INTO src FROM invoice_lines WHERE id=l.source_line_id AND invoice_id=p.return_of_id AND company_id=p.company_id;
   IF NOT FOUND OR src.tax_calculation IS NULL OR src.tax_rule_id IS DISTINCT FROM l.tax_rule_id OR src.tax_rule_snapshot IS DISTINCT FROM l.tax_rule_snapshot OR l.vat_rate IS DISTINCT FROM src.vat_rate OR l.vat_code IS DISTINCT FROM src.vat_code THEN RAISE EXCEPTION 'İade vergi kaynağı özgün satırla uyuşmuyor' USING ERRCODE='ERP03'; END IF;
   SELECT coalesce(sum(x.quantity),0),coalesce(sum((x.tax_calculation->>'vatWithheld')::numeric),0),coalesce(sum((x.tax_calculation->>'incomeWithheld')::numeric),0),coalesce(sum((x.tax_calculation->>'stamp')::numeric),0)
    INTO previous_qty,previous_vat,previous_income,previous_stamp FROM invoice_lines x JOIN invoices h ON h.id=x.invoice_id AND h.company_id=x.company_id
    WHERE x.source_line_id=src.id AND x.company_id=p.company_id AND ((h.status='posted' AND h.id<>p.id) OR (h.id=p.id AND x.line_no<l.line_no));
   IF l.quantity>src.quantity-previous_qty THEN RAISE EXCEPTION 'Vergi iadeleri özgün satır miktarını aşıyor' USING ERRCODE='ERP03'; END IF;
   IF l.quantity=src.quantity-previous_qty THEN
    vat_hold:=(src.tax_calculation->>'vatWithheld')::numeric-previous_vat;income_hold:=(src.tax_calculation->>'incomeWithheld')::numeric-previous_income;stamp_amount:=(src.tax_calculation->>'stamp')::numeric-previous_stamp;
   ELSE
    vat_hold:=round((src.tax_calculation->>'vatWithheld')::numeric*l.quantity/src.quantity,2);income_hold:=round((src.tax_calculation->>'incomeWithheld')::numeric*l.quantity/src.quantity,2);stamp_amount:=round((src.tax_calculation->>'stamp')::numeric*l.quantity/src.quantity,2);
   END IF;
  ELSE
   SELECT * INTO r FROM document_tax_rules WHERE id=l.tax_rule_id AND company_id=p.company_id;
   SELECT tax_status INTO party_status FROM parties WHERE id=p.party_id AND company_id=p.company_id;
   IF NOT FOUND OR NOT r.enabled OR r.verified_at IS NULL OR r.verified_by IS NULL OR p.invoice_date<r.valid_from OR (r.valid_to IS NOT NULL AND p.invoice_date>r.valid_to)
    OR r.jurisdiction IS DISTINCT FROM p.legal_profile_snapshot->>'jurisdiction' OR r.invoice_type IS DISTINCT FROM p.type OR r.party_tax_status IS DISTINCT FROM party_status
    OR r.product_class IS DISTINCT FROM l.product_class OR r.transaction_type IS DISTINCT FROM l.transaction_type
    OR l.tax_rule_snapshot->>'id' IS DISTINCT FROM r.id::text OR cfg IS DISTINCT FROM r.config OR l.tax_rule_snapshot->>'version' IS DISTINCT FROM r.version
    OR l.tax_rule_snapshot->>'jurisdiction' IS DISTINCT FROM r.jurisdiction OR l.tax_rule_snapshot->'sourceRefs' IS DISTINCT FROM r.source_refs
    OR l.tax_rule_snapshot->>'productClass' IS DISTINCT FROM r.product_class OR l.tax_rule_snapshot->>'transactionType' IS DISTINCT FROM r.transaction_type
    OR l.tax_rule_snapshot->>'partyTaxStatus' IS DISTINCT FROM r.party_tax_status OR l.tax_rule_snapshot->>'invoiceType' IS DISTINCT FROM r.invoice_type
    OR l.tax_rule_snapshot->>'verifiedBy' IS DISTINCT FROM r.verified_by OR (l.tax_rule_snapshot->>'verifiedAt')::timestamptz IS DISTINCT FROM r.verified_at THEN RAISE EXCEPTION 'Belge vergisi tarihli doğrulanmış kuralla uyuşmuyor' USING ERRCODE='ERP03'; END IF;
   IF l.tax_treatment IS DISTINCT FROM cfg->>'taxTreatment' OR l.vat_code IS DISTINCT FROM cfg->>'vatCode' THEN RAISE EXCEPTION 'KDV işlemi vergi kuralıyla uyuşmuyor' USING ERRCODE='ERP03'; END IF;
   IF cfg->>'taxTreatment'='exempt' THEN
    IF l.vat<>0 OR l.vat_rate<>0 THEN RAISE EXCEPTION 'İstisna satırında KDV olamaz' USING ERRCODE='ERP03'; END IF;
   ELSE
    IF NOT EXISTS(SELECT 1 FROM tax_rates t WHERE t.company_id=p.company_id AND t.code=l.vat_code AND t.jurisdiction=r.jurisdiction AND t.valid_from<=p.invoice_date AND (t.valid_to IS NULL OR t.valid_to>=p.invoice_date) AND t.rate=l.vat_rate) THEN RAISE EXCEPTION 'KDV oranı tarihli şirket kaynağına ait değil' USING ERRCODE='ERP03'; END IF;
   END IF;
   IF l.vat<>round(l.net*l.vat_rate/100,2) THEN RAISE EXCEPTION 'KDV hesap aritmetiği uyuşmuyor' USING ERRCODE='ERP03'; END IF;
   vat_hold:=CASE WHEN cfg->'vatWithholding' IS NULL OR cfg->'vatWithholding'='null'::jsonb THEN 0 ELSE round(l.vat*(cfg->'vatWithholding'->>'numerator')::numeric/(cfg->'vatWithholding'->>'denominator')::numeric,2) END;
   income_hold:=CASE WHEN cfg->'incomeWithholding' IS NULL OR cfg->'incomeWithholding'='null'::jsonb THEN 0 ELSE round((CASE WHEN cfg->'incomeWithholding'->>'basis'='gross' THEN l.gross ELSE l.net END)*(cfg->'incomeWithholding'->>'ratePct')::numeric/100,2) END;
   stamp_amount:=0;
   IF cfg->'stamp' IS NOT NULL AND cfg->'stamp'<>'null'::jsonb THEN
    group_net:=l.net;group_gross:=l.gross;
    IF coalesce(cfg->>'stampScope','document')='document' THEN
     group_key:=jsonb_build_array(r.jurisdiction,r.version,r.source_refs,cfg->'stamp',cfg->'stampLiability');
     SELECT coalesce(sum(x.net),0),coalesce(sum(x.gross),0),max(x.line_no) INTO group_net,group_gross,last_no FROM invoice_lines x
      WHERE x.invoice_id=p.id AND x.company_id=p.company_id AND x.source_line_id IS NULL AND x.tax_rule_snapshot IS NOT NULL
       AND coalesce(x.tax_rule_snapshot->'config'->>'stampScope','document')='document'
       AND jsonb_build_array(x.tax_rule_snapshot->>'jurisdiction',x.tax_rule_snapshot->>'version',x.tax_rule_snapshot->'sourceRefs',x.tax_rule_snapshot->'config'->'stamp',x.tax_rule_snapshot->'config'->'stampLiability')=group_key;
    END IF;
    IF cfg->'stamp'->>'kind'='fixed' THEN group_stamp:=round((cfg->'stamp'->>'amount')::numeric,2);
    ELSE
     stamp_base:=greatest(0,(CASE WHEN cfg->'stamp'->>'basis'='gross' THEN group_gross ELSE group_net END)-(cfg->'stamp'->>'exemptAmount')::numeric);
     group_stamp:=round(stamp_base*(cfg->'stamp'->>'ratePct')::numeric/100,2);
     IF cfg->'stamp'->>'capAmount' IS NOT NULL THEN group_stamp:=least(group_stamp,(cfg->'stamp'->>'capAmount')::numeric); END IF;
    END IF;
    stamp_amount:=group_stamp;
    IF coalesce(cfg->>'stampScope','document')='document' THEN
     IF c->'stampAllocation'->>'basis' IS DISTINCT FROM 'document' OR (c->'stampAllocation'->>'documentNet')::numeric IS DISTINCT FROM group_net OR (c->'stampAllocation'->>'documentGross')::numeric IS DISTINCT FROM group_gross OR (c->'stampAllocation'->>'documentStamp')::numeric IS DISTINCT FROM group_stamp THEN RAISE EXCEPTION 'Belge damga matrahı ve tavanı uyuşmuyor' USING ERRCODE='ERP03'; END IF;
     IF l.line_no=last_no THEN
      SELECT coalesce(sum(CASE WHEN group_net=0 THEN 0 ELSE round(group_stamp*x.net/group_net,2) END),0) INTO allocated FROM invoice_lines x
       WHERE x.invoice_id=p.id AND x.company_id=p.company_id AND x.source_line_id IS NULL AND x.line_no<last_no AND x.tax_rule_snapshot IS NOT NULL
        AND coalesce(x.tax_rule_snapshot->'config'->>'stampScope','document')='document'
        AND jsonb_build_array(x.tax_rule_snapshot->>'jurisdiction',x.tax_rule_snapshot->>'version',x.tax_rule_snapshot->'sourceRefs',x.tax_rule_snapshot->'config'->'stamp',x.tax_rule_snapshot->'config'->'stampLiability')=group_key;
      stamp_amount:=group_stamp-allocated;
     ELSE stamp_amount:=CASE WHEN group_net=0 THEN 0 ELSE round(group_stamp*l.net/group_net,2) END; END IF;
    END IF;
   END IF;
  END IF;
  IF (c->>'vatWithheld')::numeric IS DISTINCT FROM vat_hold OR (c->>'incomeWithheld')::numeric IS DISTINCT FROM income_hold OR (c->>'stamp')::numeric IS DISTINCT FROM stamp_amount
   OR (c->>'vatPayableToSeller')::numeric IS DISTINCT FROM l.vat-vat_hold OR (c->>'payableToSeller')::numeric IS DISTINCT FROM l.gross-vat_hold-income_hold OR l.gross-vat_hold-income_hold<0 THEN RAISE EXCEPTION 'Vergi kesintisi veya ödenecek tutar aritmetiği uyuşmuyor' USING ERRCODE='ERP03'; END IF;
  total_vat:=total_vat+vat_hold;total_income:=total_income+income_hold;total_stamp:=total_stamp+stamp_amount;
  base_vat:=base_vat+round(vat_hold*fx,2);base_income:=base_income+round(income_hold*fx,2);base_stamp:=base_stamp+round(stamp_amount*fx,2);
 END LOOP;
 IF NOT has_tax THEN
  IF p.tax_totals_snapshot IS NOT NULL THEN RAISE EXCEPTION 'Kaynak vergi satırı olmadan toplam vergi görüntüsü yazılamaz' USING ERRCODE='ERP03'; END IF;
  RETURN p.gross_total_base;
 END IF;
 expected_doc:=p.gross_total-total_vat-total_income;expected_base:=p.gross_total_base-base_vat-base_income;
 IF p.tax_totals_snapshot IS NULL OR p.tax_totals_snapshot->>'engineVersion' IS DISTINCT FROM 'document-tax-v1' THEN RAISE EXCEPTION 'Belge vergi toplam görüntüsü gerekli' USING ERRCODE='ERP03'; END IF;
 FOREACH k IN ARRAY ARRAY['vatWithheld','incomeWithheld','stamp','payableToSeller','vatWithheldBase','incomeWithheldBase','stampBase','payableToSellerBase'] LOOP
  IF coalesce(p.tax_totals_snapshot->>k,'')!~'^\d{1,15}(\.\d{1,2})?$' THEN RAISE EXCEPTION 'Belge vergi toplamı geçersiz: %',k USING ERRCODE='ERP03'; END IF;
 END LOOP;
 IF (p.tax_totals_snapshot->>'vatWithheld')::numeric IS DISTINCT FROM total_vat OR (p.tax_totals_snapshot->>'incomeWithheld')::numeric IS DISTINCT FROM total_income OR (p.tax_totals_snapshot->>'stamp')::numeric IS DISTINCT FROM total_stamp
  OR (p.tax_totals_snapshot->>'payableToSeller')::numeric IS DISTINCT FROM expected_doc OR (p.tax_totals_snapshot->>'vatWithheldBase')::numeric IS DISTINCT FROM base_vat OR (p.tax_totals_snapshot->>'incomeWithheldBase')::numeric IS DISTINCT FROM base_income OR (p.tax_totals_snapshot->>'stampBase')::numeric IS DISTINCT FROM base_stamp OR (p.tax_totals_snapshot->>'payableToSellerBase')::numeric IS DISTINCT FROM expected_base THEN RAISE EXCEPTION 'Belge vergi toplamları satır ve kur hesaplarıyla uyuşmuyor' USING ERRCODE='ERP03'; END IF;
 SELECT coalesce(sum(round(net*fx,2)+round(vat*fx,2)),0) INTO amount_value FROM invoice_lines WHERE invoice_id=p.id AND company_id=p.company_id;
 IF amount_value IS DISTINCT FROM p.gross_total_base THEN RAISE EXCEPTION 'Vergili fatura defter tutarı satır kur toplamıyla uyuşmuyor' USING ERRCODE='ERP03'; END IF;
 RETURN expected_base;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION invoices_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  l_net numeric;
  l_vat numeric;
  l_gross numeric;
  l_count int;
  party_base numeric;
  expected_party_base numeric;
  je journal_entries%ROWTYPE;
  so_id uuid;
  u record;
  so_qty numeric;
  so_goods boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Fatura önce taslak olarak oluşturulmalı' USING ERRCODE = 'ERP03';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Kaydedilmiş fatura silinemez; iptal edin' USING ERRCODE = 'ERP03';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'İptal edilmiş fatura değiştirilemez' USING ERRCODE = 'ERP03';
  END IF;

  IF OLD.status = 'posted' THEN
    IF NEW.status <> 'cancelled'
       OR (to_jsonb(NEW) - 'status' - 'updated_at' - 'cancelled_at' - 'cancelled_by' - 'cancel_reason'
                         - 'cancel_journal_entry_id' - 'cancel_stock_document_id')
          IS DISTINCT FROM
          (to_jsonb(OLD) - 'status' - 'updated_at' - 'cancelled_at' - 'cancelled_by' - 'cancel_reason'
                         - 'cancel_journal_entry_id' - 'cancel_stock_document_id') THEN
      RAISE EXCEPTION 'Kaydedilmiş fatura değiştirilemez; iptal edin' USING ERRCODE = 'ERP03';
    END IF;
    RETURN NEW;
  END IF;

  -- OLD.status = 'draft'
  IF NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'Taslak fatura iptal edilemez; silin' USING ERRCODE = 'ERP03';
  END IF;
  IF NEW.type <> OLD.type THEN
    RAISE EXCEPTION 'Fatura türü değiştirilemez' USING ERRCODE = 'ERP03';
  END IF;

  IF NEW.status = 'posted' THEN
    SELECT count(*), coalesce(sum(net), 0), coalesce(sum(vat), 0), coalesce(sum(gross), 0)
      INTO l_count, l_net, l_vat, l_gross
      FROM invoice_lines WHERE invoice_id = NEW.id;
    IF l_count = 0 THEN
      RAISE EXCEPTION 'Faturada satır yok' USING ERRCODE = 'ERP03';
    END IF;
    IF l_net <> NEW.net_total OR l_vat <> NEW.vat_total OR l_gross <> NEW.gross_total THEN
      RAISE EXCEPTION 'Fatura toplamları satır toplamlarıyla uyuşmuyor' USING ERRCODE = 'ERP03';
    END IF;
    IF NEW.gross_total = 0 THEN
      RAISE EXCEPTION 'Fatura tutarı sıfır olamaz' USING ERRCODE = 'ERP03';
    END IF;

    SELECT * INTO je FROM journal_entries WHERE id = NEW.journal_entry_id AND company_id = NEW.company_id;
    IF NOT FOUND OR je.status <> 'posted' OR je.source_type IS DISTINCT FROM 'invoice' OR je.source_id IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'Fatura yevmiyesi bulunamadı veya bu faturaya ait değil' USING ERRCODE = 'ERP03';
    END IF;
    expected_party_base := invoice_tax_expected_payable(NEW);
    SELECT coalesce(sum(l.debit_base + l.credit_base),0) INTO party_base FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.entry_id=NEW.journal_entry_id AND a.party_control IS NOT NULL;
    IF party_base IS DISTINCT FROM expected_party_base THEN RAISE EXCEPTION 'Cari defter tutarı (%) doğrulanmış ödenecek tutarla (%) uyuşmuyor',party_base,expected_party_base USING ERRCODE='ERP03'; END IF;
    IF EXISTS(SELECT 1 FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.entry_id=NEW.journal_entry_id AND a.party_control IS NOT NULL AND (l.party_id IS DISTINCT FROM NEW.party_id OR l.currency_code IS DISTINCT FROM NEW.currency_code OR a.party_control IS DISTINCT FROM (CASE WHEN NEW.type IN ('sales','sales_return') THEN 'receivable' ELSE 'payable' END) OR (CASE WHEN NEW.type IN ('sales','purchase_return') THEN l.credit_base ELSE l.debit_base END)<>0)) THEN RAISE EXCEPTION 'Faturanın cari yevmiyesi taraf, yön veya para birimiyle uyuşmuyor' USING ERRCODE='ERP03'; END IF;
    SELECT coalesce(sum(l.debit+l.credit),0) INTO party_base FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.entry_id=NEW.journal_entry_id AND a.party_control IS NOT NULL;
    IF party_base IS DISTINCT FROM coalesce((NEW.tax_totals_snapshot->>'payableToSeller')::numeric,NEW.gross_total) THEN RAISE EXCEPTION 'Cari belge tutarı doğrulanmış ödenecek tutarla uyuşmuyor' USING ERRCODE='ERP03'; END IF;

    -- İrsaliyeye bağlı satırlar (satış/alış irsaliyesi ya da iade irsaliyesi → aynı türde fatura)
    IF EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = NEW.id AND delivery_line_id IS NOT NULL) THEN
      IF NEW.type = 'expense' THEN
        RAISE EXCEPTION 'İrsaliye bağı gider faturasında kullanılamaz' USING ERRCODE = 'ERP03';
      END IF;
      -- Aynı irsaliye satırına paralel faturalama ve irsaliye iptali sıraya girer
      PERFORM 1 FROM delivery_note_lines
       WHERE id IN (SELECT delivery_line_id FROM invoice_lines WHERE invoice_id = NEW.id AND delivery_line_id IS NOT NULL)
       ORDER BY id FOR UPDATE;
      IF EXISTS (
        SELECT 1
          FROM invoice_lines il
          JOIN delivery_note_lines dl ON dl.id = il.delivery_line_id
          JOIN delivery_notes n ON n.id = dl.note_id
         WHERE il.invoice_id = NEW.id
           AND (n.status <> 'posted' OR n.party_id <> NEW.party_id OR n.type <> NEW.type
                OR dl.item_id IS DISTINCT FROM il.item_id)
      ) THEN
        RAISE EXCEPTION 'İrsaliye bağı geçersiz: irsaliye kaydedilmiş, aynı cari, aynı yön ve aynı kart olmalı'
          USING ERRCODE = 'ERP03';
      END IF;
      IF EXISTS (
        SELECT 1 FROM invoice_lines WHERE invoice_id = NEW.id AND delivery_line_id IS NOT NULL
           AND (delivery_value IS NULL OR delivery_adjust IS NULL)
      ) THEN
        RAISE EXCEPTION 'Bağlı fatura satırının irsaliye payı yazılmamış' USING ERRCODE = 'ERP03';
      END IF;
      IF EXISTS (
        SELECT 1 FROM delivery_note_lines dl
         WHERE dl.id IN (SELECT delivery_line_id FROM invoice_lines WHERE invoice_id = NEW.id AND delivery_line_id IS NOT NULL)
           AND dl.quantity < (
             SELECT coalesce(sum(x.quantity), 0)
               FROM invoice_lines x JOIN invoices xi ON xi.id = x.invoice_id
              WHERE x.delivery_line_id = dl.id AND (xi.status = 'posted' OR xi.id = NEW.id))
      ) THEN
        RAISE EXCEPTION 'İrsaliye satırı için faturalanan miktar irsaliye miktarını aşıyor' USING ERRCODE = 'ERP03';
      END IF;
    END IF;

    -- Satış siparişine bağlı satırlar
    IF EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = NEW.id AND sales_order_line_id IS NOT NULL) THEN
      IF NEW.type <> 'sales' THEN
        RAISE EXCEPTION 'Sipariş bağı yalnızca satış faturasında kullanılır' USING ERRCODE = 'ERP03';
      END IF;
      PERFORM 1 FROM sales_order_lines
       WHERE id IN (SELECT sales_order_line_id FROM invoice_lines WHERE invoice_id = NEW.id AND sales_order_line_id IS NOT NULL)
       ORDER BY id FOR UPDATE;
      IF EXISTS (
        SELECT 1
          FROM invoice_lines il
          JOIN sales_order_lines ol ON ol.id = il.sales_order_line_id
          JOIN sales_orders o ON o.id = ol.order_id
         WHERE il.invoice_id = NEW.id
           AND (o.kind <> 'order' OR o.status NOT IN ('confirmed', 'closed') OR o.party_id <> NEW.party_id
                OR ol.item_id IS DISTINCT FROM il.item_id)
      ) THEN
        RAISE EXCEPTION 'Sipariş bağı geçersiz: onaylı sipariş, aynı cari ve aynı kart olmalı' USING ERRCODE = 'ERP03';
      END IF;
      FOR so_id IN
        SELECT DISTINCT sales_order_line_id FROM invoice_lines WHERE invoice_id = NEW.id AND sales_order_line_id IS NOT NULL
      LOOP
        SELECT * INTO u FROM sales_order_line_usage(so_id, NULL, NEW.id);
        SELECT ol.quantity, coalesce(it.kind = 'goods', false) INTO so_qty, so_goods
          FROM sales_order_lines ol LEFT JOIN items it ON it.id = ol.item_id WHERE ol.id = so_id;
        IF so_qty < u.invoiced THEN
          RAISE EXCEPTION 'Sipariş satırı için faturalanan miktar sipariş miktarını aşıyor' USING ERRCODE = 'ERP03';
        END IF;
        IF so_goods AND so_qty < u.delivered + u.direct THEN
          RAISE EXCEPTION 'Sipariş satırı için teslim edilen ve doğrudan faturalanan miktar sipariş miktarını aşıyor' USING ERRCODE = 'ERP03';
        END IF;
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION purchase_requests_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  pr projects%ROWTYPE;
  company_sector text;
  ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'Taslak dışındaki satın alma talebi silinemez' USING ERRCODE = 'ERP11';
    END IF;
    RETURN OLD;
  END IF;
  SELECT sector INTO company_sector FROM companies WHERE id = NEW.company_id;
  IF company_sector IS NULL OR company_sector NOT IN ('CONSTRUCTION','LEATHER_FASHION','MANUFACTURING_WHOLESALE','COMMERCE','RETAIL_MARKET','COMMERCE','RETAIL_MARKET')
     OR (company_sector IN ('LEATHER_FASHION','MANUFACTURING_WHOLESALE','COMMERCE','RETAIL_MARKET') AND NEW.project_id IS NOT NULL)
     OR (company_sector = 'CONSTRUCTION' AND NEW.project_id IS NULL) THEN
    RAISE EXCEPTION 'Satın alma proje bağlamı şirketin sektörüne uymuyor' USING ERRCODE = 'ERP11';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.project_id IS NOT NULL THEN
    SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR pr.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'Tamamlanmış veya iptal edilmiş projeye talep açılamaz' USING ERRCODE = 'ERP11';
    END IF;
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Talep taslak olarak açılır' USING ERRCODE = 'ERP11';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.code <> OLD.code OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'Talebin kodu ve projesi değiştirilemez' USING ERRCODE = 'ERP11';
  END IF;
  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'draft' AND OLD.status <> 'rejected'
       AND (to_jsonb(NEW) - 'rejection_note') IS DISTINCT FROM (to_jsonb(OLD) - 'rejection_note') THEN
      RAISE EXCEPTION 'Taslak dışındaki talep değiştirilemez' USING ERRCODE = 'ERP11';
    END IF;
    RETURN NEW;
  END IF;
  ok := (OLD.status = 'draft' AND NEW.status IN ('submitted', 'cancelled'))
     OR (OLD.status = 'submitted' AND NEW.status IN ('draft', 'approved', 'rejected'))
     OR (OLD.status = 'rejected' AND NEW.status IN ('draft', 'cancelled'))
     OR (OLD.status = 'approved' AND NEW.status IN ('ordered', 'cancelled'))
     OR (OLD.status = 'ordered' AND NEW.status = 'approved');
  IF NOT ok THEN
    RAISE EXCEPTION 'Geçersiz talep durum geçişi (% → %)', OLD.status, NEW.status USING ERRCODE = 'ERP11';
  END IF;
  IF NEW.status = 'submitted' AND NOT EXISTS (SELECT 1 FROM purchase_request_lines WHERE request_id = NEW.id) THEN
    RAISE EXCEPTION 'Satırsız talep onaya gönderilemez' USING ERRCODE = 'ERP11';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION purchase_orders_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  pr projects%ROWTYPE;
  company_sector text;
  pk text;
  rq purchase_requests%ROWTYPE;
  ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Taslak dışındaki sipariş silinemez; iptal edilir' USING ERRCODE = 'ERP11';
    END IF;
    RETURN OLD;
  END IF;
  SELECT sector INTO company_sector FROM companies WHERE id = NEW.company_id;
  IF company_sector IS NULL OR company_sector NOT IN ('CONSTRUCTION','LEATHER_FASHION','MANUFACTURING_WHOLESALE','COMMERCE','RETAIL_MARKET','COMMERCE','RETAIL_MARKET')
     OR (company_sector IN ('LEATHER_FASHION','MANUFACTURING_WHOLESALE','COMMERCE','RETAIL_MARKET') AND NEW.project_id IS NOT NULL)
     OR (company_sector = 'CONSTRUCTION' AND NEW.project_id IS NULL) THEN
    RAISE EXCEPTION 'Satın alma proje bağlamı şirketin sektörüne uymuyor' USING ERRCODE = 'ERP11';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.project_id IS NOT NULL THEN
    SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR pr.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'Tamamlanmış veya iptal edilmiş projeye sipariş açılamaz' USING ERRCODE = 'ERP11';
    END IF;
    END IF;
    SELECT kind INTO pk FROM parties WHERE id = NEW.party_id AND company_id = NEW.company_id;
    IF pk IS NULL OR pk = 'customer' THEN
      RAISE EXCEPTION 'Sipariş tedarikçi türünde bir cariye verilir' USING ERRCODE = 'ERP11';
    END IF;
    IF NEW.request_id IS NOT NULL THEN
      SELECT * INTO rq FROM purchase_requests WHERE id = NEW.request_id AND company_id = NEW.company_id;
      IF NOT FOUND OR rq.status NOT IN ('approved', 'ordered') OR rq.project_id IS DISTINCT FROM NEW.project_id THEN
        RAISE EXCEPTION 'Sipariş yalnızca aynı projenin onaylı talebinden oluşturulur' USING ERRCODE = 'ERP11';
      END IF;
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Sipariş taslak olarak açılır' USING ERRCODE = 'ERP11';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.code <> OLD.code OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.party_id <> OLD.party_id THEN
    RAISE EXCEPTION 'Siparişin kodu, projesi ve tedarikçisi değiştirilemez' USING ERRCODE = 'ERP11';
  END IF;
  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'draft'
       AND (to_jsonb(NEW) - 'cancel_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'cancel_reason') THEN
      RAISE EXCEPTION 'Taslak dışındaki sipariş değiştirilemez' USING ERRCODE = 'ERP11';
    END IF;
    RETURN NEW;
  END IF;
  ok := (OLD.status = 'draft' AND NEW.status IN ('issued', 'cancelled'))
     OR (OLD.status = 'issued' AND NEW.status IN ('closed', 'cancelled'))
     OR (OLD.status = 'closed' AND NEW.status = 'issued');
  IF NOT ok THEN
    RAISE EXCEPTION 'Geçersiz sipariş durum geçişi (% → %)', OLD.status, NEW.status USING ERRCODE = 'ERP11';
  END IF;
  IF NEW.status = 'issued' AND OLD.status = 'draft' THEN
    IF NOT EXISTS (SELECT 1 FROM purchase_order_lines WHERE order_id = NEW.id) THEN
      RAISE EXCEPTION 'Satırsız sipariş verilemez' USING ERRCODE = 'ERP11';
    END IF;
  END IF;
  IF NEW.status = 'cancelled' AND EXISTS (
       SELECT 1 FROM po_receipts WHERE order_id = NEW.id AND status = 'posted') THEN
    RAISE EXCEPTION 'Mal kabulü olan sipariş iptal edilemez; kalan miktar için siparişi kapatın' USING ERRCODE = 'ERP11';
  END IF;
  RETURN NEW;
END
$$;
