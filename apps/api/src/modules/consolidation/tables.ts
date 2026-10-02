import { dec, formatDateTR, KPI_DEFINITIONS, toDbAmount, type Kpis } from '@erp/shared';
import type { ReportTable } from '../../files/table';
import { col } from '../exports/builders';
import type { ConsolidatedReport } from './report';
import type { CompanyFxPosition, GroupFxPosition } from './fx-position';
import type { ExecutiveSummary } from './executive';

const period = (from: string, to: string) => `${formatDateTR(from)} – ${formatDateTR(to)}`;
const NOTE = 'Not: DOĞRULANMADI — kur çevrimi, eliminasyon ve eşleme yöntemi bir muhasebe standardına dayanmaz; iç yönetim raporudur.';
const EXCLUDED_TEXT = (n: number) => (n > 0 ? ` · EKSİK: ${n} şirket doğrulamayı geçemedi ve rapordan düştü` : '');

/** Konsolide mizan, bilanço, gelir tablosu ve eliminasyon listesi (ilk tablo CSV'ye de gider). */
export function consolidatedTables(r: ConsolidatedReport): ReportTable[] {
  const g = r.group.reportingCurrency;
  const sub = `${r.group.name} · ${period(r.period.from, r.period.to)} · ${g} · kapanış kuru ${formatDateTR(r.period.closingDate)}, gelir tablosu kuru: ${r.period.plMethod === 'average' ? 'dönem ortalaması' : 'kapanış'} · DOĞRULANMADI — kur ve eliminasyon yöntemi${EXCLUDED_TEXT(r.excluded.length)}`;
  const idx = r.companies.map((c, i) => ({ c, key: `c${i}` }));
  const companyCols = idx.map(({ c, key }) => col(key, `${c.name} (${g})`, 'money', 18, g));

  const tb: ReportTable = {
    key: 'konsolide-mizan',
    title: 'Konsolide mizan (net bakiye: borç − alacak)',
    sheet: 'Konsolide mizan',
    subtitle: sub,
    columns: [col('code', 'Hesap kodu', 'text', 12), col('name', 'Hesap adı', 'text', 34), ...companyCols, col('elim', `Eliminasyon (${g})`, 'money', 18, g), col('cons', `Konsolide (${g})`, 'money', 18, g), col('flag', 'Eşleşme', 'text', 18)],
    rows: [
      ...r.rows.map((x) => ({
        code: x.code,
        name: x.name,
        ...Object.fromEntries(idx.map(({ c, key }) => [key, x.perCompany[c.id] ?? '0'])),
        elim: x.elimination,
        cons: x.consolidated,
        flag: x.unmapped ? 'Eşleşmeyen kod' : '',
      })),
      {
        code: '',
        name: 'Çevrim farkı (kur ayrımı; doğrulanmadı)',
        ...Object.fromEntries(idx.map(({ c, key }) => [key, r.translationDiff[c.id] ?? '0'])),
        elim: '0.0000',
        cons: r.totals.translationDiff,
        flag: '',
      },
      { code: '', name: NOTE },
      ...(r.excluded.length ? [{ code: '', name: `EKSİK: ${r.excluded.length} şirket doğrulamayı geçemedi ve rapordan düştü` }] : []),
    ],
    totals: { ...Object.fromEntries(idx.map(({ c, key }) => [key, toDbAmount(dec(r.totals.perCompany[c.id] ?? 0).plus(r.translationDiff[c.id] ?? 0))])), elim: r.totals.elimination, cons: r.totals.consolidated },
  };

  const stmtCols = (): { cols: ReturnType<typeof col>[]; keyOf: (id: string) => string } => ({
    cols: [...idx.map(({ c, key }) => col(key, `${c.name} (${g})`, 'money', 18, g)), col('cons', `Konsolide (${g})`, 'money', 18, g)],
    keyOf: (id) => (id === 'consolidated' ? 'cons' : idx.find((x) => x.c.id === id)!.key),
  });
  const stmtRows = (lines: ConsolidatedReport['statements']['balanceSheet'], keyOf: (id: string) => string) =>
    lines.map((l) => ({ label: `${l.kind === 'detail' ? '   ' : ''}${l.label}`, ...Object.fromEntries(Object.entries(l.values).map(([id, v]) => [keyOf(id), v])) }));
  const sc = stmtCols();
  const bs: ReportTable = {
    key: 'konsolide-bilanco',
    title: 'Konsolide bilanço (gösterim; yasal biçim değil)',
    sheet: 'Bilanço',
    subtitle: sub,
    columns: [col('label', 'Kalem', 'text', 46), ...sc.cols],
    rows: stmtRows(r.statements.balanceSheet, sc.keyOf),
  };
  const is: ReportTable = {
    key: 'konsolide-gelir-tablosu',
    title: 'Konsolide gelir tablosu (gösterim; yasal biçim değil)',
    sheet: 'Gelir tablosu',
    subtitle: sub,
    columns: [col('label', 'Kalem', 'text', 46), ...sc.cols],
    rows: stmtRows(r.statements.incomeStatement, sc.keyOf),
  };
  const elim: ReportTable = {
    key: 'eliminasyonlar',
    title: 'Eliminasyon kayıtları (elle girilmiş; yöntem doğrulanmadı)',
    sheet: 'Eliminasyonlar',
    subtitle: sub,
    columns: [col('desc', 'Açıklama', 'text', 36), col('kind', 'Tür', 'text', 20), col('period', 'Dönem', 'text', 24), col('code', 'Hesap kodu', 'text', 12), col('debit', `Borç (${g})`, 'money', 16, g), col('credit', `Alacak (${g})`, 'money', 16, g)],
    rows: r.eliminations.flatMap((e) => e.lines.map((l) => ({ desc: e.description, kind: e.kind, period: period(e.periodFrom, e.periodTo), code: l.accountCode, debit: l.debit, credit: l.credit }))),
  };
  return [tb, bs, is, elim];
}

