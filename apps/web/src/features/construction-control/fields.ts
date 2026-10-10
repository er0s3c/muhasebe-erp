import type { WorkflowKind } from '@erp/shared';
export interface EditorField {
  key: string;
  label: string;
  type?:
    | 'text'
    | 'note'
    | 'number'
    | 'money'
    | 'date'
    | 'checkbox'
    | 'select'
    | 'refs'
    | 'rows'
    | 'days'
    | 'dates';
  source?: string;
  options?: [string, string][];
  optional?: boolean;
  fields?: EditorField[];
  default?: unknown;
  readOnly?: boolean;
  fixedRows?: boolean;
}
const f = (
  key: string,
  label: string,
  type: EditorField['type'] = 'text',
  extra: Partial<EditorField> = {},
): EditorField => ({ key, label, type, ...extra });
const ref = (key: string, label: string, source: string, optional = false) =>
  f(key, label, 'select', { source, optional });
const money = (key: string, label: string) => f(key, label, 'money', { default: '0' });
const date = (key: string, label: string) => f(key, label, 'date');
const notes = (key: string, label: string) => f(key, label, 'note', { optional: true });
const currency = f('currency', 'Para birimi', 'select', {
  options: [
    ['TRY', 'TRY'],
    ['GBP', 'GBP'],
    ['EUR', 'EUR'],
    ['USD', 'USD'],
  ],
});
const range = [date('start', 'Başlangıç'), date('end', 'Bitiş')];
const assets = (key: string, label: string, source = 'assets') =>
  f(key, label, 'refs', { source, optional: true });
