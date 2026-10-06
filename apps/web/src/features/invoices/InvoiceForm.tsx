import { ArrowLeft, ClipboardList, Plus, Trash2, Truck, X, Paperclip } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { EXTERNAL_NO_REQUIRED, INVOICE_TYPE_META, ITEM_UNITS, calcInvoice, dec, formatTR, todayIso } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Combobox, type ComboOption } from '../../components/ui/Combobox';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Modal } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { money, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCompanyApi, useCQuery } from '../../lib/queries';
import type { AccountMapping, PriceResolution, DeliveryNoteDetail, InvoiceableOrderLine, InvoiceDetail, InvoiceType, ItemListRow, OpenDeliveryLine } from '../../lib/types';
import { useUnitLabel, useWarehouses } from '../inventory/common';
import { SerialEntry } from '../inventory/SerialEntry';
import { PROJECT_COST_INVALIDATE, ProjectLineRow, projectFields } from '../projects/common';
import { INVOICE_INVALIDATE, useLineAccountOptions, usePartyOptions, useTaxRates, vatRateFor } from './common';
import { DeliveryPicker } from './DeliveryPicker';
import { OrderLinePicker } from './OrderLinePicker';

interface LineState {
  key: number;
  itemId: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountPct: string;
  vatCode: string;
  accountId: string;
  sourceLineId: string;
  /** İade satırında iade edilebilir kalan miktar (üst sınır) */
  returnable: string | null;
  /** İrsaliyeden gelen satır: bağlı irsaliye satırı, görünen no ve (yeni eklenmişse) kalan miktar üst sınırı */
  deliveryLineId: string;
  deliveryNoteId: string;
  deliveryNoteNo: string;
  deliveryLineNo: number | null;
  deliveryRemaining: string | null;
  /** Proje boyutu (inşaat): yalnızca alış/gider/alış iadesi faturasının stoksuz satırında */
  projectId: string;
  wbsId: string;
  /** Alış faturasında bağlı sipariş satırı (üçlü eşleştirme) ve görünen sipariş kodu */
  orderLineId: string;
  orderCode: string;
  /** Satış faturasında bağlı satış siparişi satırı (X2; düzenlemede korunur). */
  salesOrderLineId: string;
  /** Seri takipli kartın doğrudan stok hareketi yapan satırında seri no'lar (X3). */
  serials?: string[];
  /** Fiyatın kaynağı (fiyat çözümleyici önerisi); kullanıcı fiyatı değiştirince silinir. */
  priceNote?: string;
}

let lineKey = 1;
const emptyLine = (vatCode = ''): LineState => ({
  key: lineKey++,
  itemId: '',
  description: '',
  quantity: '1',
  unit: '',
  unitPrice: '',
  discountPct: '',
  vatCode,
  accountId: '',
  sourceLineId: '',
  returnable: null,
  deliveryLineId: '',
  deliveryNoteId: '',
  deliveryNoteNo: '',
  deliveryLineNo: null,
  deliveryRemaining: null,
  projectId: '',
  wbsId: '',
  orderLineId: '',
  orderCode: '',
  salesOrderLineId: '',
});

interface DeliverySource {
  lineId: string;
  noteId: string;
  noteNo: string;
  lineNo: number;
  itemId: string;
  description: string;
  unit: string | null;
  unitCost: string | null;
  currencyCode: string | null;
}

interface Props {
  type: InvoiceType;
  /** Düzenlenen taslak */
  initial?: InvoiceDetail;
  /** Yeni iade faturasında bağlı orijinal fatura */
  original?: InvoiceDetail;
  /** İrsaliyeden fatura: irsaliyenin faturalanmamış satırları hazır gelir */
  fromDelivery?: DeliveryNoteDetail;
}

