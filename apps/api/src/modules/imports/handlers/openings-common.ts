import { eq } from 'drizzle-orm';
import { dec, isoYear, toDbRate, type ImportMessage, type MoneyValue, type NumberFormat } from '@erp/shared';
import type { Tx } from '../../../db/client';
import { accounts } from '../../../db/schema';
import { loadMappings } from '../../ledger/mappings';
import { findPeriodForDate } from '../../settings/periods';
import { findRate } from '../../settings/rates';
import { parseDecimal, type Parsed } from '../values';

const generalError = (code: string, message: string): ImportMessage => ({ severity: 'error', code, message });

/** Açılış tarihinin dönemi tanımlı ve açık mı? Değilse tek bir genel hata iletisi döner. */
export async function periodProblem(tx: Tx, date: string): Promise<ImportMessage | null> {
  const period = await findPeriodForDate(tx, date);
  if (!period) {
    return generalError('PERIOD_MISSING', `${date} tarihi için dönem tanımlı değil. Ayarlar > Dönemler'den ${isoYear(date)} yılını oluşturun.`);
  }
  if (period.status !== 'open') {
    return generalError('PERIOD_CLOSED', `${period.year}-${String(period.month).padStart(2, '0')} dönemi kapalı; açılış tarihini açık bir döneme alın`);
  }
  return null;
}

export interface OffsetAccount {
  id: string;
  code: string;
  name: string;
}

/**
 * Açılış karşı hesabı: seçilmişse doğrulanır, yoksa `opening_offset` eşlemesi. Sorun varsa `general`'a hata
 * eklenir ve null döner. (Hesap kuralları yevmiye motorunda da denetlenir; burada önizlemede açık bir ileti için.)
 */
export async function resolveOffsetAccount(tx: Tx, accountId: string | undefined, general: ImportMessage[]): Promise<OffsetAccount | null> {
  if (accountId) {
    const [a] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
    if (!a) {
      general.push(generalError('OFFSET_ACCOUNT_NOT_FOUND', 'Karşı hesap bulunamadı'));
      return null;
    }
    const problem = !a.isActive
      ? 'pasif'
      : !a.isPostable
        ? 'alt hesabı olduğu için kayıt atılamaz'
        : a.currencyCode
          ? 'dövizli bir hesap'
          : a.partyControl
            ? 'cari kontrol hesabı'
            : null;
    if (problem) {
      general.push(generalError('OFFSET_ACCOUNT_INVALID', `Karşı hesap (${a.code}) kullanılamaz: ${problem}`));
      return null;
    }
    return { id: a.id, code: a.code, name: a.name };
  }
  const mapped = (await loadMappings(tx)).get('opening_offset');
  if (!mapped) {
    general.push(generalError('ACCOUNT_MAPPING_MISSING', 'Açılış karşı hesabı eşlemesi eksik. Ayarlar > Hesap eşlemesi bölümünden "Stok devri karşı hesabı"nı tanımlayın ya da karşı hesabı seçin'));
    return null;
  }
  return mapped;
}

/** Bir para birimi için kur: satırda yazılı (tam 8 basamağa yuvarlanmış) ya da açılış tarihindeki kayıtlı kur. */
export function fxResolver(tx: Tx, base: string, date: string, format: NumberFormat) {
  const cache = new Map<string, MoneyValue | null>();
  return async (currency: string, text: string): Promise<Parsed<MoneyValue>> => {
    if (currency === base) return { ok: true, value: dec(1) };
    if (text !== '') {
      const p = parseDecimal(text, format, { maxDp: 8 });
      if (!p.ok) return { ok: false, code: p.code, message: `Kur: ${p.message}` };
      if (dec(p.value).lte(0)) return { ok: false, code: 'FX_RATE_INVALID', message: 'Kur sıfırdan büyük olmalı' };
      return { ok: true, value: dec(toDbRate(p.value)) };
    }
    if (!cache.has(currency)) {
      const r = await findRate(tx, currency, base, date, base);
      cache.set(currency, r ? dec(toDbRate(r)) : null);
    }
    const r = cache.get(currency);
    if (!r) return { ok: false, code: 'FX_RATE_MISSING', message: `${currency}/${base} kuru bulunamadı (${date} ve önceki günler); satıra kur yazın ya da önce Ayarlar > Kurlar'dan girin` };
    return { ok: true, value: r };
  };
}
