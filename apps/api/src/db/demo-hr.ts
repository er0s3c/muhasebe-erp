/**
 * Demo verisi: insan kaynakları tamamlayıcıları (bordro, personel cari/avans, sosyal güvenlik, yabancı işçi belgeleri).
 * `demo.ts` içindeki `seedDemo` puantaj kurulduktan sonra çağırır. Yasal oran/parametre değeri KODDA YOKTUR (bkz. LEGAL-NOTES):
 * burada girilenler yalnızca gösterim içindir; hepsi kaynak notunda "demo değeri" yazar ve DOĞRULANMAMIŞ bırakılır,
 * böylece ekranlar dolu görünür ama bordro/bildirimde "doğrulanmadı" uyarısı çıkar.
 */
import { asc, eq } from 'drizzle-orm';
import { monthBounds, todayIso } from '@erp/shared';
import type { Tx } from './client';
import { employees } from './schema';
import { giveAdvance, paySalary, repayAdvance, setRunAdvanceDeductions, updateLedgerSettings } from '../modules/employee-ledger/service';
import { createItem, createParam, createTerm } from '../modules/payroll/config';
import { approveRun, createRun, getRun, setAdjustment } from '../modules/payroll/runs';
import { createEligibility, createProfile, createRule } from '../modules/socialsecurity/config';
import { buildDeclaration, finalizeDeclaration } from '../modules/socialsecurity/declarations';
import { createDoc, createType, renewDoc } from '../modules/foreignworkers/docs';
import { createGuarantee } from '../modules/foreignworkers/guarantees';
import { createParam as createForeignParam } from '../modules/foreignworkers/params';
import type { LedgerCtx } from '../modules/ledger/journal';

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export async function seedHr(tx: Tx, ctx: LedgerCtx, opts: { secret: string; cashId: string; bankTlId: string; yearStart: string }): Promise<string> {
  const today = todayIso();
  const prev = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1));
  const month = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  const { start, end } = monthBounds(month);
  const emps = await tx.select().from(employees).orderBy(asc(employees.code));
  if (emps.length < 4) return 'İK: personel yok';
  const [hasan, murat, emre, zeynep] = emps as [(typeof emps)[number], (typeof emps)[number], (typeof emps)[number], (typeof emps)[number]];
  const from = opts.yearStart;
  const pctx = { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: ctx.baseCurrency, reportingCurrency: ctx.reportingCurrency };
  const sctx = { companyId: ctx.companyId, userId: ctx.userId, secret: opts.secret };
  const note = 'Demo değeri; yasal oran/tutar değildir, doğrulanmamıştır';

  // ---- Bordro: ücret şartları, parametreler (doğrulanmamış demo değerleri), ek ödeme kalemi, aylık bordro ----
  for (const [e, basis, amount] of [
    [hasan, 'monthly', '42000'],
    [murat, 'monthly', '38000'],
    [emre, 'daily', '1250'],
    [zeynep, 'monthly', '55000'],
  ] as const) {
    await createTerm(tx, pctx, { employeeId: e.id, effectiveFrom: addDays(start, -40), payBasis: basis, amount });
  }
  for (const [key, value] of [
    ['days_per_month', '30'],
    ['hours_per_day', '8'],
    ['overtime_multiplier', '1.5'],
    ['employee_social_pct', '10'],
    ['employer_social_pct', '12'],
    ['income_tax_pct', '15'],
  ] as const) {
    await createParam(tx, pctx, { key, value, effectiveFrom: from, enabled: true, sourceNote: note });
  }
  const meal = await createItem(tx, pctx, { code: 'YMK', name: 'Yemek yardımı', kind: 'earning', affectsSocialBase: false, affectsTaxBase: false, liability: 'other' });

  // ---- Personel cari: avanslar (biri bordrodan kesilir, biri kısmen iade edilir) ----
  const advDate = addDays(start, 3);
  const adv1 = await giveAdvance(tx, ctx, { employeeId: emre.id, date: advDate, amount: '6000', purpose: 'Şantiye yakınında kira avansı', treasuryAccountId: opts.cashId });
  const adv2 = await giveAdvance(tx, ctx, { employeeId: murat.id, date: addDays(start, 8), amount: '4000', purpose: 'Aile sağlık gideri avansı', treasuryAccountId: opts.cashId });
  await repayAdvance(tx, ctx, (adv2.advance as { id: string }).id, { amount: '1000', date: addDays(start, 20), treasuryAccountId: opts.cashId, note: 'Elden iade' });

  const run = await createRun(tx, pctx, { month, description: 'Demo bordro' });
  const runId = (run as { run: { id: string } }).run.id;
  // ek ödeme: yemek yardımı (iki personele)
  await setAdjustment(tx, pctx, runId, { employeeId: hasan.id, itemId: (meal as { id: string }).id, amount: '2500' });
  await setAdjustment(tx, pctx, runId, { employeeId: zeynep.id, itemId: (meal as { id: string }).id, amount: '2500' });
  await setRunAdvanceDeductions(tx, ctx, runId, { employeeId: emre.id, deductions: [{ advanceId: (adv1.advance as { id: string }).id, amount: '2000' }] });
  await approveRun(tx, pctx, runId);

  // Net maaşlar personel cari üzerinden banka çıkışıyla ödenir: iki personel ödendi, ikisi bekliyor (bordro onaylı, kısmen ödenmiş)
  const approved = await getRun(tx, runId);
  for (const l of approved.lines.filter((x) => [hasan.id, zeynep.id].includes(x.employeeId as string))) {
    await paySalary(tx, ctx, { employeeId: l.employeeId as string, date: end, amount: String(l.net).replace(/0+$/, '').replace(/\.$/, ''), treasuryAccountId: opts.bankTlId, payrollRunId: runId, note: 'Demo: bordro net ödemesi' });
  }
  await updateLedgerSettings(tx, ctx, { deductionCapPct: '50', sourceNote: 'Demo değeri; yasal sınır değildir, doğrulanmamıştır' });

  // ---- Sosyal güvenlik: profiller, destek kuralı (demo), uygunluk, aylık bildirim ----
  for (const [e, no] of [
    [hasan, 'SGK-1000101'],
    [murat, 'SGK-1000102'],
    [emre, 'SGK-1000103'],
    [zeynep, 'SGK-1000104'],
  ] as const) {
    await createProfile(tx, sctx, { employeeId: e.id, effectiveFrom: from, payrollTypeCode: 'A', insuranceStart: e.hireDate ?? from, socialSecurityNo: no });
  }
  await createRule(tx, sctx, {
    code: 'DST-DEMO',
    name: 'Demo işveren primi desteği',
    effectiveFrom: from,
    target: 'employer',
    mode: 'percent_of_premium',
    value: '10',
    sourceNote: note,
    enabled: true,
  });
  await createEligibility(tx, sctx, { employeeId: zeynep.id, ruleCode: 'DST-DEMO', validFrom: from, note: 'Demo: teknik personel' });
  const decl = await buildDeclaration(tx, sctx, month);
  await finalizeDeclaration(tx, sctx, decl.declaration.id, 'Demo: bildirim kesinleştirildi');

  // ---- Yabancı işçi belgeleri ----
  await tx.update(employees).set({ nationality: 'Pakistan' }).where(eq(employees.id, emre.id));
  await tx.update(employees).set({ nationality: 'Bangladeş' }).where(eq(employees.id, murat.id));
  const work = await createType(tx, ctx.companyId, { code: 'CALISMA', name: 'Çalışma izni' });
  const res = await createType(tx, ctx.companyId, { code: 'IKAMET', name: 'İkamet izni' });
  await createForeignParam(tx, sctx, { key: 'guarantee_amount', value: '15000', currency: 'TRY', effectiveFrom: from, sourceNote: note, enabled: true });
  await createForeignParam(tx, sctx, { key: 'expiry_warning_days', value: '60', effectiveFrom: from, sourceNote: note, enabled: true });
  const docNo = await createDoc(tx, sctx, { employeeId: emre.id, typeId: (work as { id: string }).id, documentNo: 'CI-2026-0042', issuingAuthority: 'Çalışma Dairesi', issueDate: addDays(today, -300), expiryDate: addDays(today, 40), referenceNote: 'Demo: yakında bitiyor' });
  await createDoc(tx, sctx, { employeeId: emre.id, typeId: (res as { id: string }).id, documentNo: 'IK-2026-0099', issuingAuthority: 'Göç İdaresi', issueDate: addDays(today, -200), expiryDate: addDays(today, 165) });
  const lapsed = await createDoc(tx, sctx, { employeeId: murat.id, typeId: (work as { id: string }).id, documentNo: 'CI-2025-0311', issuingAuthority: 'Çalışma Dairesi', issueDate: addDays(today, -400), expiryDate: addDays(today, -12), referenceNote: 'Demo: yenilenecek' });
  await renewDoc(tx, sctx, (lapsed as { id: string }).id, { issueDate: addDays(today, -5), expiryDate: addDays(today, 360), documentNo: 'CI-2026-0420', note: 'Demo: yenilendi' });
  await createDoc(tx, sctx, { employeeId: murat.id, typeId: (res as { id: string }).id, documentNo: 'IK-2025-0150', issuingAuthority: 'Göç İdaresi', issueDate: addDays(today, -380), expiryDate: addDays(today, -15), referenceNote: 'Demo: süresi dolmuş' });
  await createGuarantee(tx, sctx, { employeeId: emre.id, docId: (docNo as { id: string }).id, depositedDate: addDays(today, -120), depositReference: 'Dekont 118' });

  return `İK: bordro ${month} (onaylı, 2 net ödeme), 2 avans, sosyal güvenlik bildirimi, yabancı işçi belgeleri`;
}
