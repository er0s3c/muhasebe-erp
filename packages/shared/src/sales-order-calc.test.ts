import { describe, expect, it } from 'vitest';
import {
  canTransition,
  deliveredNotInvoiced,
  groupBatchLines,
  orderFulfilment,
  remainingDeliverable,
  remainingInvoiceable,
  SALES_DOC_PREFIX,
  SALES_TRANSITIONS,
  type BatchCandidate,
} from './sales-order-calc';

describe('satış teklif/sipariş durum geçişleri', () => {
  it('teklif: taslak → gönderildi → kabul → siparişe dönüştü; ret/iptal sonlu; gönderilmiş teklif taslağa döner', () => {
    expect(canTransition('quote', 'draft', 'sent')).toBe(true);
    expect(canTransition('quote', 'sent', 'accepted')).toBe(true);
    expect(canTransition('quote', 'sent', 'draft')).toBe(true);
    expect(canTransition('quote', 'accepted', 'converted')).toBe(true);
    expect(canTransition('quote', 'draft', 'accepted')).toBe(false);
    expect(canTransition('quote', 'rejected', 'accepted')).toBe(false);
    expect(canTransition('quote', 'converted', 'cancelled')).toBe(false);
    expect(canTransition('quote', 'draft', 'confirmed')).toBe(false);
  });

  it('sipariş: taslak → onaylı → kapalı; iptal yalnızca taslak/onaylıdan; kapalı/iptal sonlu', () => {
    expect(canTransition('order', 'draft', 'confirmed')).toBe(true);
    expect(canTransition('order', 'confirmed', 'closed')).toBe(true);
    expect(canTransition('order', 'confirmed', 'cancelled')).toBe(true);
    expect(canTransition('order', 'closed', 'confirmed')).toBe(false);
    expect(canTransition('order', 'cancelled', 'draft')).toBe(false);
    expect(canTransition('order', 'draft', 'sent')).toBe(false);
  });

  it('sonlu durumların çıkışı yok; önekler sabit', () => {
    for (const [kind, table] of Object.entries(SALES_TRANSITIONS)) {
      for (const terminal of ['rejected', 'converted', 'closed', 'cancelled'] as const) {
        expect(table[terminal], `${kind}/${terminal}`).toBeUndefined();
      }
    }
    expect(SALES_DOC_PREFIX).toEqual({ quote: 'TKL', order: 'SSP' });
  });
});

describe('sipariş karşılanma durumu', () => {
  const l = (quantity: string, delivered: string, invoiced: string, isGoods = true) => ({ quantity, delivered, invoiced, isGoods });

  it('hiç hareket yok → none/none; kısmi teslim; tam teslim ama faturasız; tam fatura', () => {
    expect(orderFulfilment([l('10', '0', '0')])).toEqual({ delivery: 'none', invoicing: 'none' });
    expect(orderFulfilment([l('10', '4', '0')])).toEqual({ delivery: 'partial', invoicing: 'none' });
    expect(orderFulfilment([l('10', '10', '0')])).toEqual({ delivery: 'full', invoicing: 'none' });
    expect(orderFulfilment([l('10', '10', '4')])).toEqual({ delivery: 'full', invoicing: 'partial' });
    expect(orderFulfilment([l('10', '10', '10')])).toEqual({ delivery: 'full', invoicing: 'full' });
  });

  it('satır bazında tamamlanma: bir satır tam, diğeri değilse kısmi; hizmet satırı teslim durumunu etkilemez', () => {
    expect(orderFulfilment([l('10', '10', '10'), l('5', '0', '0')])).toEqual({ delivery: 'partial', invoicing: 'partial' });
    expect(orderFulfilment([l('10', '10', '10'), l('1', '0', '1', false)])).toEqual({ delivery: 'full', invoicing: 'full' });
    expect(orderFulfilment([l('1', '0', '0', false)])).toEqual({ delivery: null, invoicing: 'none' });
    expect(orderFulfilment([])).toEqual({ delivery: null, invoicing: 'none' });
  });

  it('kalan teslim/fatura miktarları ve teslim edilip faturalanmamış miktar', () => {
    const c = { quantity: '10', isGoods: true, delivered: '4', invoiced: '5', directInvoiced: '2' };
    expect(remainingDeliverable(c).toFixed(4)).toBe('4.0000'); // 10 - 4 - 2
    expect(remainingInvoiceable(c).toFixed(4)).toBe('5.0000');
    expect(deliveredNotInvoiced(c).toFixed(4)).toBe('1.0000'); // 4 - (5 - 2)
    expect(remainingDeliverable({ ...c, isGoods: false }).toFixed(4)).toBe('0.0000');
    expect(remainingDeliverable({ ...c, delivered: '12' }).toFixed(4)).toBe('0.0000'); // eksiye düşmez
    expect(deliveredNotInvoiced({ delivered: '1', invoiced: '3', directInvoiced: '0' }).toFixed(4)).toBe('0.0000');
  });
});

describe('toplu faturalama gruplaması', () => {
  const r = (partyId: string, noteId: string, noteDate: string, noteNo: string, lineId: string, variant?: string): BatchCandidate => ({ partyId, noteId, noteDate, noteNo, lineId, variant });
  const rows = [
    r('B', 'n3', '2026-03-07', 'SIR-3', 'l3'),
    r('A', 'n2', '2026-03-06', 'SIR-2', 'l2'),
    r('A', 'n1', '2026-03-05', 'SIR-1', 'l1a'),
    r('A', 'n1', '2026-03-05', 'SIR-1', 'l1b'),
  ];

  it('cari başına tek fatura: tarih sırasında, cariler ilk görülme sırasında kümelenir', () => {
    const g = groupBatchLines(rows, 'party');
    expect(g.map((x) => [x.partyId, x.noteIds, x.lines.map((l) => l.lineId)])).toEqual([
      ['A', ['n1', 'n2'], ['l1a', 'l1b', 'l2']],
      ['B', ['n3'], ['l3']],
    ]);
  });

  it('irsaliye başına fatura', () => {
    const g = groupBatchLines(rows, 'note');
    expect(g.map((x) => [x.partyId, x.noteIds])).toEqual([['A', ['n1']], ['A', ['n2']], ['B', ['n3']]]);
  });

  it('para birimi/KDV biçimi (variant) farklı satırlar ayrı faturalara bölünür', () => {
    const g = groupBatchLines([r('A', 'n1', '2026-03-05', 'SIR-1', 'a', 'TRY|false'), r('A', 'n2', '2026-03-06', 'SIR-2', 'b', 'EUR|false'), r('A', 'n3', '2026-03-07', 'SIR-3', 'c', 'TRY|false')], 'party');
    expect(g.map((x) => x.lines.map((l) => l.lineId))).toEqual([['a', 'c'], ['b']]);
  });

  it('boş girdi boş sonuç; girdi dizisi değişmez', () => {
    expect(groupBatchLines([], 'party')).toEqual([]);
    const copy = [...rows];
    groupBatchLines(rows, 'party');
    expect(rows).toEqual(copy);
  });
});
