import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Merkezi klavye kısayolları. Tek bir `keydown` dinleyicisi tüm kayıtları yönetir:
 * - "mod+s" (Ctrl/⌘), "?" ve "/" gibi tekli tuşlar; "g f" gibi iki adımlı diziler (1,2 sn içinde).
 * - Yazı alanında (input/textarea/select/contenteditable) yalnızca `allowInInputs` kısayolları çalışır.
 * - Açık bir modal varken sayfa kısayolları (`scope: 'page'`) susar; aynı tuşa son kaydolan kazanır.
 */
export interface HotkeyOptions {
  description?: string;
  group?: 'Genel' | 'Gezinme' | 'Sayfa';
  allowInInputs?: boolean;
  scope?: 'global' | 'page';
  enabled?: boolean;
}
interface Binding extends HotkeyOptions {
  id: number;
  keys: string;
  handler: (event: KeyboardEvent) => void;
}

const bindings: Binding[] = [];
const subscribers = new Set<() => void>();
let snapshotCache: readonly Binding[] = [];
let nextId = 1;
let pending: { key: string; at: number } | null = null;
let installed = false;
const SEQUENCE_MS = 1200;

function notify() {
  snapshotCache = [...bindings];
  for (const fn of subscribers) fn();
}

export function eventKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string {
  const key = event.key.length === 1 ? event.key.toLocaleLowerCase('en-US') : event.key.toLowerCase();
  // Bazı düzen/otomasyonlar Shift+/ için "?" yerine "/" bildirir
  if (key === '/' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) return '?';
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  // "?" zaten Shift ile üretilir; harf olmayan karakterlerde Shift ayrıca yazılmaz
  if (event.shiftKey && /^[a-z0-9]$/.test(key)) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
}

function modalOpen() {
  return !!document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]');
}

function find(keys: string, typing: boolean, modal: boolean) {
  for (let i = bindings.length - 1; i >= 0; i--) {
    const b = bindings[i]!;
    if (b.keys !== keys || b.enabled === false) continue;
    if (typing && !b.allowInInputs) continue;
    if (modal && b.scope === 'page') continue;
    return b;
  }
  return null;
}

function onKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.repeat) return;
  const key = eventKey(event);
  if (key === 'shift' || key === 'control' || key === 'meta' || key === 'alt') return;
  const typing = isTypingTarget(event.target);
  const modal = modalOpen();
  const now = Date.now();
  if (pending && now - pending.at < SEQUENCE_MS && !typing) {
    const sequence = find(`${pending.key} ${key}`, typing, modal);
    pending = null;
    if (sequence) {
      event.preventDefault();
      sequence.handler(event);
      return;
    }
  }
  pending = null;
  const single = find(key, typing, modal);
  if (single) {
    event.preventDefault();
    single.handler(event);
    return;
  }
  if (!typing && bindings.some(b => b.enabled !== false && b.keys.startsWith(`${key} `))) pending = { key, at: now };
}

function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', onKeyDown);
}

export function registerHotkey(keys: string, handler: (event: KeyboardEvent) => void, options: HotkeyOptions = {}) {
  install();
  const binding: Binding = { id: nextId++, keys, handler, ...options };
  bindings.push(binding);
  notify();
  return () => {
    const index = bindings.indexOf(binding);
    if (index >= 0) bindings.splice(index, 1);
    notify();
  };
}

/** Bileşen yaşadıkça kısayolu kaydeder; işleyici her render'da güncellenir (yeniden kayıt gerekmez). */
export function useHotkey(keys: string, handler: (event: KeyboardEvent) => void, options: HotkeyOptions = {}) {
  const ref = useRef(handler);
  ref.current = handler;
  const { description, group, allowInInputs, scope, enabled } = options;
  useEffect(() => {
    if (enabled === false) return;
    return registerHotkey(keys, event => ref.current(event), { description, group, allowInInputs, scope });
  }, [keys, description, group, allowInInputs, scope, enabled]);
}

/** Kısayol rehberi için: açıklaması olan kayıtlar (aynı tuş bir kez). */
export function useHotkeyList() {
  const list = useSyncExternalStore(
    fn => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    () => snapshotCache,
    () => snapshotCache,
  );
  const seen = new Set<string>();
  const out: { keys: string; description: string; group: string }[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i]!;
    if (!b.description || seen.has(b.keys)) continue;
    seen.add(b.keys);
    out.push({ keys: b.keys, description: b.description, group: b.group ?? 'Genel' });
  }
  return out.reverse();
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** "mod+s" → ["Ctrl", "S"]; "g f" → ["G", "F"] (görsel <kbd> parçaları). */
export function hotkeyLabel(keys: string): string[] {
  return keys
    .split(/[ +]/)
    .map(part => (part === 'mod' ? (IS_MAC ? '⌘' : 'Ctrl') : part === 'shift' ? 'Shift' : part === 'alt' ? 'Alt' : part === 'escape' ? 'Esc' : part.toUpperCase()));
}
