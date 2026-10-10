// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeatherProductionPage } from './LeatherPages';

const state = vi.hoisted(() => ({ generic: true, query: vi.fn() }));
vi.mock('react-i18next', async importOriginal => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../lib/session', () => ({ useCompany: () => ({ baseCurrency: 'TRY' }) }));
vi.mock('./production-context', () => ({
  useGenericProduction: () => state.generic,
  useProductionCan: () => () => true,
  useProductionQuery: (...args: unknown[]) => state.query(...args),
  ProductionLink: () => null,
}));
vi.mock('./common', () => ({
  LeatherHeader: () => null, Records: () => null, Status: () => null,
  useFocusedRecord: () => undefined, useLeatherActions: () => vi.fn(),
  options: (rows: { id: string }[] = [], label: (row: { id: string }) => string) => rows.map(row => ({ value: row.id, label: label(row) })),
  optional: (value: string) => value || undefined,
  numberField: (name: string, label: string) => ({ name, label }),
  textField: (name: string, label: string) => ({ name, label }),
  selectField: (name: string, label: string) => ({ name, label }),
  OperationForm: ({ fields }: { fields: { name: string }[] }) => <section data-testid="production-form" data-fields={fields.map(field => field.name).join(',')} />,
}));
vi.mock('../manufacturing/TransfersPanel', () => ({ TransfersPanel: () => null }));
vi.mock('../manufacturing/ExecutionPanels', () => ({ ReworkExecutionPanel: () => null }));
vi.mock('./ExecutionPanels', () => ({ PieceGeometryPanel: () => null, LeatherCutPlanningPanel: () => null, ServiceTimePanel: () => null }));
vi.mock('../manufacturing/SupportPanels', () => ({ CustomValuesPanel: () => null, PieceRatePanel: () => null }));

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); state.generic = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  state.query.mockReset().mockImplementation((_key, path: string) => ({
    data: path.endsWith('/variants') ? { variants: [{ id: 'variant-1', itemCode: 'U-1', itemName: 'Ürün', revision: 1, revisionId: 'revision-1' }] } : {
      items: [], warehouses: [], orders: [], pieces: [], customOrders: [],
    }, error: null, isPending: false, isFetching: false, refetch: vi.fn(),
  }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function renderAndSelect() {
  await act(async () => root.render(<LeatherProductionPage />));
  const select = host.querySelector<HTMLSelectElement>('select')!;
  await act(async () => { select.value = 'variant-1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
}

describe('Üretim bağlamında özel sipariş bağı', () => {
  it('genel üretimde desteklenmeyen özel sipariş sorgusunu kapatır ve alanı çıkarır', async () => {
    await renderAndSelect();
    const calls = state.query.mock.calls.filter(call => call[1] === '/api/leather/custom-orders');
    expect(calls.length).toBeGreaterThan(0); expect(calls.every(call => call[2]?.enabled === false)).toBe(true);
    expect(host.querySelector('[data-testid="production-form"]')?.getAttribute('data-fields')).not.toContain('customOrderId');
  });
  it('deri üretiminde mevcut sorguyu ve özel sipariş alanını korur', async () => {
    state.generic = false; await renderAndSelect();
    expect(state.query.mock.calls.find(call => call[1] === '/api/leather/custom-orders')?.[2]).toMatchObject({ enabled: true });
    expect(host.querySelector('[data-testid="production-form"]')?.getAttribute('data-fields')).toContain('customOrderId');
  });
});
