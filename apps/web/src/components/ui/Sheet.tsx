import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Geniş formlar (yevmiye) için */
  wide?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}

/** Sağdan açılan yan panel: modal yığını yerine ana bağlamı görünür tutar. */
export function Sheet({ open, onOpenChange, title, description, wide, footer, children }: SheetProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/40 backdrop-blur-[1px] [animation:fade-in_0.15s_ease-out]" />
        <Dialog.Content
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-surface shadow-pop [animation:sheet-in_0.2s_ease-out]',
            wide ? 'max-w-4xl' : 'max-w-md',
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
            <div>
              <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
              <Dialog.Description className={cn('mt-0.5 text-sm text-muted', !description && 'sr-only')}>
                {description ?? title}
              </Dialog.Description>
            </div>
            <Dialog.Close className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text" aria-label="Kapat">
              <X className="size-5" />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2/50 px-6 py-3">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Kısa onay/giriş iletişim kutusu (silme onayı vb.) */
export function Modal({ open, onOpenChange, title, description, footer, children }: Omit<SheetProps, 'wide'>) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/40 [animation:fade-in_0.15s_ease-out]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface shadow-pop [animation:pop-in_0.15s_ease-out]">
          <div className="px-6 pt-5">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Description className={cn('mt-1 text-sm text-muted', !description && 'sr-only')}>
              {description ?? title}
            </Dialog.Description>
          </div>
          {children && <div className="px-6 py-4">{children}</div>}
          <div className="flex justify-end gap-2 px-6 pb-5 pt-2">{footer}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
