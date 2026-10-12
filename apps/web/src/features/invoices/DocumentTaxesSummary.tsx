import { Card } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useCQuery } from '../../lib/queries';
import { moneyIn } from '../../lib/format';
import { useCompany } from '../../lib/session';
import { errorMessage } from '../../lib/errors';

interface TaxRow { jurisdiction: string | null; treatment: string; exemptionCode: string | null; ruleVersion: string | null; salesNet: string; purchaseNet: string; vat: string; vatWithheld: string; incomeWithheld: string; stamp: string; }
const labels: Record<string, string> = { standard: 'Vergili', zero: 'Sıfır oran', exempt: 'İstisna', unclassified: 'Uygulama belirtilmemiş', legacy_manual: 'Eski manuel kayıt' };
export function DocumentTaxesSummary({ from, to }: { from: string; to: string }) {
  const company = useCompany();
  const { data, error } = useCQuery<{ rows: TaxRow[] }>(['document-taxes', from, to], `/api/reports/document-taxes?from=${from}&to=${to}`);
  if (error) return <Callout tone="danger" title="İşlem vergileri yüklenemedi">{errorMessage(error)}</Callout>;
  if (!data?.rows.length) return null;
  return <Card className="mt-5 p-5"><h2 className="text-lg">Vergi uygulaması ve kesintiler</h2><p className="mb-4 mt-1 text-sm text-muted">Defter para biriminde iç kontrol kırılımı. İadeler düşülmüştür. Tevkifat, stopaj ve damga/pul ayrı gösterilir; resmî beyanname bağlantısı değildir.</p><TableWrap><Table><thead><tr><Th>Ülke / uygulama</Th><Th>Kod / sürüm</Th><Th num>Satış matrahı</Th><Th num>Alış matrahı</Th><Th num>KDV</Th><Th num>KDV tevkifatı</Th><Th num>Stopaj</Th><Th num>Damga / pul</Th></tr></thead><tbody>{data.rows.map((row, index) => <Tr key={index}><Td>{row.jurisdiction ?? 'Eski manuel'}<span className="block text-xs text-muted">{labels[row.treatment] ?? row.treatment}</span></Td><Td>{row.exemptionCode ?? '—'}<span className="block text-xs text-muted">{row.ruleVersion ?? 'Standart oran'}</span></Td>{[row.salesNet,row.purchaseNet,row.vat,row.vatWithheld,row.incomeWithheld,row.stamp].map((amount, index) => <Td key={index} num>{moneyIn(amount,company.baseCurrency)}</Td>)}</Tr>)}</tbody></Table></TableWrap></Card>;
}
