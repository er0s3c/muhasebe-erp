import { useRef, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { useUnsavedForm } from './UnsavedChanges';

interface Confirmation {
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<unknown>;
}

/** A confirmation stays open on failure and prevents duplicate requests. */
export function useConfirmation() {
  const [request, setRequest] = useState<Confirmation | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  useUnsavedForm(false, pending);
  const confirm = (next: Confirmation) => {
    if (running.current) return;
    setError(null);
    setRequest(next);
  };
  const dialog = <ConfirmDialog open={request !== null}
    onOpenChange={(open) => { if (!open && !running.current) setRequest(null); }}
    title={request?.title ?? 'İşlemi onaylayın'} description={request?.description}
    confirmLabel={request?.confirmLabel} danger={request?.danger} loading={pending} error={error}
    onConfirm={() => {
      if (!request || running.current) return;
      running.current = true;
      setPending(true);
      void Promise.resolve().then(request.onConfirm).then(() => setRequest(null))
        .catch(() => setError('İşlem tamamlanamadı. Yeniden deneyin.'))
        .finally(() => { running.current = false; setPending(false); });
    }} />;
  return { confirm, dialog, pending };
}
