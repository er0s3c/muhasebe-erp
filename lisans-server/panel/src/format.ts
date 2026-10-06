export const SECTOR_LABELS: Record<string, string> = {
  CONSTRUCTION: 'İnşaat ve taahhüt',
  RETAIL_MARKET: 'Market ve perakende',
  COMMERCE: 'Ticaret',
};
export const KIND_LABELS: Record<string, string> = { commercial: 'Ticari', trial: 'Deneme', demo: 'Demo' };
export const STATUS_LABELS: Record<string, string> = { active: 'Etkin', suspended: 'Askıda', revoked: 'İptal' };
export const STATUS_TONES = { active: 'success', suspended: 'warning', revoked: 'danger' } as const;

const dateFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Nicosia', day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Nicosia', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const dayFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' });

export const fmtDate = (iso: string | null | undefined) => (iso ? dateFmt.format(new Date(iso)) : '—');
/** Abonelik bitişi takvim günüdür: sunucu "yyyy-MM-dd" girdisini o günün UTC sonu (23:59:59.999Z) olarak saklar; yerel saatle gösterilirse ertesi güne kayar. */
export const fmtDay = (iso: string | null | undefined) => (iso ? dayFmt.format(new Date(iso)) : '—');
export const fmtDateTime = (iso: string | null | undefined) => (iso ? dateTimeFmt.format(new Date(iso)) : '—');
/** ISO zamanı <input type="date"> değerine (yyyy-MM-dd) çevirir. */
export const toDateInput = (iso: string) => new Date(iso).toISOString().slice(0, 10);

export const AUDIT_LABELS: Record<string, string> = {
  'admin.login': 'Yönetici girişi',
  'admin.login_failed': 'Başarısız yönetici girişi',
  'customer.create': 'Müşteri oluşturuldu',
  'customer.update': 'Müşteri güncellendi',
  'customer.delete': 'Müşteri silindi',
  'license.create': 'Lisans verildi',
  'license.update': 'Lisans güncellendi',
  'license.extend': 'Lisans uzatıldı',
  'license.suspend': 'Lisans askıya alındı',
  'license.resume': 'Lisans devam ettirildi',
  'license.revoke': 'Lisans iptal edildi',
  'license.code_regenerated': 'Etkinleştirme kodu yenilendi',
  'license.offline_lease': 'Çevrimdışı lisans imzalandı',
  'admin.create': 'Yönetici oluşturuldu',
  'admin.setup': 'İlk yönetici kurulumu',
  'admin.passkey_add': 'Giriş anahtarı eklendi',
  'admin.passkey_remove': 'Giriş anahtarı silindi',
  'admin.reset': 'Yönetici parolası/TOTP yenilendi',
  'activation.create': 'Kurulum etkinleştirildi',
  'activation.reactivate': 'Kurulum yeniden etkinleştirildi',
  'activation.deactivate': 'Kurulum devre dışı bırakıldı',
  'activation.clear_flag': 'Klon şüphesi bayrağı kaldırıldı',
  'release.create': 'Sürüm taslağı oluşturuldu',
  'release.file': 'Sürüm kiti yüklendi',
  'release.publish': 'Sürüm yayımlandı (imzalandı)',
  'release.withdraw': 'Sürüm geri çekildi',
  'release.delete': 'Sürüm taslağı silindi',
  'release.send': 'Güncelleme müşterilere gönderildi',
  'release.cancel': 'Güncelleme gönderimi geri alındı',
};
