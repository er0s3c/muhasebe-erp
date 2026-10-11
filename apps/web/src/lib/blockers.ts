import { ApiError } from './api';

/** Engeli kaldıran ekran: kullanıcı bağlantıyla doğrudan çözüme gider. */
export interface BlockerFix { label: string; to: string }
/**
 * Kullanılamayan işlemin açıklaması (öneri 28). `fix` kullanıcının açabileceği çözüm ekranıdır; çözüm kullanıcının
 * yetkisinde değilse `ask` kime başvuracağını söyler. İkisi birlikte verilmez.
 */
export interface Blocker { reason: string; fix?: BlockerFix; ask?: string }

type Can = (permission: string) => boolean;

const ASK_ADMIN = 'Yetki için şirket yöneticinize başvurun.';
const ASK_ACCOUNTING = 'Dönemi açması için muhasebe yöneticinize başvurun.';
const ACCESS_CODES = new Set(['FORBIDDEN', 'MODULE_ACCESS_DENIED', 'MODULE_READ_ONLY', 'RESOURCE_OPERATION_DENIED']);

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});
const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null);
const uuid = (value: unknown) => (typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null);
const year = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value > 1900 && value < 3000 ? value : null);

/**
 * Sunucu engel hatasından çözüm yolu: kodla birlikte gelen ayrıntı (dönem, iade faturası, kapatan hareket, banka hesabı)
 * ilgili ekrana bağlanır. Bağlantı yalnız kullanıcının açabileceği ekran içindir; sunucu her işlemi yine kendisi denetler.
 */
export function errorFix(err: unknown, can: Can): Pick<Blocker, 'fix' | 'ask'> | null {
  if (!(err instanceof ApiError)) return null;
  const d = record(err.details);
  switch (err.code) {
    case 'FX_RATE_MISSING':
      return { fix: { label: 'Kur gir', to: '/settings/currencies' } };
    case 'PERIOD_CLOSED': {
      const y = year(d.year);
      return can('ledger.close_period') ? { fix: { label: 'Mali dönemleri aç', to: y ? `/settings/periods?year=${y}` : '/settings/periods' } } : { ask: ASK_ACCOUNTING };
    }
    case 'PERIOD_MISSING': {
      const y = year(d.year);
      return can('settings.manage') ? { fix: { label: 'Mali yılı oluştur', to: y ? `/settings/periods?year=${y}` : '/settings/periods' } } : { ask: ASK_ACCOUNTING };
    }
    case 'INVOICE_HAS_RETURNS': {
      const id = uuid(d.invoiceId);
      return id ? { fix: { label: `${text(d.invoiceNo) ?? 'İade'} faturasını aç`, to: `/invoices/${id}` } } : null;
    }
    case 'INVOICE_HAS_PAYMENTS': {
      const settlements = Array.isArray(d.settlements) ? d.settlements.map(record) : [];
      const treasury = settlements.find((s) => s.kind === 'treasury' && uuid(s.id));
      if (treasury && can('treasury.read')) return { fix: { label: `${text(treasury.ref) ?? 'Tahsilat/ödeme'} hareketini aç`, to: `/treasury/transactions?open=${treasury.id as string}` } };
      if (settlements.some((s) => s.kind === 'cheque') && can('treasury.read')) return { fix: { label: 'Çek/senetleri aç', to: '/treasury/cheques' } };
      return null;
    }
    case 'TXN_RECONCILED': {
      const id = uuid(d.accountId);
      return id ? { fix: { label: 'Banka ekstresi eşleşmesini aç', to: `/treasury/accounts/${id}?tab=bank` } } : null;
    }
    case 'MODULE_DISABLED':
      return can('settings.manage') ? { fix: { label: 'Modülleri yönet', to: '/settings/modules' } } : { ask: ASK_ADMIN };
    default:
      return ACCESS_CODES.has(err.code) ? { ask: ASK_ADMIN } : null;
  }
}

/** Yetki eksikliği yüzünden pasif kalan işlem için açıklama. */
export function permissionBlocker(action: string, can: Can): Blocker {
  return can('members.manage')
    ? { reason: `${action} için yetkiniz yok.`, fix: { label: 'Üye yetkilerini düzenle', to: '/settings/members' } }
    : { reason: `${action} için yetkiniz yok.`, ask: ASK_ADMIN };
}
