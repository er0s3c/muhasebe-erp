import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Outlet, useBlocker } from 'react-router-dom';
import { ConfirmDialog } from './ConfirmDialog';
import { parseTR } from '@erp/shared';

type LeaveAction = () => void | Promise<void>;
interface DraftState { dirty: boolean; pending: boolean }
interface DraftContext {
  register: (id: string, state: DraftState | null) => void;
  confirmLeave: (action: LeaveAction) => Promise<boolean>;
  dirty: boolean;
  pending: boolean;
  isTransitionApproved: () => boolean;
  hasDrafts: () => boolean;
}
const passthrough: DraftContext = {
  register: () => undefined,
  confirmLeave: async (action) => { await action(); return true; },
  dirty: false,
  pending: false,
  isTransitionApproved: () => false,
  hasDrafts: () => false,
};
const Context = createContext<DraftContext>(passthrough);

/** App-neutral draft protection. Forced session expiry always remains possible. */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const drafts = useRef(new Map<string, DraftState>());
  const [state, setState] = useState({ dirty: false, pending: false });
  const [request, setRequest] = useState<{ action: LeaveAction; resolve: (ok: boolean) => void } | null>(null);
  const requestRef = useRef<typeof request>(null);
  const approved = useRef(false);
  const register = useCallback((id: string, draft: DraftState | null) => {
    if (draft) drafts.current.set(id, draft); else drafts.current.delete(id);
    const next = {
      dirty: [...drafts.current.values()].some((d) => d.dirty),
      pending: [...drafts.current.values()].some((d) => d.pending),
    };
    setState((previous) => previous.dirty === next.dirty && previous.pending === next.pending ? previous : next);
  }, []);
  const confirmLeave = useCallback(async (action: LeaveAction) => {
    if ([...drafts.current.values()].some((d) => d.pending)) return false;
    if (![...drafts.current.values()].some((d) => d.dirty)) { await action(); return true; }
    if (requestRef.current) return false;
    return new Promise<boolean>((resolve) => {
      const next = { action, resolve };
      requestRef.current = next;
      setRequest(next);
    });
  }, []);
  const close = () => {
    requestRef.current?.resolve(false);
    requestRef.current = null;
    setRequest(null);
  };
  useEffect(() => {
    if (!state.dirty && !state.pending) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [state.dirty, state.pending]);
  useEffect(() => () => requestRef.current?.resolve(false), []);
  return <Context.Provider value={{ register, confirmLeave, isTransitionApproved: () => approved.current, hasDrafts: () => [...drafts.current.values()].some((draft) => draft.dirty || draft.pending), ...state }}>
    {children}
    <ConfirmDialog open={request !== null} onOpenChange={(open) => { if (!open) close(); }}
      title="Kaydedilmemiş değişiklikler" description="Bu ekrandan ayrılırsanız kaydedilmemiş değişiklikler kaybolur."
      confirmLabel="Değişiklikleri bırak" cancelLabel="Düzenlemeye devam et" danger
      onConfirm={() => {
        const current = requestRef.current;
        if (!current) return;
        requestRef.current = null;
        setRequest(null);
        approved.current = true;
        current.resolve(true);
        void Promise.resolve(current.action()).finally(() => { approved.current = false; });
      }} />
  </Context.Provider>;
}

export const useUnsavedChanges = () => useContext(Context);

export function useUnsavedForm(dirty: boolean, pending = false) {
  const id = useId();
  const { register } = useUnsavedChanges();
  useEffect(() => { register(id, { dirty, pending }); }, [id, register, dirty, pending]);
  useEffect(() => () => register(id, null), [id, register]);
  return useCallback(() => register(id, { dirty: false, pending: false }), [id, register]);
}

