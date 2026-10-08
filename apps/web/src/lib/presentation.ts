import { formatDateTR, formatTR } from './format';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
export const containsRecordId = (value: string) => UUID.test(value);
export const displayRecordCode = (value: unknown, fallback = 'Kayıt') =>
  typeof value === 'string' && value.trim() && !containsRecordId(value) ? value : fallback;

export const domainLabels: Record<string, string> = {
  published: 'Yayımlandı',
  configured: 'Bağlantı bilgileri girildi',
  disconnected: 'Bağlı değil',
  actual: 'Gerçek veriden',
  standard: 'Standart süreden',
  manual: 'Elle girilen',
  blended: 'Gerçek ve standart veriden',
  no_data: 'Veri yok',
  no_actual_data: 'Gerçek veri yok',
  produce: 'Üretim',
  purchase: 'Satın alma',
  machine: 'Makine',
  person: 'Personel',
  center: 'İş merkezi',
  shopify: 'Shopify',
  ticimax: 'Ticimax',
  bank: 'Banka',
  pdks: 'PDKS',
  edocument: 'E-belge',
  adapter_required: 'Sağlayıcı bağlantısı gerekli',
  queued: 'Sırada',
  processing: 'İşleniyor',
  failed: 'Başarısız',
  imported: 'Aktarıldı',
  processed: 'İşlendi',
  part_received: 'Kısmen kabul edildi',
  placed: 'Yerleştirildi',
  part_picked: 'Kısmen toplandı',
  picked: 'Toplandı',
  blocked: 'Blokeli',
  shift: 'Vardiya',
  absence: 'Devamsızlık',
  overtime: 'Fazla mesai',
  breakdown: 'Arıza',
  forward: 'İleri',
  backward: 'Geri',
  packed: 'Paketlendi',
  ready: 'Hazır',
  sent: 'Gönderildi',
  material_waiting: 'Malzeme bekliyor',
  paused: 'Duraklatıldı',
  quality_waiting: 'Kalite bekliyor',
  rework: 'Yeniden işleme',
  on_hold: 'Bekletildi',
  closed: 'Maliyet kapandı',
  running: 'Çalışıyor',
  resolved: 'Çözüldü',
  dead_letter: 'Manuel müdahale gerekli',
  needs_review: 'Sipariş değişikliği onay bekliyor',
  superseded: 'Yeni sürümle değiştirildi',
  partitioned: 'Alt partilere ayrıldı',
  leather_traced: 'Fiziksel deri parçalarından izleniyor',
  holiday: 'Tatil',
};

export function displayDateTime(value: unknown) {
  if (!value) return '—';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return formatDateTR(text);
  const date = new Date(text);
  return Number.isNaN(date.valueOf())
    ? '—'
    : date.toLocaleString('tr-TR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
}
export function displayQuantity(value: unknown, digits = 2) {
  return value == null || value === '' || !Number.isFinite(Number(value))
    ? '—'
    : formatTR(String(value), digits);
}