export function fxPositionTables(d: CompanyFxPosition): ReportTable[] {
  const b = d.company.baseCurrency;
  const sub = `${d.company.name} · ${formatDateTR(d.asOf)} itibarıyla · kur tarihi ${formatDateTR(d.rateDate)} · ${b} cinsinden · gerçekleşmemiş kur farkı TAHMİNDİR (yevmiye yazılmaz)`;
  return [
    {
      key: 'doviz-pozisyonu',
      title: 'Döviz pozisyon raporu',
      sheet: 'Döviz pozisyonu',
      subtitle: sub,
      columns: [col('cur', 'Para birimi', 'text', 12), col('cash', 'Kasa/banka', 'money', 16), col('rec', 'Açık alacak', 'money', 16), col('pay', 'Açık borç', 'money', 16), col('net', 'Net pozisyon', 'money', 16), col('rate', 'Kur', 'rate', 12), col('eq', `Karşılık (${b})`, 'money', 16, b), col('book', `Defter karşılığı (${b})`, 'money', 16, b), col('un', `Tahmini kur farkı (${b})`, 'money', 18, b)],
      rows: [
        ...d.rows.map((r) => ({ cur: r.currency, cash: r.cash, rec: r.receivables, pay: r.payables, net: r.net, rate: r.rate, eq: r.equivalent, book: r.bookNet, un: r.unrealized })),
        { cur: 'Not: gerçekleşmemiş kur farkı yalnızca TAHMİNDİR; yevmiye yazılmaz; yöntem doğrulanmadı.' },
      ],
      ...(d.totals ? { totals: { eq: d.totals.equivalent, un: d.totals.unrealized } } : {}),
    },
    {
      key: 'doviz-kasa-banka',
      title: 'Dövizli kasa/banka bakiyeleri',
      sheet: 'Kasa-banka',
      subtitle: sub,
      columns: [col('name', 'Hesap', 'text', 30), col('kind', 'Tür', 'text', 10), col('cur', 'Para birimi', 'text', 12), col('bal', 'Bakiye', 'money', 16), col('book', `Defter karşılığı (${b})`, 'money', 16, b)],
      rows: d.cashLines.map((c) => ({ name: c.accountName, kind: c.kind === 'cash' ? 'Kasa' : 'Banka', cur: c.currency, bal: c.balance, book: c.book })),
    },
  ];
}

