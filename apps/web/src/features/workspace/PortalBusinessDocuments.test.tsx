// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_PORTAL_SCOPES, type PortalDocumentDetail } from '@erp/shared';
import { api, ApiError } from '../../lib/api';
import { PortalBusinessDocuments, PortalDocumentContent } from './PortalBusinessDocuments';
vi.mock('../../lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api: vi.fn() }));
vi.mock('../../components/ui/Sheet', () => ({ Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null }));
let host: HTMLDivElement, root: Root;
const onAccessLost = vi.fn();
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === label)!;
const row = { id: 'invoice-1', kind: 'invoice' as const, number: 'SF-2026-000001', status: 'posted', date: '2026-06-15', currency: 'TRY', grossTotal: '120', type: 'sales' as const };
const doc: PortalDocumentDetail = { ...row, dueDate: '2026-07-15', validUntil: null, deliveryDate: null, vatIncluded: false, netTotal: '100', vatTotal: '20', vatWithheld: '10', incomeWithheld: '5', stamp: '1', payableToSeller: '104', lines: [{ lineNo: 1, description: 'Müşteri hizmeti', quantity: '2', unit: 'adet', unitPrice: '50', discountPct: '0', vatRate: '20', net: '100', vat: '20', gross: '120' }] };
const render = async (overrides = {}) => act(async () => root.render(<PortalBusinessDocuments scopes={{ invoices: true, quotes: true, orders: false }} token="token" password="password" revision={0} onAccessLost={onAccessLost} {...overrides} />));
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.mocked(api).mockReset(); onAccessLost.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe('Portal satış belgesi görünümü', () => {
  it('kapalı kategoriler için istek veya belge düğmesi oluşturmaz', async () => { await render({ scopes: EMPTY_PORTAL_SCOPES }); expect(api).not.toHaveBeenCalled(); expect(host.textContent).toBe(''); });
  it('sayfalama doğru tür/ofseti gönderir; tür değişimi ilk sayfaya döner', async () => {
    vi.mocked(api).mockResolvedValue({ items: [row], total: 21, offset: 0, limit: 20 }); await render();
    expect(vi.mocked(api).mock.calls[0][1]?.body).toMatchObject({ action: 'list_documents', recordKind: 'invoice', offset: 0, limit: 20 });
    expect(button('Siparişler')).toBeUndefined(); await act(async () => button('Sonraki').click()); expect(vi.mocked(api).mock.lastCall?.[1]?.body).toMatchObject({ recordKind: 'invoice', offset: 20 });
    await act(async () => button('Teklifler').click()); expect(vi.mocked(api).mock.lastCall?.[1]?.body).toMatchObject({ recordKind: 'quote', offset: 0 });
  });
  it('ayrıntı yeniden doğrulanır; vergi kesintileri ve ödenecek tutar açıkça görünür', async () => {
    vi.mocked(api).mockResolvedValueOnce({ items: [row], total: 1, offset: 0, limit: 20 }).mockResolvedValueOnce({ document: doc }); await render();
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.includes(row.number))!.click());
    expect(vi.mocked(api).mock.lastCall?.[1]?.body).toMatchObject({ action: 'document_detail', recordKind: 'invoice', recordId: 'invoice-1' });
    const text = host.querySelector('[role="dialog"]')!.textContent; expect(text).toContain('Müşteri hizmeti'); expect(text).toContain('KDV tevkifatı'); expect(text).toContain('Stopaj'); expect(text).toContain('Damga vergisi'); expect(text).toContain('104,00');
  });
  it('erişim kaldırılınca üst ekrandaki müşteri verilerinin temizlenmesini ister', async () => { vi.mocked(api).mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'Portal erişimi kapatılmış.')); await render(); expect(onAccessLost).toHaveBeenCalledExactlyOnceWith('Portal erişimi kapatılmış.'); });
  it('gecikmiş eski kategori yanıtı yeni kategori verisini değiştiremez', async () => {
    let resolveOld!: (value: unknown) => void; vi.mocked(api).mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce({ items: [], total: 0, offset: 0, limit: 20 }); await render();
    await act(async () => button('Teklifler').click()); await act(async () => resolveOld({ items: [row], total: 1, offset: 0, limit: 20 }));
    expect(host.textContent).not.toContain(row.number); expect(host.textContent).toContain('Paylaşılabilir belge bulunmuyor');
  });
  it('hata/boş durumu görünürdür; iade ve birim etiketleri Türkçedir', async () => { vi.mocked(api).mockRejectedValueOnce(new Error('Bağlantı kurulamadı')); await render(); expect(host.textContent).toContain('Bağlantı kurulamadı'); await act(async () => root.render(<PortalDocumentContent document={{ ...doc, type: 'sales_return' }} />)); expect(host.textContent).toContain('Satış iadesi'); expect(host.textContent).toContain('adet'); expect(host.textContent).toContain('KDV hariç'); });
});
