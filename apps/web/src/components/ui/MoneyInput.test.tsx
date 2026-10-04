import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import '../../i18n';
import { MoneyInput } from './MoneyInput';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
});

function mount(initial = '') {
  const values: string[] = [];
  function Host() {
    const [v, setV] = useState(initial);
    return (
      <MoneyInput
        aria-label="tutar"
        value={v}
        onChange={(x) => {
          values.push(x);
          setV(x);
        }}
      />
    );
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Host />));
  const input = container.querySelector('input')!;
  const type = (text: string) =>
    act(() => {
      input.focus();
      input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const blur = () =>
    act(() => {
      input.blur();
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
  return { input, values, type, blur };
}

describe('MoneyInput (UI-1/UI-3)', () => {
  it('Türkçe binlik noktası: "250.000" → 250000, odaktan çıkınca "250.000,00"', () => {
    const m = mount();
    m.type('250.000');
    expect(m.values.at(-1)).toBe('250000');
    m.blur();
    expect(m.input.value).toBe('250.000,00');
    expect(m.input.getAttribute('aria-invalid')).toBeNull();
  });

  it('"1.234,56" ve "12,5" doğru ayrıştırılır; "12.5" ondalık sayılır (125 olmaz)', () => {
    const m = mount();
    m.type('1.234,56');
    expect(m.values.at(-1)).toBe('1234.56');
    m.type('12,5');
    expect(m.values.at(-1)).toBe('12.5');
    m.type('12.5');
    expect(m.values.at(-1)).toBe('12.5');
  });

  it('geçersiz yazım sessizce silinmez: metin kalır, alan işaretlenir ve hata iletisi görünür', () => {
    const m = mount('100');
    m.type('1,2,3');
    expect(m.values.at(-1)).toBe('');
    m.blur();
    expect(m.input.value).toBe('1,2,3');
    expect(m.input.getAttribute('aria-invalid')).toBe('true');
    expect(container!.querySelector('[role="alert"]')?.textContent).toMatch(/Geçersiz sayı/);
  });
});