export function groupFxPositionTables(d: GroupFxPosition): ReportTable[] {
  const g = d.group.reportingCurrency;
  const sub = `${d.group.name} · ${formatDateTR(d.asOf)} itibarıyla · ${g} cinsinden · yabancı para her şirketin kendi defter para birimine göre${EXCLUDED_TEXT(d.excluded.length)} · DOĞRULANMADI`;
  return [
    {
      key: 'grup-doviz-pozisyonu',
      title: 'Grup döviz pozisyonu (para birimi başına toplam)',
      sheet: 'Grup pozisyonu',
      subtitle: sub,
      columns: [col('cur', 'Para birimi', 'text', 12), col('cash', 'Kasa/banka', 'money', 16), col('rec', 'Açık alacak', 'money', 16), col('pay', 'Açık borç', 'money', 16), col('net', 'Net pozisyon', 'money', 16), col('eq', `Karşılık (${g})`, 'money', 16, g), col('un', `Tahmini kur farkı (${g})`, 'money', 18, g), col('n', 'Şirket', 'int', 8)],
      rows: [
        ...d.rows.map((r) => ({ cur: r.currency, cash: r.cash, rec: r.receivables, pay: r.payables, net: r.net, eq: r.equivalent, un: r.unrealized, n: r.companies })),
        { cur: NOTE },
        ...(d.excluded.length ? [{ cur: `EKSİK: ${d.excluded.length} şirket doğrulamayı geçemedi ve rapordan düştü` }] : []),
      ],
      ...(d.totals ? { totals: { eq: d.totals.equivalent, un: d.totals.unrealized } } : {}),
    },
    {
      key: 'sirket-bazinda',
      title: 'Şirket bazında döviz pozisyonu',
      sheet: 'Şirket bazında',
      subtitle: sub,
      columns: [col('co', 'Şirket', 'text', 30), col('cb', 'Defter para birimi', 'text', 10), col('cur', 'Para birimi', 'text', 12), col('cash', 'Kasa/banka', 'money', 16), col('rec', 'Açık alacak', 'money', 16), col('pay', 'Açık borç', 'money', 16), col('net', 'Net pozisyon', 'money', 16), col('un', 'Tahmini kur farkı (şirket para birimi)', 'money', 20)],
      rows: d.perCompany.flatMap((c) => c.rows.map((r) => ({ co: c.company.name, cb: c.company.baseCurrency, cur: r.currency, cash: r.cash, rec: r.receivables, pay: r.payables, net: r.net, un: r.unrealized }))),
    },
  ];
}

const kpiLines = (k: Kpis | null | undefined, p: Kpis | null | undefined) =>
  (Object.keys(KPI_DEFINITIONS) as (keyof Kpis)[]).map((key) => ({ metric: KPI_DEFINITIONS[key].label, cur: k?.[key] ?? '', prev: p?.[key] ?? '', def: KPI_DEFINITIONS[key].definition }));