export const EDITOR_FIELDS: Record<WorkflowKind, EditorField[]> = {
  calendar: [
    f('weekdays', 'Çalışma günleri', 'days', { default: [1, 2, 3, 4, 5] }),
    f('holidays', 'Çalışılmayan tarihler', 'dates', { default: [] }),
  ],
  baseline: [notes('note', 'Plan açıklaması')],
  readiness: [
    ref('activityId', 'Program işi', 'schedule'),
    f('drawingReady', 'Çizim hazır', 'checkbox'),
    f('materialReady', 'Malzeme hazır', 'checkbox'),
    f('crewReady', 'Ekip hazır', 'checkbox'),
    f('approvalReady', 'Onaylar hazır', 'checkbox'),
    notes('blocker', 'Engel ve yapılacak işlem'),
  ],
  permit: [
    f('type', 'İzin türü', 'select', {
      options: [
        ['hot_work', 'Sıcak iş'],
        ['height', 'Yüksekte çalışma'],
        ['excavation', 'Kazı'],
      ],
    }),
    ...range,
    f('procedure', 'Çalışma yöntemi', 'note'),
    f('checklist', 'Kontrol listesi', 'rows', {
      fields: [f('label', 'Kontrol'), f('checked', 'Tamam', 'checkbox')],
    }),
  ],
  takeoff: [
    ref('drawingId', 'Onaylı çizim', 'drawings'),
    f('page', 'Sayfa', 'number', { default: 1 }),
    f('kind', 'Ölçüm türü', 'select', {
      options: [
        ['length', 'Uzunluk'],
        ['area', 'Alan'],
        ['count', 'Adet'],
      ],
    }),
    f('unit', 'Birim'),
  ],
  production: [
    ref('subcontractId', 'Sözleşme', 'subcontracts'),
    ref('lineKey', 'Metraj kalemi', 'boq'),
    f('quantity', 'Gerçekleşen miktar', 'number'),
    f('plannedQuantity', 'Planlanan miktar', 'number'),
    f('unit', 'Birim'),
    f('crew', 'Ekip adı'),
    date('date', 'Üretim tarihi'),
    assets('photoIds', 'Kanıt fotoğrafları', 'photos'),
  ],
  concrete: [
    ref('supplierId', 'Tedarikçi', 'parties'),
    f('batchNo', 'Döküm / parti no'),
    f('quantity', 'Miktar (m³)', 'number'),
    date('date', 'Döküm tarihi'),
    f('samples', 'Numuneler', 'rows', {
      fields: [
        f('name', 'Numune'),
        date('testDate', 'Test tarihi'),
        f('strength', 'Sonuç (MPa)', 'number', { optional: true, default: null }),
        f('minimum', 'Kabul eşiği (MPa)', 'number'),
      ],
    }),
  ],
  submittal: [
    ref('itemId', 'Malzeme', 'items', true),
    ref('supplierId', 'Tedarikçi', 'parties'),
    f('brand', 'Marka'),
    f('revision', 'Revizyon'),
    assets('assetIds', 'Teknik föy / dosyalar'),
    ref('orderId', 'Sipariş bağlantısı', 'orders', true),
  ],
  reservation: [
    ref('equipmentId', 'Ekipman', 'equipment'),
    ...range,
    f('purpose', 'Kullanım amacı'),
  ],
  maintenance: [
    ref('equipmentId', 'Ekipman', 'equipment'),
    date('dueDate', 'Bakım tarihi'),
    f('dueHours', 'Bakım saati eşiği', 'number', { optional: true }),
    f('work', 'Yapılacak bakım', 'note'),
    notes('parts', 'Parça / malzeme'),
    f('outageStart', 'Kullanılamama başlangıcı', 'date', { optional: true }),
    f('outageEnd', 'Kullanılamama bitişi', 'date', { optional: true }),
  ],
  rate_analysis: [
    f('unit', 'Poz birimi'),
    currency,
    date('validFrom', 'Fiyat tarihi'),
    f('components', 'Analiz bileşenleri', 'rows', {
      fields: [
        f('name', 'Bileşen'),
        f('kind', 'Tür', 'select', {
          options: [
            ['material', 'Malzeme'],
            ['labor', 'İşçilik'],
            ['equipment', 'Ekipman'],
          ],
        }),
        f('quantity', 'Katsayı', 'number'),
        money('unitPrice', 'Birim fiyat'),
        f('source', 'Fiyat kaynağı'),
      ],
    }),
  ],
  tender: [
    ref('clientId', 'İşveren', 'parties'),
    currency,
    date('dueDate', 'Teklif son tarihi'),
    f('revision', 'Teklif revizyonu'),
    ref('previousId', 'Önceki teklif', 'tender', true),
    f('marginPct', 'Maliyet üzerine ek (%)', 'number'),
    f('lines', 'Keşif / teklif kalemleri', 'rows', {
      fields: [
        f('description', 'İş tanımı'),
        f('unit', 'Birim'),
        f('quantity', 'Miktar', 'number'),
        money('unitPrice', 'Birim maliyet'),
        ref('analysisId', 'Onaylı analiz', 'rate_analysis', true),
      ],
    }),
    notes('note', 'Teklif notu'),
  ],
  material_need: [
    ref('itemId', 'Stok kartı', 'items'),
    ref('activityId', 'Program işi', 'schedule', true),
    ref('takeoffId', 'Onaylı metraj', 'takeoff', true),
    f('quantityPerUnit', 'Metraj birimi başına malzeme katsayısı', 'number', { optional: true }),
    f('quantity', 'İhtiyaç miktarı', 'number'),
    f('reserveQuantity', 'Stoktan ayrılacak miktar', 'number'),
    date('needDate', 'İhtiyaç tarihi'),
    f('leadDays', 'Tedarik süresi (gün)', 'number'),
    f('unit', 'Birim'),
  ],
  change_event: [
    ref('operationId', 'Teknik talep / talimat', 'changeOperation'),
    ref('subcontractId', 'Sözleşme', 'subcontracts'),
    money('costImpact', 'Maliyet etkisi'),
    money('revenueImpact', 'Gelir etkisi'),
    currency,
    f('days', 'Süre etkisi (gün)', 'number'),
    f('reason', 'Neden', 'select', {
      options: [
        ['client_request', 'İşveren isteği'],
        ['design_change', 'Tasarım değişikliği'],
        ['site_condition', 'Saha koşulu'],
        ['omission_error', 'Eksik / hata'],
        ['other', 'Diğer'],
      ],
    }),
    assets('evidenceIds', 'Kanıt belgeleri'),
    f('description', 'Gerekçe', 'note'),
  ],
  delay_claim: [
    assets('activityIds', 'Etkilenen işler', 'schedule'),
    ...range,
    f('requestedDays', 'Talep edilen gün', 'number'),
    f('reason', 'Gecikme gerekçesi', 'note'),
    f('evidence', 'Olay ve kanıt zaman çizgisi', 'rows', {
      fields: [
        date('date', 'Tarih'),
        f('description', 'Olay'),
        ref('assetId', 'Belge', 'assets', true),
      ],
    }),
  ],
  forecast: [
    date('date', 'Tahmin tarihi'),
    money('remainingEstimate', 'Kalan iş için maliyet tahmini'),
    f('reason', 'Tahmin değişikliğinin gerekçesi', 'note'),
  ],
  feasibility: [
    currency,
    money('landCost', 'Arsa bedeli'),
    f('ownerSharePct', 'Arsa sahibinin gelir payı (%)', 'number'),
    f('sellableArea', 'Satılabilir alan (m²)', 'number'),
    money('salePerM2', 'Satış / m²'),
    money('costPerM2', 'Maliyet / m²'),
    money('otherCosts', 'Diğer maliyetler'),
    f('stages', 'Etap nakit varsayımları', 'rows', {
      fields: [
        f('name', 'Etap'),
        date('date', 'Tarih'),
        f('salePct', 'Satış payı (%)', 'number'),
        f('costPct', 'Maliyet payı (%)', 'number'),
      ],
    }),
  ],
  lead: [
    f('name', 'Aday müşteri'),
    f('phone', 'Telefon', 'text', { optional: true }),
    f('source', 'Aday kaynağı'),
    ref('partyId', 'Müşteri carisi', 'parties', true),
    ref('unitId', 'İlgilenilen birim', 'units', true),
    date('reservationUntil', 'Rezervasyon bitişi'),
    money('offerAmount', 'Teklif bedeli'),
    currency,
  ],
  buyer_option: [
    ref('unitId', 'Birim', 'units'),
    ref('contractId', 'Satış sözleşmesi', 'salesContracts'),
    f('category', 'Seçenek grubu'),
    f('choice', 'Müşteri seçimi'),
    money('price', 'Ek bedel'),
    currency,
    date('selectionDeadline', 'Son seçim tarihi'),
    f('customerAcceptance', 'Müşteri kabul referansı'),
    ref('itemId', 'Malzeme', 'items', true),
  ],
  warranty: [
    ref('unitId', 'Birim', 'units'),
    ref('contractId', 'Satış sözleşmesi', 'salesContracts'),
    f('description', 'Servis talebi', 'note'),
    assets('photoIds', 'Fotoğraflar', 'photos'),
    { ...date('appointment', 'Randevu'), optional: true },
    ref('contractorId', 'Servis taşeronu', 'parties', true),
    f('coverage', 'Garanti değerlendirmesi', 'select', {
      options: [
        ['pending', 'Değerlendiriliyor'],
        ['covered', 'Kapsamda'],
        ['excluded', 'Kapsam dışı'],
      ],
    }),
    notes('customerConfirmation', 'Müşteri teyit referansı'),
  ],
  passport: [
    ref('unitId', 'Birim', 'units'),
    ref('contractId', 'Satış sözleşmesi', 'salesContracts'),
    f('devices', 'Cihaz / malzeme pasaportu', 'rows', {
      fields: [
        f('name', 'Cihaz'),
        f('serial', 'Seri no'),
        date('warrantyEnd', 'Garanti sonu'),
        assets('documentIds', 'Belgeler'),
      ],
    }),
    notes('maintenance', 'Bakım talimatları'),
  ],
};
export function fieldDefaults(
  fields: EditorField[],
  currencyCode = 'TRY',
): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((f) => [
      f.key,
      f.default !== undefined
        ? f.default
        : f.key === 'currency'
          ? currencyCode
          : f.type === 'rows' || f.type === 'refs' || f.type === 'dates'
            ? []
            : f.type === 'days'
              ? [1, 2, 3, 4, 5]
              : f.type === 'checkbox'
                ? false
                : f.optional
                  ? ''
                  : f.type === 'number'
                    ? 0
                    : f.type === 'money'
                      ? '0'
                      : f.type === 'date'
                        ? new Date().toISOString().slice(0, 10)
                        : (f.options?.[0]?.[0] ?? ''),
    ]),
  );
}
