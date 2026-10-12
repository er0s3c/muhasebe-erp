import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { moneyIn } from '../../lib/format';
import type { InvoiceDetail } from '../../lib/types';
import { InvoicePrintDocument } from './InvoicePrintDocument';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../lib/session', () => ({ useCompany: () => ({ name: 'Güncel şirket unvanı', baseCurrency: 'TRY' }) }));
vi.mock('../../lib/queries', () => ({ useCQuery: () => ({ data: { company: { name: 'Güncel şirket unvanı', taxNumber: 'YENİ-VERGİ', taxOffice: 'Güncel vergi dairesi' } } }) }));
vi.mock('../inventory/common', () => ({ qtyText: (value: string) => value, useUnitLabel: () => (unit: string) => unit }));
function fixture(): InvoiceDetail {
  return {
    invoice: {
      id: 'inv-1', type: 'sales_return', status: 'posted', invoiceNo: 'SIF-2026-000001', invoiceDate: '2026-09-29', dueDate: '2026-10-29', externalNo: null, partyId: 'party-1', partyName: 'Güncel müşteri unvanı', currencyCode: 'GBP', description: 'İade açıklaması', returnOfNo: 'SF-2026-000007',
      netTotal: '90.0000', vatTotal: '18.0000', grossTotal: '108.0000', grossTotalBase: '7027.27020000', fxRate: '65.06730000',
      documentMetadata: { company: { name: 'Belge anındaki şirket', taxNumber: 'ESKİ-ŞİRKET-VERGİ', taxOffice: 'Eski şirket vergi dairesi' }, party: { name: 'Belge anındaki müşteri', taxNumber: 'ESKİ-MÜŞTERİ-VERGİ', taxOffice: 'Eski müşteri vergi dairesi', address: 'Belge anındaki adres' }, originalInvoice: { id: 'inv-original', invoiceNo: 'SF-2026-000007', invoiceDate: '2026-09-29' } },
      taxTotalsSnapshot: { vatWithheld: '9.0000', incomeWithheld: '2.0000', stamp: '1.0000', payableToSeller: '96.0000' },
      fxSnapshot: { from: 'GBP', to: 'TRY', rateDate: '2026-09-29', rateType: 'effective_sell', provider: 'tcmb', source: 'TCMB 2026/183', sourceUrl: 'https://www.tcmb.gov.tr/kurlar/202609/29092026.xml', originalInvoiceId: 'inv-original', legs: [] },
    },
    lines: [{ id: 'line-1', itemCode: 'STK-1', description: 'Seri takipli ürün', quantity: '1', unit: 'adet', unitPrice: '100', discountPct: '10', vatCode: 'KDV20', vatRate: '20', net: '90', gross: '108', serials: ['SERİ-00042'], orderCode: 'SSP-2026-000003', deliveryNoteNo: 'SIR-2026-000002', projectCode: null }], returns: [],
  } as unknown as InvoiceDetail;
}
describe('Gerçek fatura çıktı şablonları', () => {
  it.each(['simple', 'detailed'] as const)('%s şablonu tarihsel şirket/cari bilgilerini ve kesinleşmiş toplam/vergileri korur', template => {
    const html = renderToStaticMarkup(<InvoicePrintDocument data={fixture()} template={template} />);
    expect(html).toContain('Belge anındaki şirket'); expect(html).toContain('Belge anındaki müşteri'); expect(html).toContain('Belge anındaki adres');
    expect(html).toContain('ESKİ-ŞİRKET-VERGİ'); expect(html).toContain('ESKİ-MÜŞTERİ-VERGİ');
    expect(html).not.toContain('Güncel şirket'); expect(html).not.toContain('Güncel müşteri'); expect(html).not.toContain('YENİ-VERGİ');
    expect(html).toContain(moneyIn('108', 'GBP')); expect(html).toContain(moneyIn('96', 'GBP')); expect(html).toContain('KDV tevkifatı'); expect(html).toContain('Stopaj'); expect(html).toContain('Damga / pul');
    expect(html).toContain('İadenin özgün faturası: SF-2026-000007'); expect(html).toContain('özgün faturanın kur kaydı'); expect(html).toContain('Efektif satış');
  });
  it('ayrıntılı şablon seri, indirim, sipariş ve kur kaynağını ekler; basit şablonda bu ayrıntılar gizlidir', () => {
    const detailed = renderToStaticMarkup(<InvoicePrintDocument data={fixture()} template="detailed" />);
    const simple = renderToStaticMarkup(<InvoicePrintDocument data={fixture()} template="simple" />);
    for (const value of ['SERİ-00042', 'İndirim', 'SSP-2026-000003', 'TCMB 2026/183', 'https://www.tcmb.gov.tr/kurlar/202609/29092026.xml']) { expect(detailed).toContain(value); expect(simple).not.toContain(value); }
  });
  it('eski kayıt saklı taraf bilgisi yoksa açıkça güncel şirket bilgisini kullandığını gösterir', () => {
    const data = fixture(); data.invoice.documentMetadata = null;
    const html = renderToStaticMarkup(<InvoicePrintDocument data={data} template="simple" />);
    expect(html).toContain('Güncel şirket unvanı'); expect(html).toContain('YENİ-VERGİ'); expect(html).toContain('belge anında saklanmamıştır');
  });
  it('iptal edilmiş fatura çıktı üzerinde iptal durumunu ve gerekçeyi taşır', () => {
    const data = fixture(); data.invoice.status = 'cancelled'; data.invoice.cancelReason = 'Müşteri talebiyle iptal'; data.invoice.cancelledAt = '2026-10-01T10:00:00Z';
    const html = renderToStaticMarkup(<InvoicePrintDocument data={data} template="simple" />);
    expect(html).toContain('İPTAL EDİLMİŞ BELGE'); expect(html).toContain('Müşteri talebiyle iptal');
  });
});
