import { eq, inArray, sql } from 'drizzle-orm';
import {
  ACCOUNT_MAPPING_KEYS,
  defaultMappingCodes,
  type AccountMappingKey,
  type Sector,
  type UpdateAccountMappingsInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { accountMappings, accounts } from '../../db/schema';
import { unprocessable } from '../../http/errors';

/** Eşleme anahtarlarının Türkçe adları (hata iletisi ve ekran için). */
export const MAPPING_LABELS: Record<AccountMappingKey, string> = {
  receivable: 'Alıcılar (müşteri cari hesabı)',
  payable: 'Satıcılar (tedarikçi cari hesabı)',
  sales_revenue: 'Satış geliri',
  sales_return: 'Satıştan iadeler',
  cogs: 'Satılan malın maliyeti',
  stock: 'Stok hesabı',
  vat_output: 'Hesaplanan KDV',
  vat_input: 'İndirilecek KDV',
  default_expense: 'Varsayılan gider hesabı',
  stock_gain: 'Stok fazlası geliri',
  stock_loss: 'Stok fire ve noksanlık zararı',
  consumption: 'Stok sarfı (malzeme gideri)',
  opening_offset: 'Stok devri karşı hesabı',
  fx_gain: 'Kambiyo kârı (gerçekleşen kur farkı)',
  fx_loss: 'Kambiyo zararı (gerçekleşen kur farkı)',
  subcontract_cost: 'Taşeron hakediş maliyeti',
  retention_payable: 'Taşeron teminat borcu (tutulan teminat)',
  withholding_payable: 'Taşeron hakedişinden kesilen stopaj borcu',
  subcontract_advance: 'Taşerona verilen avanslar',
};

/** Hesap kontrol türü kuralı: yalnızca cari eşlemeleri kontrol hesabı olabilir. */
const REQUIRED_CONTROL: Partial<Record<AccountMappingKey, 'receivable' | 'payable'>> = {
  receivable: 'receivable',
  payable: 'payable',
};

export interface MappedAccount {
  id: string;
  code: string;
  name: string;
}

export async function loadMappings(tx: Tx): Promise<Map<AccountMappingKey, MappedAccount>> {
  const rows = await tx
    .select({ key: accountMappings.key, id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accountMappings)
    .innerJoin(accounts, eq(accounts.id, accountMappings.accountId));
  return new Map(rows.map((r) => [r.key as AccountMappingKey, { id: r.id, code: r.code, name: r.name }]));
}

/** Gereken eşlemelerin hesap kimliklerini döndürür; eksik olan varsa açık bir hatayla durur. */
export async function requireMappings<K extends AccountMappingKey>(
  tx: Tx,
  keys: readonly K[],
): Promise<Record<K, string>> {
  const all = await loadMappings(tx);
  const missing = keys.filter((k) => !all.has(k));
  if (missing.length > 0) {
    throw unprocessable(
      `Hesap eşlemesi eksik: ${missing.map((k) => MAPPING_LABELS[k]).join(', ')}. Ayarlar > Hesap eşlemesi bölümünden tanımlayın`,
      'ACCOUNT_MAPPING_MISSING',
      { keys: missing },
    );
  }
  return Object.fromEntries(keys.map((k) => [k, all.get(k)!.id])) as Record<K, string>;
}

/** Tüm anahtarlar, eşlenmemişse hesap alanları null. */
export async function listMappings(tx: Tx) {
  const all = await loadMappings(tx);
  return ACCOUNT_MAPPING_KEYS.map((key) => {
    const a = all.get(key);
    return { key, label: MAPPING_LABELS[key], accountId: a?.id ?? null, accountCode: a?.code ?? null, accountName: a?.name ?? null };
  });
}

/** Yeni şirket için varsayılan eşlemeler (hesap planı yüklendikten sonra). Bulunamayan hesap atlanır. */
export async function seedMappings(tx: Tx, companyId: string, sector: Sector): Promise<void> {
  const codes = defaultMappingCodes(sector);
  const found = await tx
    .select({ id: accounts.id, code: accounts.code })
    .from(accounts)
    .where(inArray(accounts.code, [...new Set(Object.values(codes))]));
  const byCode = new Map(found.map((a) => [a.code, a.id]));
  const rows = ACCOUNT_MAPPING_KEYS.flatMap((key) => {
    const accountId = byCode.get(codes[key]);
    return accountId ? [{ companyId, key, accountId }] : [];
  });
  if (rows.length > 0) await tx.insert(accountMappings).values(rows);
}

export async function updateMappings(tx: Tx, companyId: string, input: UpdateAccountMappingsInput) {
  const entries = Object.entries(input.mappings) as [AccountMappingKey, string][];
  const ids = [...new Set(entries.map(([, id]) => id))];
  const rows = ids.length ? await tx.select().from(accounts).where(inArray(accounts.id, ids)) : [];
  const byId = new Map(rows.map((a) => [a.id, a]));

  for (const [key, accountId] of entries) {
    const a = byId.get(accountId);
    const label = MAPPING_LABELS[key];
    if (!a) throw unprocessable(`${label}: hesap bulunamadı`, 'ACCOUNT_NOT_FOUND');
    if (!a.isPostable) throw unprocessable(`${label}: ${a.code} hesabına kayıt atılamaz (alt hesabı var)`, 'ACCOUNT_NOT_POSTABLE');
    if (!a.isActive) throw unprocessable(`${label}: ${a.code} hesabı pasif`, 'ACCOUNT_INACTIVE');
    if (a.currencyCode) {
      throw unprocessable(`${label}: ${a.code} dövizli bir hesaptır; otomatik yevmiye için uygun değil`, 'MAPPING_ACCOUNT_CURRENCY');
    }
    const control = REQUIRED_CONTROL[key];
    if (control && a.partyControl !== control) {
      throw unprocessable(`${label}: ${a.code} hesabı ${control === 'receivable' ? 'müşteri' : 'tedarikçi'} cari kontrol hesabı olmalı`, 'MAPPING_CONTROL_MISMATCH');
    }
    if (!control && a.partyControl) {
      throw unprocessable(`${label}: ${a.code} bir cari kontrol hesabıdır; buraya seçilemez`, 'MAPPING_CONTROL_MISMATCH');
    }
  }

  for (const [key, accountId] of entries) {
    await tx
      .insert(accountMappings)
      .values({ companyId, key, accountId })
      .onConflictDoUpdate({
        target: [accountMappings.companyId, accountMappings.key],
        set: { accountId, updatedAt: sql`now()` },
      });
  }
  return listMappings(tx);
}
