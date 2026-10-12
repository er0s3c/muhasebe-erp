// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventKey, hotkeyLabel, isTypingTarget, registerHotkey } from './hotkeys';

const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach(fn => fn());
  document.body.innerHTML = '';
});

describe('klavye kısayolları', () => {
  it('tuş adlarını Ctrl/⌘ farkı olmadan normalleştirir', () => {
    expect(eventKey({ key: 'S', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe('mod+shift+s');
    expect(eventKey({ key: 'k', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false })).toBe('mod+k');
    expect(eventKey({ key: '?', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true })).toBe('?');
    expect(hotkeyLabel('g f')).toEqual(['G', 'F']);
  });

  it('"g f" dizisini çalıştırır; yazı alanında tekli kısayolları yutmaz', () => {
    const go = vi.fn();
    const slash = vi.fn();
    cleanups.push(registerHotkey('g f', go), registerHotkey('/', slash, { scope: 'page' }));
    press('g');
    press('f');
    expect(go).toHaveBeenCalledTimes(1);

    const input = document.createElement('input');
    document.body.append(input);
    expect(isTypingTarget(input)).toBe(true);
    const typed = press('/', {}, input);
    expect(slash).not.toHaveBeenCalled();
    expect(typed.defaultPrevented).toBe(false);
  });

  it('Ctrl ile başlayan kısayol yazı alanında da çalışır; açık modalde sayfa kısayolu susar', () => {
    const save = vi.fn();
    const pageNew = vi.fn();
    cleanups.push(registerHotkey('mod+s', save, { allowInInputs: true }), registerHotkey('n', pageNew, { scope: 'page' }));
    const input = document.createElement('input');
    document.body.append(input);
    expect(press('s', { ctrlKey: true }, input).defaultPrevented).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    press('n');
    expect(pageNew).not.toHaveBeenCalled();
  });

  it('aynı tuşa son kaydolan kazanır; kaydı silinince önceki geri gelir', () => {
    const first = vi.fn();
    const second = vi.fn();
    cleanups.push(registerHotkey('n', first));
    const off = registerHotkey('n', second);
    press('n');
    expect(second).toHaveBeenCalledTimes(1);
    off();
    press('n');
    expect(first).toHaveBeenCalledTimes(1);
  });
});
