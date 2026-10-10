import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../i18n';
import { Field, Input } from './Field';
import { SegmentedTabs, TabPanel } from './Tabs';
import { readSavedViews, savedViewsKey, SavedViews } from './SavedViews';
import { FormGuard, markFormSaved, RouteChangeGuard, UnsavedChangesProvider, useUnsavedChanges } from './UnsavedChanges';
import { MoneyInput } from './MoneyInput';
import { useConfirmation } from './useConfirmation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  localStorage.clear();
});
async function mount(node: ReactNode) {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}
async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function Probe() {
  const { dirty, pending } = useUnsavedChanges();
  return <output data-testid="draft">{`${dirty}/${pending}`}</output>;
}
function TextForm({ pending = false }: { pending?: boolean }) {
  const [name, setName] = useState('Ada');
  return <FormGuard pending={pending}><form><Input aria-label="Ad" value={name} onChange={event => setName(event.target.value)} />
    <Input type="search" aria-label="Ara" defaultValue="" /></form></FormGuard>;
}

describe('V2 erişilebilirlik ve kayıtlı görünümler', () => {
  it('eski Field callback sözleşmesinde bile hata ve açıklama gerçek kontrolle ilişkilidir', async () => {
    await mount(<Field label="Ünvan" error="Ad gereklidir" required>{id => <Input id={id} />}</Field>);
    const input = host.querySelector('input')!;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-required')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe('Ad gereklidir');
    expect(host.querySelector('label')!.htmlFor).toBe(input.id);
  });
  it('sekmelerde yön tuşları, Home/End ve panel ilişkisi birlikte çalışır', async () => {
    function Tabs() {
      const [tab, setTab] = useState('a');
      return <><SegmentedTabs id="sections" value={tab} onChange={setTab} panelId={key => `panel-${key}`} items={[{ key: 'a', label: 'Özet' }, { key: 'b', label: 'Geçmiş' }]} />
        <TabPanel id={`panel-${tab}`} labelledBy={`sections-${tab}`}>{tab}</TabPanel></>;
    }
    await mount(<Tabs />);
    await act(async () => host.querySelector('[role="tab"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(document.activeElement?.id).toBe('sections-b');
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById(document.activeElement!.getAttribute('aria-controls')!)?.getAttribute('aria-labelledby')).toBe('sections-b');
  });
  it('filtre seçicileri tab semantiği kullanmaz', async () => {
    await mount(<SegmentedTabs variant="filter" value="a" onChange={() => undefined} items={[{ key: 'a', label: 'Tümü' }, { key: 'b', label: 'Taslak' }]} />);
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.querySelector('button')!.getAttribute('aria-pressed')).toBe('true');
  });
  it('yerel görünümleri kullanıcı/şirket/şube/sayfa ayırır ve yalnız açık seçimle uygular', async () => {
    const scope = ['u1', 'c1', 'b1', 'parties'];
    const key = savedViewsKey(scope);
    expect(savedViewsKey(['u1', 'c2', 'b1', 'parties'])).not.toBe(key);
    expect(savedViewsKey(['u1', 'c1', 'b2', 'parties'])).not.toBe(key);
    localStorage.setItem(key, JSON.stringify([{ id: 'v1', name: 'Müşteriler', filters: { kind: 'customer', password: 'excluded' } }]));
    expect(readSavedViews(key, { kind: '' })[0].filters).toEqual({ kind: 'customer' });
    const apply = vi.fn();
    await mount(<SavedViews scope={scope} filters={{ kind: '' }} onApply={apply} />);
    expect(apply).not.toHaveBeenCalled();
    await act(async () => {
      const select = host.querySelector('select')!; select.value = 'v1'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(apply).toHaveBeenCalledWith({ kind: 'customer' });
    localStorage.setItem(key, 'bad-json');
    expect(readSavedViews(key, { kind: '' })).toEqual([]);
  });
});

describe('V2 anlamlı taslak koruması', () => {
  it('arama taslak oluşturmaz; değiştirip geri alma ve başarılı kayıt taslağı temizler', async () => {
    await mount(<UnsavedChangesProvider><TextForm /><Probe /></UnsavedChangesProvider>);
    await enter(host.querySelector('input[type="search"]')!, 'arama');
    expect(host.querySelector('output')?.textContent).toBe('false/false');
    await enter(host.querySelector('input')!, 'Yeni Ada');
    expect(host.querySelector('output')?.textContent).toBe('true/false');
    await enter(host.querySelector('input')!, 'Ada');
    expect(host.querySelector('output')?.textContent).toBe('false/false');
    await enter(host.querySelector('input')!, 'Kaydedilmiş Ada');
    await act(async () => markFormSaved(host.querySelector('input')));
    expect(host.querySelector('output')?.textContent).toBe('false/false');
  });
  it('aynı sayfada kaydedilen form yalnız kendi taslağını kapatır; diğer formun değişikliği korunur', async () => {
    function TwoForms() {
      const [first, setFirst] = useState(''), [second, setSecond] = useState('');
      return <FormGuard>
        <form><Input aria-label="Birinci" value={first} onChange={event => setFirst(event.target.value)} /></form>
        <form><Input aria-label="İkinci" value={second} onChange={event => setSecond(event.target.value)} /></form>
      </FormGuard>;
    }
    await mount(<UnsavedChangesProvider><TwoForms /><Probe /></UnsavedChangesProvider>);
    const [first, second] = [...host.querySelectorAll('input')];
    await enter(first!, 'eklenecek');
    await enter(second!, 'yarım kalan');
    await act(async () => markFormSaved(first));
    expect(host.querySelector('output')?.textContent).toBe('true/false');
    await act(async () => markFormSaved(second));
    expect(host.querySelector('output')?.textContent).toBe('false/false');
  });
  it('parasal alanın yalnız biçim değişimi kaydedilmemiş değişiklik oluşturmaz', async () => {
    function Amount() {
      const [value, setValue] = useState('100');
      return <FormGuard><form><MoneyInput value={value} onChange={setValue} /></form></FormGuard>;
    }
    await mount(<UnsavedChangesProvider><Amount /><Probe /></UnsavedChangesProvider>);
    const input = host.querySelector('input')!;
    await act(async () => input.focus());
    await act(async () => input.blur());
    expect(host.querySelector('output')?.textContent).toBe('false/false');
  });
  it('query parametresiyle ayrılmayı onaylar ve kaydederken ayrılmayı kilitler', async () => {
    const router = createMemoryRouter([{ element: <RouteChangeGuard />, children: [{ path: '/', element: <><TextForm /><Probe /></> }] }]);
    await mount(<UnsavedChangesProvider><RouterProvider router={router} /></UnsavedChangesProvider>);
    await enter(host.querySelector('input')!, 'Taslak');
    await act(async () => { void router.navigate('/?kind=collection'); });
    expect(router.state.location.search).toBe('');
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    const confirm = [...document.querySelectorAll('button')].find(button => button.textContent === 'Değişiklikleri bırak')!;
    await act(async () => confirm.click());
    expect(router.state.location.search).toBe('?kind=collection');
    await act(async () => router.dispose());
  });
  it('onay işlemi iki hızlı tıklamada yalnız bir istek yapar; hatada tekrar denenebilir', async () => {
    let reject: (cause: Error) => void = () => undefined;
    const action = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    function Confirm() {
      const { confirm, dialog } = useConfirmation();
      return <><button onClick={() => confirm({ title: 'Sil', description: 'Kaydı sil', onConfirm: action })}>Başlat</button>{dialog}</>;
    }
    await mount(<UnsavedChangesProvider><Confirm /></UnsavedChangesProvider>);
    await act(async () => host.querySelector('button')!.click());
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === 'Onayla')!;
    await act(async () => { button.click(); button.click(); });
    expect(action).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error('test failure')));
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Yeniden deneyin');
    expect(button.disabled).toBe(false);
  });
});
