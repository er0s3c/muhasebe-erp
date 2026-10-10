import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '../src/db/client';
import type { AiSessionContext } from '../src/modules/ai/types';
vi.mock('../src/modules/parties/service', () => ({ allOpenItems: vi.fn() }));
import { allOpenItems } from '../src/modules/parties/service';
import { toolRegistry } from '../src/modules/ai/tools';

const ctx: AiSessionContext = { user: { id: 'u', role: 'admin' }, company: { id: 'c', name: 'Firma', sector: 'COMMERCE', baseCurrency: 'TRY' }, today: '2026-10-09', allowedTools: new Set(['get_overdue_receivables', 'get_recent_invoices']) };
describe('Asistan veri hesapları', () => {
  it('vade listesinde brüt fatura yerine eşleştirme motorunun kalan tutarı kullanılır; vadesi gelmemiş kalem hariçtir', async () => {
    const item = { lineId: 'line', partyId: 'party', entryId: 'entry', entryNo: 'YV-1', entryDate: '2026-09-01', dueDate: '2026-09-10', description: '', currencyCode: 'TRY', amount: '100', amountBase: '100', remainingBase: '40', remaining: '40', daysOverdue: 29, bucket: 'd1_30' as const, partyName: 'Müşteri' };
    vi.mocked(allOpenItems).mockResolvedValueOnce([item, { ...item, lineId: 'future', daysOverdue: -2 }]).mockResolvedValueOnce([]);
    const execute = vi.fn(); const tx = { execute } as unknown as Tx;
    const result = await toolRegistry.execute('get_overdue_receivables', {}, ctx, tx);
    expect(result.result).toMatchObject({ toplamKayit: 1, vadesiGecmisKalemler: [{ kalanTutar: '40 TRY', cari: 'Müşteri' }] });
    expect(allOpenItems).toHaveBeenNthCalledWith(1, tx, 'receivable', ctx.today);
    expect(allOpenItems).toHaveBeenNthCalledWith(2, tx, 'payable', ctx.today);
    expect(execute).not.toHaveBeenCalled();
  });
  it('ham DB hatası ve modelin uydurduğu parametreler dışarı gönderilmez', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('postgres://secret SQL internal'));
    const tx = { execute } as unknown as Tx;
    const result = await toolRegistry.execute('get_recent_invoices', {}, ctx, tx);
    expect(result.error).toContain('ERP verileri'); expect(JSON.stringify(result)).not.toContain('secret');
    execute.mockClear();
    expect((await toolRegistry.execute('get_recent_invoices', { sql: 'select secret' }, ctx, tx)).error).toContain('parametre kabul etmez');
    expect(execute).not.toHaveBeenCalled();
  });
});