export function executiveTables(s: ExecutiveSummary): ReportTable[] {
  const c = s.scope.currency;
  const sub = `${s.scope.name} · ${period(s.period.from, s.period.to)}${s.compare ? ` · karşılaştırma: ${period(s.compare.from, s.compare.to)}` : ''} · ${c}${s.complete === false ? ' · EKSİK: bazı şirketler rapordan düştü' : ''}`;
  const rows: Record<string, string | number | null>[] = [];
  const add = (section: string, metric: string, cur: string | null, prev: string | null) => rows.push({ section, metric, cur, prev });
  if (s.income) {
    const i = s.income.current;
    const p = s.income.previous;
    add('Gelir tablosu', 'Net satışlar', i.netSales, p?.netSales ?? null);
    add('Gelir tablosu', 'Gelir', i.revenue, p?.revenue ?? null);
    add('Gelir tablosu', 'Gider', i.expenses, p?.expenses ?? null);
    add('Gelir tablosu', 'Kâr / zarar', i.profit, p?.profit ?? null);
  }
  if (s.cash) add('Nakit', 'Kasa ve banka (karşılık)', s.cash.total, s.cash.previousTotal);
  if (s.receivables) {
    add('Alacak', 'Toplam açık alacak', s.receivables.total, s.receivables.previousTotal);
    add('Alacak', 'Vadesi geçmiş', s.receivables.overdue, null);
  }
  if (s.payables) {
    add('Borç', 'Toplam açık borç', s.payables.total, s.payables.previousTotal);
    add('Borç', 'Vadesi geçmiş', s.payables.overdue, null);
  }
  if (s.stock) add('Stok', 'Stok değeri', s.stock.stockValue, s.stock.previousValue);
  if (s.projects) {
    add('Projeler', 'Sözleşmeli gelir', s.projects.contractedRevenue, null);
    add('Projeler', 'Tahmini toplam maliyet (EAC)', s.projects.eac, null);
    add('Projeler', 'Tahmini kâr', s.projects.projectedProfit, null);
  }
  if (s.hr?.payroll) {
    add('İK', 'Bordro brüt', s.hr.payroll.gross, null);
    add('İK', 'İşveren yükü', s.hr.payroll.employer, null);
    add('İK', 'Bordro maliyeti', s.hr.payroll.cost, null);
  }
  const out: ReportTable[] = [
    {
      key: 'yonetici-ozeti',
      title: 'Yönetici özet raporu',
      sheet: 'Özet',
      subtitle: sub,
      columns: [col('section', 'Bölüm', 'text', 16), col('metric', 'Gösterge', 'text', 34), col('cur', `Dönem (${c})`, 'money', 18, c), col('prev', `Karşılaştırma (${c})`, 'money', 18, c)],
      rows: [
        ...rows,
        { section: 'Not', metric: s.scope.kind === 'group' ? NOTE : 'İç yönetim raporudur; yasal tablo değildir.' },
        ...(s.complete === false ? [{ section: 'Not', metric: `EKSİK: ${s.excluded?.length ?? 0} şirket doğrulamayı geçemedi ve rapordan düştü` }] : []),
      ],
    },
  ];
  if (s.kpis) {
    out.push({
      key: 'kpi',
      title: 'Göstergeler ve tanımları',
      sheet: 'Göstergeler',
      subtitle: sub,
      columns: [col('metric', 'Gösterge', 'text', 28), col('cur', 'Dönem', 'text', 12), col('prev', 'Karşılaştırma', 'text', 14), col('def', 'Tanım', 'text', 80)],
      rows: kpiLines(s.kpis.current, s.kpis.previous),
    });
  }
  const counts: Record<string, string | number | null>[] = [];
  if (s.hr) {
    counts.push({ metric: 'Personel sayısı (dönem sonu)', value: s.hr.headcount }, { metric: 'Dönemde işe giren', value: s.hr.hires }, { metric: 'Dönemde ayrılan', value: s.hr.leavers });
  }
  if (s.stock) counts.push({ metric: 'Stok kartı sayısı', value: s.stock.itemCount }, { metric: 'Kritik seviyedeki kart', value: s.stock.lowCount });
  if (counts.length) out.push({ key: 'sayilar', title: 'Sayılar', sheet: 'Sayılar', subtitle: sub, columns: [col('metric', 'Gösterge', 'text', 34), col('value', 'Değer', 'int', 12)], rows: counts });
  const aging: Record<string, string | null>[] = [];
  for (const [label, a] of [['Alacak', s.receivables], ['Borç', s.payables]] as const) {
    if (!a) continue;
    aging.push({ type: label, notDue: a.buckets.notDue, d1: a.buckets.d1_30, d2: a.buckets.d31_60, d3: a.buckets.d61_90, d4: a.buckets.d90plus, total: a.total });
  }
  if (aging.length) {
    out.push({ key: 'yaslandirma', title: 'Alacak ve borç yaşlandırma', sheet: 'Yaşlandırma', subtitle: sub, columns: [col('type', 'Tür', 'text', 10), col('notDue', `Vadesi gelmemiş (${c})`, 'money', 16, c), col('d1', `1–30 gün (${c})`, 'money', 16, c), col('d2', `31–60 gün (${c})`, 'money', 16, c), col('d3', `61–90 gün (${c})`, 'money', 16, c), col('d4', `90+ gün (${c})`, 'money', 16, c), col('total', `Toplam (${c})`, 'money', 16, c)], rows: aging });
  }
  const top: Record<string, string | null>[] = [
    ...(s.topCustomers ?? []).map((r) => ({ kind: 'Müşteri', name: r.name, net: r.net })),
    ...(s.topSuppliers ?? []).map((r) => ({ kind: 'Tedarikçi', name: r.name, net: r.net })),
  ];
  if (top.length) out.push({ key: 'en-buyuk', title: 'En büyük müşteri ve tedarikçiler (net, KDV hariç)', sheet: 'Müşteri-tedarikçi', subtitle: sub, columns: [col('kind', 'Tür', 'text', 12), col('name', 'Ad', 'text', 40), col('net', `Net tutar (${c})`, 'money', 18, c)], rows: top });
  return out;
}
