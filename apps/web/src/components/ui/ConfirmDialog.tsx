import * as Dialog from '@radix-ui/react-dialog';
import { useRef, type ReactNode } from 'react';
import { Button } from './Button';
import { Callout } from './Feedback';

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = 'Onayla', cancelLabel = 'Vazgeç', danger, loading, error, onConfirm, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string;
  confirmLabel?: string; cancelLabel?: string; danger?: boolean; loading?: boolean; error?: string | null;
  onConfirm: () => void; children?: ReactNode;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!loading) onOpenChange(next); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[80] bg-inverted/50" />
      <Dialog.Content role="alertdialog" onOpenAutoFocus={(event) => {
        event.preventDefault(); trigger.current = document.activeElement as HTMLElement; cancel.current?.focus();
      }} onCloseAutoFocus={(event) => { if (trigger.current?.isConnected) { event.preventDefault(); trigger.current.focus(); } }}
        onEscapeKeyDown={(event) => { if (loading) event.preventDefault(); }}
        onPointerDownOutside={(event) => event.preventDefault()}
        className="fixed left-1/2 top-1/2 z-[90] flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-surface p-6">
        <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
        <Dialog.Description className="mt-2 text-sm text-muted">{description ?? 'İşlemi onaylayın veya bu ekrana dönün.'}</Dialog.Description>
        {children && <div className="mt-4 min-h-0 overflow-y-auto">{children}</div>}
        {error && <div className="mt-4"><Callout tone="danger">{error}</Callout></div>}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button ref={cancel} disabled={loading} onClick={() => onOpenChange(false)}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={() => { if (!loading) onConfirm(); }}>{confirmLabel}</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