export function RouteChangeGuard({ children }: { children?: ReactNode }) {
  const { confirmLeave, isTransitionApproved, hasDrafts } = useUnsavedChanges();
  const blocker = useBlocker(({ currentLocation, nextLocation }) => !isTransitionApproved() && hasDrafts() &&
    `${currentLocation.pathname}${currentLocation.search}${currentLocation.hash}` !==
    `${nextLocation.pathname}${nextLocation.search}${nextLocation.hash}`);
  const handled = useRef(false);
  useEffect(() => {
    if (blocker.state !== 'blocked') { handled.current = false; return; }
    if (handled.current) return;
    handled.current = true;
    void confirmLeave(() => blocker.proceed()).then((ok) => { if (!ok) blocker.reset(); });
  }, [blocker, confirmLeave]);
  return children ?? <Outlet />;
}

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
function formValues(root: HTMLElement): string {
  return JSON.stringify(Array.from(root.querySelectorAll<Control>('input,select,textarea'))
    .filter((control) => !control.disabled && !['hidden', 'search', 'button', 'submit'].includes(control.type) &&
      !control.closest('[data-form-guard="off"], [role="search"]'))
    .map((control, index) => [control.name || control.id || index,
      control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type) ? control.checked :
        control instanceof HTMLInputElement && control.inputMode === 'decimal' ? normalizedNumber(control.value) : control.value]));
}
function normalizedNumber(value: string) {
  const canonical = parseTR(value);
  return canonical === null ? value : canonical.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/** Captures editable forms; filters outside forms never become a business draft. */
export function FormGuard({ children, scopeKey, dirty, pending = false, captureAll = false, onStateChange, className = 'min-w-0' }: {
  children: ReactNode; scopeKey?: string; dirty?: boolean; pending?: boolean; captureAll?: boolean;
  onStateChange?: (state: DraftState) => void; className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const baselines = useRef(new Map<HTMLElement, string>());
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const clear = useUnsavedForm(dirty ?? changed, pending || busy);
  useEffect(() => { onStateChange?.({ dirty: dirty ?? changed, pending: pending || busy }); }, [dirty, changed, pending, busy, onStateChange]);
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    baselines.current.clear();
    setChanged(false);
    const area = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof HTMLElement) || target.closest('[data-form-guard="off"], [role="search"]')) return null;
      return captureAll ? container : target.closest('form:not([method="get"]):not([role="search"])');
    };
    const beforeEdit = (event: Event) => {
      const form = area(event.target);
      if (form && !baselines.current.has(form)) baselines.current.set(form, formValues(form));
    };
    const inspect = () => {
      for (const form of baselines.current.keys()) if (!form.isConnected) baselines.current.delete(form);
      setChanged([...baselines.current].some(([form, baseline]) => formValues(form) !== baseline));
      setBusy(!!container.querySelector(captureAll ? '[aria-busy="true"], [data-form-pending="true"]' : 'form [aria-busy="true"], [data-form-pending="true"]'));
    };
    const edited = (event: Event) => { beforeEdit(event); inspect(); };
    const focusError = () => requestAnimationFrame(() => container.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
    const submitted = () => { focusError(); };
    const clicked = (event: Event) => {
      const button = (event.target as HTMLElement).closest('button[data-variant="primary"]');
      if (button) focusError();
    };
    const reset = () => { baselines.current.clear(); setChanged(false); clear(); };
    const observer = new MutationObserver(inspect);
    observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy', 'data-form-pending', 'value', 'checked'] });
    ['focusin', 'pointerdown', 'keydown', 'beforeinput'].forEach((event) => container.addEventListener(event, beforeEdit, true));
    ['input', 'change'].forEach((event) => container.addEventListener(event, edited));
    container.addEventListener('reset', reset);
    container.addEventListener('submit', submitted);
    container.addEventListener('click', clicked);
    container.addEventListener('erp-form-saved', reset);
    window.addEventListener('erp-session-cleared', reset);
    return () => {
      observer.disconnect();
      ['focusin', 'pointerdown', 'keydown', 'beforeinput'].forEach((event) => container.removeEventListener(event, beforeEdit, true));
      ['input', 'change'].forEach((event) => container.removeEventListener(event, edited));
      container.removeEventListener('reset', reset);
      container.removeEventListener('submit', submitted);
      container.removeEventListener('click', clicked);
      container.removeEventListener('erp-form-saved', reset);
      window.removeEventListener('erp-session-cleared', reset);
    };
  }, [scopeKey, captureAll, clear]);
  return <div ref={root} className={className} data-form-guard-boundary data-form-guard-scope={scopeKey}>{children}</div>;
}

/** Notify the nearest form guard after a confirmed successful save. */
export function markFormSaved(element?: Element | null) {
  const root = element?.closest('[data-form-guard-boundary]') ?? document.querySelector('main [data-form-guard-boundary]');
  root?.dispatchEvent(new Event('erp-form-saved', { bubbles: false }));
}
