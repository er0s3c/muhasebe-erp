// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmployeesPage } from './EmployeesPage';

const query = vi.hoisted(() => ({
  data: undefined as { employees: [] } | undefined,
  error: null as Error | null,
  isPending: false,
  isFetching: false,
  refetch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../lib/queries', () => ({ useCan: () => () => false, useCQuery: () => query }));
vi.mock('react-i18next', async importOriginal => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../components/ui/ExportMenu', () => ({ ExportMenu: () => null }));
vi.mock('./EmployeeFormSheet', () => ({ EmployeeFormSheet: () => null }));

let host: HTMLDivElement, root: Root;
const render = () => act(async () => root.render(<MemoryRouter><EmployeesPage /></MemoryRouter>));
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  query.data = undefined; query.error = null; query.isPending = false; query.isFetching = false; query.refetch.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('Personel ana sorgu geri bildirimi', () => {
  it('başarısız sorguyu boş personel listesi olarak göstermez ve tekrar denemeyi bağlar', async () => {
    query.error = new Error('Personel bağlantısı kurulamadı'); await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Personel bağlantısı kurulamadı');
    expect(host.textContent).not.toContain('hr.empty');
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Tekrar dene')!;
    await act(async () => retry.click()); expect(query.refetch).toHaveBeenCalledOnce();
    query.isFetching = true; await render(); expect(retry.disabled).toBe(true);
  });
  it('hata olmadığında gerçek boş listeyi, bekleyen sorguda yüklenmeyi gösterir', async () => {
    query.data = { employees: [] }; await render(); expect(host.textContent).toContain('hr.empty');
    query.data = undefined; query.isPending = true; await render();
    expect(host.querySelector('[aria-label="Yükleniyor"]')).not.toBeNull();
    expect(host.textContent).not.toContain('hr.empty');
  });
});