/** Fatura girişi (yeni / taslak düzenleme / iade): satırlar, KDV, para birimi, kaydet ve muhasebeleştir. */
export function InvoiceForm({ type, initial, original, fromDelivery }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const unitLabel = useUnitLabel();
  const { company, call } = useCompanyApi();
  const base = company.baseCurrency;
  const meta = INVOICE_TYPE_META[type];
  const salesSide = meta.side === 'sales';
  // Proje etiketi yalnızca alış tarafında (alış, gider, alış iadesi); satış tarafı sonraki aşamada
  const projectAllowed = !salesSide;
  const can = useCan();
  const canPost = can('invoices.post');
  const canDelivery = can('deliveries.read');
  const canOrders = can('procurement.read') && type === 'purchase';
  const canOverride = can('procurement.approve');

  const { options: partyOptions, byId: partyById } = usePartyOptions(salesSide ? 'customer' : 'supplier');
  const { data: taxData } = useTaxRates();
  const taxRates = useMemo(() => taxData?.taxRates ?? [], [taxData]);
  const { data: whData } = useWarehouses();
  const warehouses = (whData?.warehouses ?? []).filter((w) => w.isActive);
  // Hesap seçici ve eşlemeler muhasebe okuma izni ister (satış rolünde yok): izin yoksa hiç sorgulanmaz, seçici yerine
  // "varsayılan eşlemeden atanır" notu gösterilir; sunucu boş hesabı şirketin varsayılan eşlemesiyle doldurur (UI-8).
  const canLedger = can('ledger.read');
  const accountOptions = useLineAccountOptions(meta.side, canLedger);
  const { data: mapData } = useCQuery<{ mappings: AccountMapping[] }>(['account-mappings'], '/api/account-mappings', { enabled: canLedger });
  const defaultAccount = mapData?.mappings.find((m) => m.key === (salesSide ? (meta.isReturn ? 'sales_return' : 'sales_revenue') : 'default_expense'))?.accountCode;
  const { data: itemData } = useCQuery<{ items: ItemListRow[] }>(['items', 'options', 'invoice'], '/api/items?limit=500&active=true');
  const items = useMemo(() => (itemData?.items ?? []).filter((i) => meta.stock || i.kind === 'service'), [itemData, meta.stock]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const itemOptions: ComboOption[] = items.map((i) => ({ value: i.id, label: `${i.code} — ${i.name}`, keywords: `${i.code} ${i.barcode ?? ''}`, hint: i.kind === 'service' ? t('inventory.kinds.service') : undefined }));

  // --- Başlangıç durumu ---
  const seed = initial ?? original;
  const [partyId, setPartyId] = useState(seed?.invoice.partyId ?? fromDelivery?.note.partyId ?? '');
  const [invoiceDate, setInvoiceDate] = useState(initial?.invoice.invoiceDate ?? todayIso());
  const [dueDate, setDueDate] = useState(initial?.invoice.dueDate ?? '');
  const [externalNo, setExternalNo] = useState(initial?.invoice.externalNo ?? '');
  const [currency, setCurrency] = useState(seed?.invoice.currencyCode ?? base);
  const [fxRate, setFxRate] = useState(initial?.invoice.fxRate && initial.invoice.currencyCode !== base ? initial.invoice.fxRate.replace(/0+$/, '').replace(/\.$/, '') : '');
  const [vatIncluded, setVatIncluded] = useState(seed?.invoice.vatIncluded ?? false);
  const [warehouseId, setWarehouseId] = useState(seed?.invoice.warehouseId ?? '');
  const [description, setDescription] = useState(initial?.invoice.description ?? '');
  const returnOfId = initial?.invoice.returnOfId ?? original?.invoice.id ?? null;
  const [lines, setLines] = useState<LineState[]>(() => {
    if (initial) {
      const src = initial.lines;
      return src.map((l) => ({
        key: lineKey++,
        itemId: l.itemId ?? '',
        description: l.description,
        quantity: trim(l.quantity),
        unit: l.unit ?? '',
        unitPrice: trim(l.unitPrice),
        discountPct: dec(l.discountPct).isZero() ? '' : trim(l.discountPct),
        vatCode: l.vatCode ?? '',
        accountId: l.accountId ?? '',
        sourceLineId: l.sourceLineId ?? '',
        returnable: null,
        deliveryLineId: l.deliveryLineId ?? '',
        deliveryNoteId: l.deliveryNoteId ?? '',
        deliveryNoteNo: l.deliveryNoteNo ?? '',
        deliveryLineNo: l.deliveryLineNo,
        deliveryRemaining: null,
        projectId: l.projectId ?? '',
        wbsId: l.wbsId ?? '',
        orderLineId: l.poLineId ?? '',
        orderCode: l.orderCode ?? '',
        salesOrderLineId: l.salesOrderLineId ?? '',
        serials: l.serials ?? [],
      }));
    }
    if (original) {
      // İade: orijinal faturanın hâlâ iade edilebilir satırları hazır gelir
      return original.lines
        .filter((l) => l.returnableQty && dec(l.returnableQty).gt(0))
        .map((l) => ({
          key: lineKey++,
          itemId: l.itemId ?? '',
          description: l.description,
          quantity: trim(l.returnableQty!),
          unit: l.unit ?? '',
          unitPrice: trim(l.unitPrice),
          discountPct: dec(l.discountPct).isZero() ? '' : trim(l.discountPct),
          vatCode: l.vatCode ?? '',
          accountId: '',
          sourceLineId: l.id,
          returnable: trim(l.returnableQty!),
          deliveryLineId: '',
          deliveryNoteId: '',
          deliveryNoteNo: '',
          deliveryLineNo: null,
          deliveryRemaining: null,
          projectId: '',
          wbsId: '',
          orderLineId: '',
          orderCode: '',
          salesOrderLineId: '',
        }));
    }
    return [emptyLine()];
  });
  const [error, setError] = useState<Error | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [overrideReason, setOverrideReason] = useState(initial?.invoice.matchOverrideReason ?? '');
  const [orderPickerOpen, setOrderPickerOpen] = useState(false);

  // Cari seçilince para birimi ve vadeyi cari kartından al (yalnızca yeni faturada)
  const party = partyById.get(partyId);
  useEffect(() => {
    if (!initial && !original && party) setCurrency(party.currencyCode);
  }, [party, initial, original]);

  // Depo yalnızca doğrudan stok hareketi yapan (irsaliyeye bağlı olmayan) mal satırı için gerekir
  const hasStock = lines.some((l) => itemById.get(l.itemId)?.kind === 'goods' && !l.deliveryLineId);

  // Dövizli fatura: tarihindeki kayıtlı kuru önizleme amacıyla sorgula
  const foreign = currency !== base;
  const rateQuery = useCQuery<{ rate: string | null }>(
    ['rate-lookup', currency, base, invoiceDate],
    foreign && /^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) ? `/api/exchange-rates/lookup?from=${currency}&to=${base}&date=${invoiceDate}` : null,
  );
  const lookedUp = rateQuery.data?.rate ?? null;
  const fxMissing = foreign && !fxRate && !lookedUp && rateQuery.isSuccess;

  const totals = useMemo(
    () =>
      calcInvoice(
        lines.map((l) => ({
          quantity: l.quantity || '0',
          unitPrice: l.unitPrice || '0',
          discountPct: l.discountPct || '0',
          vatRate: vatRateFor(taxRates, l.vatCode || null, invoiceDate),
        })),
        vatIncluded,
      ),
    [lines, vatIncluded, taxRates, invoiceDate],
  );
  const usedCodes = new Set(lines.map((l) => l.vatCode).filter(Boolean));
  const unverified = taxRates.some((r) => usedCodes.has(r.code) && !r.verifiedAt);

  const patch = (key: number, p: Partial<LineState>) => setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...p } : l)));

  // --- İrsaliyeden satır ---
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Fiyat yalnızca fatura para birimiyle aynı para biriminde hazır gelir (çevrim yapılmaz). */
  const priceFor = useCallback(
    (itemId: string, cur: string, hint?: { unitCost: string | null; currencyCode: string | null }) => {
      const it = itemById.get(itemId);
      if (!it) return '';
      if (!salesSide && hint?.unitCost && hint.currencyCode === cur) return trim(hint.unitCost);
      const price = salesSide ? { v: it.salePrice, c: it.saleCurrency } : { v: it.purchasePrice, c: it.purchaseCurrency };
      return price.v && price.c === cur ? trim(price.v) : '';
    },
    [itemById, salesSide],
  );
  const deliveryLine = useCallback(
    (d: DeliverySource, qty: string, cur: string): LineState => ({
      ...emptyLine(),
      itemId: d.itemId,
      description: d.description,
      quantity: trim(qty),
      unit: d.unit ?? itemById.get(d.itemId)?.unit ?? '',
      unitPrice: priceFor(d.itemId, cur, d),
      vatCode: itemById.get(d.itemId)?.vatCode ?? '',
      deliveryLineId: d.lineId,
      deliveryNoteId: d.noteId,
      deliveryNoteNo: d.noteNo,
      deliveryLineNo: d.lineNo,
      deliveryRemaining: trim(qty),
    }),
    [itemById, priceFor],
  );
  // İrsaliye detayından gelen satırlar, kart fiyatları yüklenince bir kez hazırlanır
  const [primed, setPrimed] = useState(!fromDelivery);
  useEffect(() => {
    if (primed || !fromDelivery || !itemData || !taxData) return;
    const cur = partyById.get(fromDelivery.note.partyId)?.currencyCode ?? base;
    setLines(
      fromDelivery.lines
        .filter((l) => dec(l.remainingQty).gt(0))
        .map((l) =>
          deliveryLine(
            { lineId: l.id, noteId: fromDelivery.note.id, noteNo: fromDelivery.note.noteNo ?? '', lineNo: l.lineNo, itemId: l.itemId, description: l.description, unit: l.unit, unitCost: l.unitCost, currencyCode: l.currencyCode },
            l.remainingQty,
            cur,
          ),
        ),
    );
    setPrimed(true);
  }, [primed, fromDelivery, itemData, taxData, partyById, base, deliveryLine]);
  const takenFromDelivery = new Map<string, string>();
  for (const l of lines) {
    if (l.deliveryLineId) takenFromDelivery.set(l.deliveryLineId, dec(takenFromDelivery.get(l.deliveryLineId) ?? 0).plus(l.quantity || 0).toString());
  }
  const addFromPicker = (picked: (OpenDeliveryLine & { available: string })[]) =>
    setLines((cur) => {
      const keep = cur.length === 1 && !cur[0]!.itemId && !cur[0]!.description ? [] : cur;
      return [
        ...keep,
        ...picked.map((p) =>
          deliveryLine({ lineId: p.lineId, noteId: p.noteId, noteNo: p.noteNo, lineNo: p.lineNo, itemId: p.itemId, description: p.description, unit: p.unit, unitCost: p.unitCost, currencyCode: p.currencyCode }, p.available, currency),
        ),
      ];
    });

  // --- Siparişten satır (üçlü eşleştirme) ---
  const takenFromOrder = new Map<string, string>();
  for (const l of lines) {
    if (l.orderLineId) takenFromOrder.set(l.orderLineId, dec(takenFromOrder.get(l.orderLineId) ?? 0).plus(l.quantity || 0).toString());
  }
  const addFromOrder = (picked: (InvoiceableOrderLine & { suggested: string })[]) =>
    setLines((cur) => {
      const keep = cur.length === 1 && !cur[0]!.itemId && !cur[0]!.description ? [] : cur;
      return [
        ...keep,
        ...picked.map(
          (p): LineState => ({
            ...emptyLine(p.vatCode ?? ''),
            itemId: p.itemId && itemById.has(p.itemId) ? p.itemId : '',
            description: p.description,
            quantity: trim(p.suggested),
            // Sipariş birimi serbest metindir; faturada yalnızca tanımlı birim kodları kullanılır
            unit: (ITEM_UNITS as readonly string[]).includes(p.unit) ? p.unit : '',
            unitPrice: trim(p.unitPrice),
            projectId: p.projectId,
            wbsId: p.wbsId ?? '',
            orderLineId: p.lineId,
            orderCode: p.orderCode,
          }),
        ),
      ];
    });

  /**
   * Satır başına istek sırası: aynı satır için birden çok öneri yoldayken (kart değişti, miktar değişti, "yenile")
   * yalnızca EN SON isteğin yanıtı uygulanır; elle girilen fiyat da yoldaki öneriyi geçersiz kılar. Eskiden geç gelen
   * eski yanıt yenisini eziyordu.
   */
  const suggestSeq = useRef(new Map<number, number>());
  const bumpSuggest = (key: number) => {
    const n = (suggestSeq.current.get(key) ?? 0) + 1;
    suggestSeq.current.set(key, n);
    return n;
  };
  /** Fiyat çözümleyici (cari özel fiyat > cari listesi > varsayılan liste > kart) ve iskonto önerisi; kullanıcı her zaman değiştirebilir. */
  const suggest = async (key: number, itemId: string, qty: string) => {
    if (!partyId || !itemId || !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) || !qty || dec(qty).lte(0)) return;
    const qs = new URLSearchParams({ partyId, itemId, kind: salesSide ? 'sales' : 'purchase', date: invoiceDate, currency, quantity: qty });
    const seq = bumpSuggest(key);
    try {
      const r = await call<PriceResolution>(`/api/price-resolution?${qs}`);
      if (suggestSeq.current.get(key) !== seq) return;
      if (r.unitPrice === null && dec(r.discountPct).isZero()) return;
      setLines((cur) =>
        cur.map((l) =>
          l.key === key && l.itemId === itemId
            ? {
                ...l,
                ...(r.unitPrice !== null ? { unitPrice: trim(r.unitPrice) } : {}),
                discountPct: dec(r.discountPct).isZero() ? '' : trim(r.discountPct),
                priceNote:
                  r.unitPrice !== null
                    ? t(`pricing.source.${r.priceSource}`, { list: r.priceListName ?? '' }) + (dec(r.discountPct).isZero() ? '' : ` · ${t(`pricing.discountSource.${r.discountSource}`)}`)
                    : '',
              }
            : l,
        ),
      );
    } catch {
      // Öneri alınamazsa kart fiyatı ve elle giriş geçerlidir
    }
  };

  const pickItem = (key: number, itemId: string) => {
    const it = itemById.get(itemId);
    if (!it) return;
    void suggest(key, itemId, lines.find((l) => l.key === key)?.quantity || '1');
    // Fiyat yalnızca kartın fiyat para birimi fatura para birimiyle aynıysa hazır gelir (çevrim yapılmaz)
    const price = salesSide ? { v: it.salePrice, c: it.saleCurrency } : { v: it.purchasePrice, c: it.purchaseCurrency };
    patch(key, {
      itemId,
      description: it.name,
      unit: it.unit,
      unitPrice: price.v && price.c === currency ? trim(price.v) : '',
      priceNote: '',
      serials: [],
      vatCode: it.vatCode ?? '',
      accountId: '',
      // Stoklu kalem projeye doğrudan yazılmaz (malzeme stoktan projeye sarf edilir)
      ...(it.kind === 'goods' ? { projectId: '', wbsId: '' } : {}),
    });
  };

  const bodyOf = (post: boolean) => ({
    ...(initial ? {} : { type }),
    partyId,
    invoiceDate,
    dueDate: dueDate || null,
    externalNo: externalNo.trim() || undefined,
    currency,
    ...(foreign && fxRate ? { fxRate } : {}),
    vatIncluded,
    warehouseId: hasStock ? warehouseId || null : null,
    returnOfId,
    description: description.trim() || undefined,
    ...(overrideReason.trim() && lines.some((l) => l.orderLineId) ? { matchOverrideReason: overrideReason.trim() } : {}),
    post,
    lines: lines.map((l) => ({
      itemId: l.itemId || null,
      description: l.description.trim(),
      quantity: l.quantity,
      unit: l.unit || null,
      unitPrice: l.unitPrice,
      discountPct: l.discountPct || '0',
      vatCode: l.vatCode || null,
      accountId: l.itemId && itemById.get(l.itemId)?.kind === 'goods' && !salesSide ? null : l.accountId || null,
      sourceLineId: l.sourceLineId || null,
      deliveryLineId: l.deliveryLineId || null,
      orderLineId: l.orderLineId || null,
      ...(l.serials && l.serials.length > 0 && !l.deliveryLineId ? { serials: l.serials } : {}),
      ...(type === 'sales' && l.salesOrderLineId ? { salesOrderLineId: l.salesOrderLineId } : {}),
      // Proje yalnızca stoksuz (serbest/hizmet) satırda ve alış tarafında gönderilir
      ...(projectAllowed && (!l.itemId || itemById.get(l.itemId)?.kind === 'service') ? projectFields(l.projectId, l.wbsId) : {}),
    })),
  });

  const save = useCMutation(
    (post: boolean, c) =>
      initial
        ? c<InvoiceDetail>(`/api/invoices/${initial.invoice.id}`, { method: 'PUT', body: bodyOf(post) })
        : c<InvoiceDetail>('/api/invoices', { method: 'POST', body: bodyOf(post) }),
    [...INVOICE_INVALIDATE, ...PROJECT_COST_INVALIDATE],
  );
  const remove = useCMutation((_: void, c) => c(`/api/invoices/${initial!.invoice.id}`, { method: 'DELETE' }), INVOICE_INVALIDATE);

  const submit = (post: boolean) => {
    setError(null);
    setFieldError(null);
    if (!partyId) return setFieldError(t('invoices.form.partyRequired'));
    if (lines.some((l) => !l.description.trim() || !l.quantity || dec(l.quantity).lte(0) || l.unitPrice === '')) return setFieldError(t('invoices.form.linesRequired'));
    if (lines.some((l) => l.returnable && dec(l.quantity).gt(l.returnable))) return setFieldError(t('invoices.form.returnExceeded'));
    if (lines.some((l) => l.deliveryRemaining && dec(l.quantity).gt(l.deliveryRemaining))) return setFieldError(t('deliveries.line.exceeded'));
    if (post && EXTERNAL_NO_REQUIRED.includes(type) && !externalNo.trim()) return setFieldError(t('invoices.form.externalRequired'));
    save.mutate(post, {
      onSuccess: (res) => {
        toast.success(post ? t('invoices.form.postedMsg', { no: res.invoice.invoiceNo ?? '' }) : t('invoices.form.savedMsg'));
        navigate(`/invoices/${res.invoice.id}`, { replace: true, state: res.warnings?.creditLimit ? { creditLimit: res.warnings.creditLimit } : undefined });
      },
      onError: (e) => setError(e),
    });
  };

  const listPath = salesSide ? '/invoices/sales' : '/invoices/purchases';
  const loading = !itemData || !whData || !taxData;
  if (loading) return <PageLoading />;

  const gridCols = 'lg:grid-cols-[minmax(0,2fr)_minmax(0,1.6fr)_84px_minmax(0,1fr)_68px_140px_minmax(0,1fr)_32px]';
  const fxNeedsLink = error && (error as { code?: string }).code === 'FX_RATE_MISSING';

  return (
    <>
      <Link to={listPath} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text print:hidden">
        <ArrowLeft className="size-4" aria-hidden />
        {t(`invoices.${meta.side}.title`)}
      </Link>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-heading">{initial ? t('invoices.form.editTitle', { type: t(`invoices.types.${type}`) }) : t('invoices.form.newTitle', { type: t(`invoices.types.${type}`) })}</h1>
        {initial&&<Link to={`/workspace/documents?kind=invoice&id=${initial.invoice.id}`} className="link inline-flex items-center gap-2 text-sm"><Paperclip className="size-4" aria-hidden />Belge ekleri</Link>}
        {initial&&type==='sales'&&<Link to="/sales/campaigns" className="link text-sm">Kampanya uygula</Link>}
      </div>

      <div className="flex flex-col gap-5">
        {(error || fieldError) && (
          <Callout
            tone="danger"
            action={
              fxNeedsLink ? (
                <Link to="/settings/currencies" className="shrink-0 text-sm link">
                  {t('ledger.journal.enterFx')}
                </Link>
              ) : undefined
            }
          >
            {error ? errorMessage(error) : fieldError}
          </Callout>
        )}
        {returnOfId && (
          <Callout>
            {t('invoices.form.returnOf')}{' '}
            <Link to={`/invoices/${returnOfId}`} className="link">
              {(initial?.invoice.returnOfNo ?? original?.invoice.invoiceNo) || t('invoices.form.originalInvoice')}
            </Link>
          </Callout>
        )}

        <Card className="p-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={salesSide ? t('invoices.form.customer') : t('invoices.form.supplier')} required className="sm:col-span-2">
              {(id) => (
                <Combobox id={id} options={partyOptions} value={partyId || null} placeholder={t('invoices.form.pickParty')} disabled={!!returnOfId} onChange={setPartyId} />
              )}
            </Field>
            <Field label={t('invoices.form.invoiceDate')} required>
              {(id) => <Input id={id} type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />}
            </Field>
            <Field label={t('invoices.form.dueDate')} hint={!dueDate ? t('invoices.form.dueAuto') : undefined}>
              {(id) => <Input id={id} type="date" value={dueDate} min={invoiceDate} onChange={(e) => setDueDate(e.target.value)} />}
            </Field>
            {EXTERNAL_NO_REQUIRED.includes(type) && (
              <Field label={t('invoices.form.externalNo')} required>
                {(id) => <Input id={id} value={externalNo} maxLength={40} onChange={(e) => setExternalNo(e.target.value)} />}
              </Field>
            )}
            <Field label={t('invoices.form.currency')}>
              {(id) => (
                <Select id={id} value={currency} onChange={(e) => { setCurrency(e.target.value); setFxRate(''); }}>
                  <CurrencyOptions wide />
                </Select>
              )}
            </Field>
            <Field label={t('invoices.form.fxRate')}>
              {(id) => (
                <MoneyInput
                  id={id}
                  value={fxRate}
                  decimals={4}
                  maxDecimals={8}
                  disabled={!foreign}
                  placeholder={!foreign ? '—' : lookedUp ? formatTR(lookedUp, 4) : '?'}
                  onChange={setFxRate}
                />
              )}
            </Field>
            {hasStock && (
              <Field label={t('invoices.form.warehouse')}>
                {(id) => (
                  <Select id={id} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                    <option value="">{t('invoices.form.defaultWarehouse')}</option>
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <div className="flex items-end pb-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" className="size-4" checked={vatIncluded} onChange={(e) => setVatIncluded(e.target.checked)} />
                {t('invoices.form.vatIncluded')}
              </label>
            </div>
            <Field label={t('common.description')} className="sm:col-span-2 lg:col-span-4">
              {(id) => <Input id={id} value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />}
            </Field>
          </div>
          {fxMissing && <p className="mt-3 text-sm text-warning">{t('invoices.form.fxMissing')}</p>}
        </Card>

        <Card className="p-5">
          <section aria-label={t('invoices.form.lines')}>
            <div className={cn('mb-2 grid items-end gap-2 px-1 micro max-lg:hidden', gridCols)}>
              <span>{t('invoices.form.item')}</span>
              <span>{t('common.description')}</span>
              <span className="text-right">{t('invoices.form.quantity')}</span>
              <span className="text-right">{t('invoices.form.unitPrice')}</span>
              <span className="text-right">{t('invoices.form.discount')}</span>
              <span>{t('invoices.form.vat')}</span>
              <span className="text-right">{t('invoices.form.lineNet')}</span>
              <span />
            </div>
            <div className="flex flex-col gap-3">
              {lines.map((l, i) => {
                const it = itemById.get(l.itemId);
                const calc = totals.lines[i]!;
                const free = !it || it.kind === 'service';
                return (
                  <div key={l.key} className="rounded-lg border border-border p-2 lg:border-0 lg:p-0">
                    <div className={cn('grid grid-cols-2 items-center gap-2', gridCols)}>
                      <Combobox
                        className="col-span-2 lg:col-span-1"
                        options={itemOptions}
                        value={l.itemId || null}
                        placeholder={t('invoices.form.pickItem')}
                        aria-label={`${t('invoices.form.item')} ${i + 1}`}
                        disabled={!!l.sourceLineId || !!l.deliveryLineId}
                        onChange={(v) => pickItem(l.key, v)}
                      />
                      <Input className="col-span-2 lg:col-span-1" value={l.description} maxLength={300} aria-label={`${t('common.description')} ${i + 1}`} placeholder={t('common.description')} onChange={(e) => patch(l.key, { description: e.target.value })} />
                      <MoneyInput value={l.quantity} decimals={0} maxDecimals={4} aria-label={`${t('invoices.form.quantity')} ${i + 1}`} placeholder={l.unit ? unitLabel(l.unit) : undefined} className="text-right" onChange={(v) => patch(l.key, { quantity: v })} />
                      <MoneyInput value={l.unitPrice} maxDecimals={6} aria-label={`${t('invoices.form.unitPrice')} ${i + 1}`} className="text-right" onChange={(v) => { bumpSuggest(l.key); patch(l.key, { unitPrice: v, priceNote: '' }); }} />
                      <MoneyInput value={l.discountPct} decimals={0} maxDecimals={4} aria-label={`${t('invoices.form.discount')} ${i + 1}`} placeholder="%" className="text-right" onChange={(v) => patch(l.key, { discountPct: v })} />
                      <Select className="px-2 pr-6" value={l.vatCode} aria-label={`${t('invoices.form.vat')} ${i + 1}`} onChange={(e) => patch(l.key, { vatCode: e.target.value })}>
                        <option value="">{t('invoices.form.noVat')}</option>
                        {[...new Set(taxRates.map((r) => r.code))].map((code) => (
                          <option key={code} value={code}>
                            {code} (%{dec(vatRateFor(taxRates, code, invoiceDate)).toFixed(0)})
                          </option>
                        ))}
                      </Select>
                      <span className="num text-right text-sm" aria-label={`${t('invoices.form.lineNet')} ${i + 1}`}>
                        {money(calc.net.toFixed(2))}
                      </span>
                      <button
                        className="justify-self-end rounded-md p-1.5 text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-30"
                        disabled={lines.length <= 1}
                        onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))}
                        aria-label={t('invoices.form.removeLine')}
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                    {free && projectAllowed && (
                      <ProjectLineRow
                        className="mt-1.5"
                        label={String(i + 1)}
                        projectId={l.projectId}
                        wbsId={l.wbsId}
                        onChange={(v) => patch(l.key, v)}
                      />
                    )}
                    {free || l.returnable || l.deliveryLineId || l.orderLineId || l.priceNote || (it?.tracksSerial && !l.deliveryLineId) ? (
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 pl-1 text-[13px] text-muted">
                        {free && !canLedger && (
                          <span title={t('invoices.form.accountByDefaultHint')} data-testid="account-by-default">
                            {t('invoices.form.accountByDefault')}
                          </span>
                        )}
                        {free && canLedger && (
                          <span className="flex items-center gap-2">
                            {t('invoices.form.account')}
                            <Combobox
                              className="w-64"
                              options={accountOptions}
                              value={l.accountId || null}
                              placeholder={defaultAccount ? t('invoices.form.defaultAccount', { code: defaultAccount }) : t('invoices.form.pickAccount')}
                              aria-label={`${t('invoices.form.account')} ${i + 1}`}
                              onChange={(v) => patch(l.key, { accountId: v })}
                            />
                          </span>
                        )}
                        {l.priceNote && (
                          <span data-testid="price-source">
                            {t('pricing.priceFrom', { source: l.priceNote })}
                          </span>
                        )}
                        {it && !l.sourceLineId && !l.deliveryLineId && partyId && (
                          <button type="button" className="link" onClick={() => void suggest(l.key, l.itemId, l.quantity || '1')}>
                            {t('pricing.refresh')}
                          </button>
                        )}
                        {it?.tracksSerial && !l.deliveryLineId && (
                          <SerialEntry
                            label={String(i + 1)}
                            serials={l.serials ?? []}
                            quantity={l.quantity}
                            onChange={(serials) => patch(l.key, { serials })}
                          />
                        )}
                        {l.orderLineId && <span>{t('procurement.match.fromOrder', { code: l.orderCode })}</span>}
                        {l.returnable && <span>{t('invoices.form.returnable', { qty: l.returnable })}</span>}
                        {l.deliveryLineId && (
                          <span>
                            {t('deliveries.line.from', { no: l.deliveryNoteNo, line: l.deliveryLineNo ?? '' })}
                            {l.deliveryRemaining ? ` · ${t('deliveries.line.remaining', { qty: l.deliveryRemaining })}` : ''}
                          </span>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setLines((cur) => [...cur, emptyLine()])}>
                <Plus className="size-3.5" aria-hidden />
                {t('invoices.form.addLine')}
              </Button>
              {canOrders && !returnOfId && (
                <Button size="sm" disabled={!partyId} onClick={() => setOrderPickerOpen(true)}>
                  <ClipboardList className="size-3.5" aria-hidden />
                  {t('procurement.match.pickerButton')}
                </Button>
              )}
              {type !== 'expense' && canDelivery && (!returnOfId || meta.isReturn) && (
                <Button size="sm" disabled={!partyId} onClick={() => setPickerOpen(true)}>
                  <Truck className="size-3.5" aria-hidden />
                  {t('deliveries.picker.button')}
                </Button>
              )}
            </div>
          </section>

          <div className="mt-5 flex justify-end border-t border-border pt-4">
            <dl className="w-full max-w-xs text-sm">
              <div className="flex justify-between py-1">
                <dt className="text-muted">{t('invoices.netTotal')}</dt>
                <dd className="num">{moneyIn(totals.net.toFixed(2), currency)}</dd>
              </div>
              {totals.byRate.filter((g) => !dec(g.vat).isZero()).map((g) => (
                <div key={g.rate} className="flex justify-between py-1">
                  <dt className="text-muted">{t('invoices.vatAt', { rate: dec(g.rate).toFixed(0) })}</dt>
                  <dd className="num">{moneyIn(g.vat.toFixed(2), currency)}</dd>
                </div>
              ))}
              <div className="mt-1 flex justify-between border-t border-text pt-2 text-base">
                <dt>{t('invoices.grossTotal')}</dt>
                <dd className="num" data-testid="gross-total">{moneyIn(totals.gross.toFixed(2), currency)}</dd>
              </div>
            </dl>
          </div>
          {canOverride && lines.some((l) => l.orderLineId) && (
            <Field label={t('procurement.match.overrideLabel')} hint={t('procurement.match.overrideHint')} className="mt-4">
              {(id) => <Input id={id} value={overrideReason} maxLength={500} onChange={(e) => setOverrideReason(e.target.value)} />}
            </Field>
          )}
          {unverified && (
            <p className="mt-3 text-[13px] text-warning">
              {t('invoices.form.vatUnverified')}{' '}
              <Link to="/settings/tax-rates" className="link">
                {t('nav.taxRates')}
              </Link>
            </p>
          )}
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            {initial && (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="size-4" aria-hidden />
                {t('invoices.form.deleteDraft')}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => navigate(listPath)}>{t('common.cancel')}</Button>
            <Button loading={save.isPending && !save.variables} onClick={() => submit(false)}>
              {t('invoices.form.saveDraft')}
            </Button>
            {canPost && (
              <Button variant="primary" loading={save.isPending && !!save.variables} onClick={() => submit(true)}>
                {t('invoices.form.savePost')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {canOrders && <OrderLinePicker open={orderPickerOpen} onOpenChange={setOrderPickerOpen} partyId={partyId} currency={currency} taken={takenFromOrder} onAdd={addFromOrder} />}

      {(type === 'sales' || type === 'purchase') && (
        <DeliveryPicker open={pickerOpen} onOpenChange={setPickerOpen} type={type} partyId={partyId} taken={takenFromDelivery} onAdd={addFromPicker} />
      )}

      <Modal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('invoices.form.deleteDraft')}
        description={t('invoices.form.deleteConfirm')}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => {
                    toast.success(t('invoices.form.deleted'));
                    navigate(listPath, { replace: true });
                  },
                  onError: (e) => {
                    setConfirmDelete(false);
                    toast.error(errorMessage(e));
                  },
                })
              }
            >
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </>
  );
}

/** "12.5000" -> "12.5"; "3.0000" -> "3" */
function trim(v: string): string {
  return v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v;
}
