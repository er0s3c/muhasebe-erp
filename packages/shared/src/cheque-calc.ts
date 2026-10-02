import { daysBetween } from './foreign-calc';

/**
 * Çek/senet portföyü ve banka teminat mektubu için saf kurallar (Faz X1). Durum geçişleri veritabanı tetikleyicisinde
 * (`cheques_guard`) AYNI tabloyla denetlenir; bu dosya API ve arayüzün ortak doğruluk kaynağıdır.
 * Hiçbir yasal süre, oran ya da hesap kodu burada YOKTUR; uyarı günü kullanıcı ayarıdır.
 */
export const CHEQUE_DIRECTIONS = ['received', 'issued'] as const;
export type ChequeDirection = (typeof CHEQUE_DIRECTIONS)[number];

export const CHEQUE_DOC_TYPES = ['cheque', 'note'] as const;
export type ChequeDocType = (typeof CHEQUE_DOC_TYPES)[number];

/**
 * Alınan: portfolio (portföyde) → in_collection (tahsilde) → collected | bounced (karşılıksız);
 * portfolio → endorsed (ciro edildi) → portfolio (ciro iadesi); portfolio → returned (keşideciye iade).
 * Verilen: issued → paid | bounced | cancelled.
 */
export const CHEQUE_STATUSES = ['portfolio', 'in_collection', 'collected', 'bounced', 'endorsed', 'returned', 'issued', 'paid', 'cancelled'] as const;
export type ChequeStatus = (typeof CHEQUE_STATUSES)[number];

export const CHEQUE_ACTIONS = ['deposit', 'collect', 'bounce', 'return', 'endorse', 'unendorse', 'pay', 'cancel'] as const;
export type ChequeAction = (typeof CHEQUE_ACTIONS)[number];

export const CHEQUE_INITIAL_STATUS: Record<ChequeDirection, ChequeStatus> = { received: 'portfolio', issued: 'issued' };

interface Transition {
  from: ChequeStatus;
  to: ChequeStatus;
}

const TRANSITIONS: Record<ChequeDirection, Partial<Record<ChequeAction, Transition>>> = {
  received: {
    deposit: { from: 'portfolio', to: 'in_collection' },
    collect: { from: 'in_collection', to: 'collected' },
    bounce: { from: 'in_collection', to: 'bounced' },
    return: { from: 'portfolio', to: 'returned' },
    endorse: { from: 'portfolio', to: 'endorsed' },
    unendorse: { from: 'endorsed', to: 'portfolio' },
  },
  issued: {
    pay: { from: 'issued', to: 'paid' },
    bounce: { from: 'issued', to: 'bounced' },
    cancel: { from: 'issued', to: 'cancelled' },
  },
};

/** Eylemin bu yönde geçerli olup olmadığı ve (önceki, sonraki) durum; geçersizse null. */
export function chequeTransition(direction: ChequeDirection, action: ChequeAction): Transition | null {
  return TRANSITIONS[direction][action] ?? null;
}

/** Bir durumdan yapılabilecek eylemler. */
export function allowedChequeActions(direction: ChequeDirection, status: ChequeStatus): ChequeAction[] {
  return (Object.entries(TRANSITIONS[direction]) as [ChequeAction, Transition][]).filter(([, t]) => t.from === status).map(([a]) => a);
}

/** Veritabanı tetikleyicisinin kullandığı geçiş denetimi (yön + önceki + sonraki durum). */
export function isValidChequeStatusChange(direction: ChequeDirection, from: ChequeStatus, to: ChequeStatus): boolean {
  return Object.values(TRANSITIONS[direction]).some((t) => t.from === from && t.to === to);
}

/** Vade analizi ve nakit projeksiyonunda "açık" sayılan durumlar: portföyde/tahsilde olan alınan, ödenmemiş verilen. */
export const OPEN_CHEQUE_STATUSES: Record<ChequeDirection, readonly ChequeStatus[]> = {
  received: ['portfolio', 'in_collection'],
  issued: ['issued'],
};
export const isOpenCheque = (direction: ChequeDirection, status: ChequeStatus) => OPEN_CHEQUE_STATUSES[direction].includes(status);

/** Her eylem için hangi cariyle ilgili olduğu: ciro (tedarikçi), diğerleri belge carisi. */
export const CHEQUE_ACTION_NEEDS_BANK: readonly ChequeAction[] = ['deposit', 'pay'];

// --- Vade analizi ----------------------------------------------------------------------------------------------

export const MATURITY_BUCKETS = ['overdue', 'd0_7', 'd8_30', 'd31_60', 'd61_90', 'd90p'] as const;
export type MaturityBucket = (typeof MATURITY_BUCKETS)[number];

/** Vade günü kovası: vadesi geçmiş, 0–7, 8–30, 31–60, 61–90, 90+ gün (değerlendirme gününe göre). */
export function maturityBucket(dueDate: string, asOf: string): MaturityBucket {
  const d = daysBetween(asOf, dueDate);
  if (d < 0) return 'overdue';
  if (d <= 7) return 'd0_7';
  if (d <= 30) return 'd8_30';
  if (d <= 60) return 'd31_60';
  if (d <= 90) return 'd61_90';
  return 'd90p';
}

// --- Banka teminat mektubu ---------------------------------------------------------------------------------------

export const GUARANTEE_DIRECTIONS = ['given', 'received'] as const;
export type GuaranteeDirection = (typeof GUARANTEE_DIRECTIONS)[number];

/** active → returned (iade) | liquidated (nakde çevrildi) | expired (süresi doldu, kapatıldı). */
export const BANK_GUARANTEE_STATUSES = ['active', 'returned', 'liquidated', 'expired'] as const;
export type BankGuaranteeStatus = (typeof BANK_GUARANTEE_STATUSES)[number];

export type GuaranteeExpiryState = 'none' | 'ok' | 'expiring' | 'lapsed';

/**
 * Aktif mektubun süre durumu. `warningDays` kullanıcı ayarıdır (null = tanımsız: "dolmak üzere" üretilmez).
 * Son kullanma günü dahil geçerlidir; ertesi gün `lapsed` (süresi geçmiş ama henüz kapatılmamış).
 */
export function guaranteeExpiryState(expiryDate: string | null, today: string, warningDays: number | null): { state: GuaranteeExpiryState; daysToExpiry: number | null } {
  if (!expiryDate) return { state: 'none', daysToExpiry: null };
  const days = daysBetween(today, expiryDate);
  if (days < 0) return { state: 'lapsed', daysToExpiry: days };
  if (warningDays !== null && days <= warningDays) return { state: 'expiring', daysToExpiry: days };
  return { state: 'ok', daysToExpiry: days };
}
