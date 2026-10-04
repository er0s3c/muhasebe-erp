/**
 * Demo verisi: ithalat dosyası (landed cost) ve onay kuralları. `seedDemo` sonunda çağrılır.
 * Hiçbir oran/vergi kuralı yoktur: navlun, gümrük vb. tutarlar girilen demo değerleridir (LEGAL-NOTES §3).
 */
import { sql } from 'drizzle-orm';
import { todayIso } from '@erp/shared';
import type { Tx } from './client';
import { createRule } from '../modules/approvals/service';
import { createRequest, listInventory, resolveRequest } from '../modules/hr/privacy';
import { putProcurementSettings } from '../modules/procurement/matching';
import { getBalances, releaseRetention, type ProgressCtx } from '../modules/subcontracts/progress';
import { allocateImportFile, postImportFile, saveImportFile, type ImportCtx } from '../modules/landed/service';
import type { LedgerCtx } from '../modules/ledger/journal';

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export async function seedImports(tx: Tx, ctx: LedgerCtx, partyId: Map<string, string>): Promise<string> {
  const today = todayIso();
  const monthStart = `${today.slice(0, 7)}-01`;
  const recent = (n: number) => {
    const d = addDays(today, -n);
    return d < monthStart ? monthStart : d;
  };
  const ictx: ImportCtx = { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: ctx.baseCurrency, reportingCurrency: ctx.reportingCurrency, allowNegativeStock: false };

  // İthal seramik: EUR alış faturasının satırı (Haziran) — dosya açık bir dönemde muhasebeleştirilir
  const src = (await tx.execute<{ id: string }>(sql`
    select il.id from invoice_lines il join invoices i on i.id = il.invoice_id
     where i.type = 'purchase' and i.status = 'posted' and i.currency_code = 'EUR' order by i.invoice_date limit 1`)).rows[0];
  if (!src) return 'ithalat: kaynak fatura bulunamadı';

  const saved = await saveImportFile(tx, ictx, null, {
    name: 'Seramik ithalatı — Haziran sevkiyatı',
    reference: 'GB-2026/0412',
    description: 'EUR faturalı seramik; navlun ve gümrük masrafları stok maliyetine dağıtılır',
    method: 'value',
    fileDate: recent(5),
    lines: [{ sourceKind: 'invoice', sourceLineId: src.id }],
    costLines: [
      { kind: 'freight', description: 'Deniz navlunu', partyId: partyId.get('oto')!, amount: '18500', reference: 'NV-5521' },
      { kind: 'customs_duty', description: 'Gümrük vergisi (demo tutarı)', amount: '24000', reference: 'GB-2026/0412' },
      { kind: 'brokerage', description: 'Gümrük komisyoncusu', partyId: partyId.get('beton')!, amount: '3200' },
    ],
  });
  const fileId = saved.file.id;
  await allocateImportFile(tx, ictx, fileId, {});
  await postImportFile(tx, ictx, fileId, { date: recent(4) });

  // İkinci dosya taslak kalır (dağıtım yapılmadı)
  await saveImportFile(tx, ictx, null, {
    name: 'Kablo ithalatı — planlanan',
    reference: 'TASLAK-2',
    method: 'quantity',
    fileDate: recent(1),
    lines: [],
    costLines: [{ kind: 'freight', description: 'Tahmini navlun', amount: '9000' }],
  });
  return 'ithalat: 2 dosya (1 muhasebeleşti, 1 taslak)';
}

export async function seedApprovalRules(tx: Tx, ctx: LedgerCtx): Promise<string> {
  await createRule(tx, ctx.companyId, { docType: 'purchase_request', minAmount: '0', maxAmount: '100000', separateRequester: true, steps: [{ role: 'site_manager', label: 'Şantiye şefi' }] });
  await createRule(tx, ctx.companyId, { docType: 'purchase_request', minAmount: '100000', separateRequester: true, steps: [{ role: 'accountant', label: 'Muhasebe' }, { role: 'owner', label: 'Yönetim' }] });
  await createRule(tx, ctx.companyId, { docType: 'progress_payment', minAmount: '0', separateRequester: true, steps: [{ role: 'owner', label: 'Proje müdürü / yönetim' }] });
  await createRule(tx, ctx.companyId, { docType: 'variation_order', minAmount: '0', separateRequester: false, steps: [{ role: 'admin' }] });
  return 'onay: 4 kural';
}

/** Ayarlar ve küçük kayıtlar: tedarik toleransları, veri koruma envanteri/talepleri, taşeron teminat iadesi. */
export async function seedSettingsMisc(tx: Tx, ctx: LedgerCtx): Promise<string> {
  const today = todayIso();
  await putProcurementSettings(tx, ctx.companyId, { qtyTolerancePct: '2', priceTolerancePct: '3' });

  // Veri koruma: envanter ilk okunuşta oluşur; iki ilgili kişi talebi (biri sonuçlandı)
  await listInventory(tx, ctx.companyId);
  const [emp] = (await tx.execute<{ id: string }>(sql`select id from employees order by code limit 1`)).rows;
  const dctx = { companyId: ctx.companyId, userId: ctx.userId };
  const r1 = await createRequest(tx, dctx, { employeeId: emp?.id ?? null, requesterName: 'Hasan Öztürk', kind: 'access', description: 'Kişisel verilerimin bir kopyasını talep ediyorum.' });
  await resolveRequest(tx, { userId: ctx.userId }, r1.id, { outcome: 'completed', resolutionNote: 'Personel kartı çıktısı elden teslim edildi.' });
  await createRequest(tx, dctx, { requesterName: 'Selin Aydın', kind: 'erasure', description: 'Rehberden kaydımın silinmesini istiyorum (demo).' });

  // Taşeron hakedişinden tutulan teminatın bir kısmı iade edilir
  const pgctx: ProgressCtx = { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: ctx.baseCurrency, reportingCurrency: ctx.reportingCurrency };
  const [sub] = (await tx.execute<{ id: string }>(sql`select id from subcontracts where direction = 'payable' and status = 'active' order by code limit 1`)).rows;
  let released = '';
  if (sub) {
    const bal = await getBalances(tx, sub.id);
    if (Number(bal.retentionBalance) > 0) {
      const amount = (Number(bal.retentionBalance) / 2).toFixed(2);
      await releaseRetention(tx, pgctx, sub.id, { date: today, amount, note: 'Demo: teminatın yarısı iade edildi' });
      released = ', taşeron teminat iadesi';
    }
  }
  return `ayarlar: tedarik toleransı, veri koruma envanteri ve 2 talep${released}`;
}
