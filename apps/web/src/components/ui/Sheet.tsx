import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { FormGuard, useUnsavedChanges } from './UnsavedChanges';

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Geniş formlar (yevmiye) için */
  wide?: boolean;
  footer?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
}

/**
 * Açılıştaki odaklı öğeyi (tetikleyici düğme) hatırlar ve kapanınca odağı ona geri verir (UI-14). Denetimli
 * Sheet/Modal'larda Dialog.Trigger olmadığından Radix odağı <body>'ye bırakıyordu.
 */
function useReturnFocus(open: boolean) {
  const trigger = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) trigger.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  }, [open]);
  return (e: Event) => {
    const el = trigger.current;
    trigger.current = null;
    if (el && el.isConnected) {
      e.preventDefault();
      el.focus();
    }
  };
}

const SUBMIT_INPUT_TYPES = new Set(['text', 'search', 'email', 'tel', 'url', 'password', 'number', 'date', 'month', 'time', 'datetime-local']);

/**
 * Tek satırlık bir alanda Enter: alt bilgideki birincil düğmeye (Kaydet) basar (UI-15). Düğme devre dışıysa ya da
 * işlem sürüyorsa (loading → disabled) hiçbir şey olmaz; böylece Enter'a art arda basmak çift kayıt üretmez.
 * Açılır listeler (combobox), çok satırlı alanlar ve kendi gönder düğmesi olan formlar kendi davranışını korur.
 */
function enterSubmits(footerRef: RefObject<HTMLElement | null>) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.nativeEvent.isComposing) return;
    const el = e.target as HTMLElement;
    if (!(el instanceof HTMLInputElement) || !SUBMIT_INPUT_TYPES.has(el.type) || el.getAttribute('role') === 'combobox') return;
    if (el.form?.querySelector('button[type="submit"], input[type="submit"]')) return;
    const primary = footerRef.current?.querySelector<HTMLButtonElement>('button[data-variant="primary"]');
    if (!primary) return;
    e.preventDefault();
    if (!primary.disabled) primary.click();
  };
}

/** Sağdan açılan yan panel: modal yığını yerine ana bağlamı görünür tutar. */
export function Sheet({ open, onOpenChange, title, description, wide, footer, children, contentClassName }: SheetProps) {
  const { t } = useTranslation();
  const returnFocus = useReturnFocus(open);
  const footerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState({ dirty: false, pending: false });
  const { confirmLeave } = useUnsavedChanges();
  const changeOpen = (next: boolean) => {
    if (next) { onOpenChange(true); return; }
    if (draft.pending) return;
    if (draft.dirty) void confirmLeave(() => onOpenChange(false)); else onOpenChange(false);
  };
  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-inverted/50 backdrop-blur-[8px] [animation:fade-in_0.15s_ease-out]" />
        <Dialog.Content
          onCloseAutoFocus={returnFocus}
          onKeyDown={enterSubmits(footerRef)}
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-surface [animation:sheet-in_0.2s_ease-out]',
            wide ? 'max-w-4xl' : 'max-w-md',
          )}
        >
          <FormGuard captureAll scopeKey={open ? title : 'closed'} onStateChange={setDraft} className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-subheading">{title}</Dialog.Title>
              <Dialog.Description className={cn('mt-0.5 text-sm text-muted', !description && 'sr-only')}>
                {description ?? title}
              </Dialog.Description>
            </div>
            <Dialog.Close className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text" aria-label={t('common.close')}>
              <X className="size-5" />
            </Dialog.Close>
          </div>
          <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 py-5', contentClassName)}>{children}</div>
          {footer && (
            <div ref={footerRef} onClickCapture={(event) => {
              const button = (event.target as HTMLElement).closest('button');
              if (button && /^(Vazgeç|Kapat|Geri)$/.test(button.textContent?.trim() ?? '') && (draft.dirty || draft.pending)) {
                event.preventDefault(); event.stopPropagation(); changeOpen(false);
              }
            }} className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-2/50 px-6 py-3">
              {footer}
            </div>
          )}
          </FormGuard>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Kısa onay/giriş iletişim kutusu (silme onayı vb.). Kısa ekranda (yatay telefon, açık klavye) içerik kayar (UI-19). */
export function Modal({ open, onOpenChange, title, description, footer, children }: Omit<SheetProps, 'wide'>) {
  const returnFocus = useReturnFocus(open);
  const footerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState({ dirty: false, pending: false });
  const { confirmLeave } = useUnsavedChanges();
  const changeOpen = (next: boolean) => {
    if (next) { onOpenChange(true); return; }
    if (draft.pending) return;
    if (draft.dirty) void confirmLeave(() => onOpenChange(false)); else onOpenChange(false);
  };
  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-inverted/50 backdrop-blur-[8px] [animation:fade-in_0.15s_ease-out]" />
        <Dialog.Content
          onCloseAutoFocus={returnFocus}
          onKeyDown={enterSubmits(footerRef)}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-surface [animation:pop-in_0.15s_ease-out]"
        >
          <FormGuard captureAll scopeKey={open ? title : 'closed'} onStateChange={setDraft} className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 px-6 pt-5">
            <Dialog.Title className="text-base">{title}</Dialog.Title>
            <Dialog.Description className={cn('mt-1 text-sm text-muted', !description && 'sr-only')}>
              {description ?? title}
            </Dialog.Description>
          </div>
          {children && <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>}
          <div ref={footerRef} onClickCapture={(event) => {
            const button = (event.target as HTMLElement).closest('button');
            if (button && /^(Vazgeç|Kapat|Geri)$/.test(button.textContent?.trim() ?? '') && (draft.dirty || draft.pending)) {
              event.preventDefault(); event.stopPropagation(); changeOpen(false);
            }
          }} className="flex shrink-0 flex-wrap justify-end gap-2 px-6 pb-5 pt-2">
            {footer}
          </div>
          </FormGuard>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
