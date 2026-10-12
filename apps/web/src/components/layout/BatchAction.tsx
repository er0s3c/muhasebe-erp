import { CheckCircle2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Feedback';
import { Modal } from '../ui/Sheet';
import { ApiError } from '../../lib/api';
import { errorFix } from '../../lib/blockers';
import { useCan, useIdempotencyKey } from '../../lib/queries';
import { ErrorCallout } from './Blocked';
import { Link } from 'react-router-dom';

export interface BatchItem { id: string; label: string; detail?: string }
export interface BatchItemResult<R> { id: string; ok: boolean; value?: R; error?: { code: string; message: string; details?: unknown } }
export interface BatchResponse<R> { dryRun: boolean; results: BatchItemResult<R>[]; summary: { ok: number; failed: number } }

/**
 * Önizlemeli toplu işlem (öneri 6). Önce sunucu her kaydı aynı kurallarla dener ve geri alır; kullanıcı hangi kaydın neden
 * yapılamayacağını (ve çözüm bağlantısını) görür, yalnız hazır kayıtları uygular. Uygulamada her kayıt ayrı işlenir; sonuç
 * kayıt kayıt gösterilir. Uygulama isteği tekrar anahtarı taşır (cevap kaybolsa da iki kez yapılmaz).
 */
export function BatchActionDialog<R>({ open, onOpenChange, title, description, actionLabel, items, run, describe, onDone }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  actionLabel: (count: number) => string;
  items: readonly BatchItem[];
  run: (ids: string[], dryRun: boolean, idempotencyKey?: string) => Promise<BatchResponse<R>>;
  describe: (value: R) => string;
  onDone?: () => void;
}) {
  const can = useCan();
  const command = useIdempotencyKey();
  const [stage, setStage] = useState<'idle' | 'previewing' | 'previewed' | 'running' | 'done'>('idle');
  const [preview, setPreview] = useState<BatchResponse<R> | null>(null);
  const [result, setResult] = useState<BatchResponse<R> | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Her açılış yeni bir önizlemeyle başlar (liste değişmiş olabilir)
  useEffect(() => { if (open) { setStage('idle'); setPreview(null); setResult(null); setError(null); } }, [open]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const ready = preview?.results.filter((r) => r.ok).map((r) => r.id) ?? [];

  const start = async () => {
    setStage('previewing'); setError(null); setResult(null); command.renew();
    try { setPreview(await run(items.map((i) => i.id), true)); setStage('previewed'); } catch (e) { setError(e); setStage('idle'); }
  };
  const apply = async () => {
    setStage('running'); setError(null);
    try { setResult(await run(ready, false, command.key)); setStage('done'); onDone?.(); } catch (e) { setError(e); setStage('previewed'); }
  };
  const shown = result ?? preview;

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} description={description}
      footer={<>
        <Button onClick={() => onOpenChange(false)}>{stage === 'done' ? 'Kapat' : 'Vazgeç'}</Button>
        {stage !== 'done' && (preview
          ? <Button variant="primary" disabled={ready.length === 0} loading={stage === 'running'} onClick={() => void apply()}>{actionLabel(ready.length)}</Button>
          : <Button variant="primary" loading={stage === 'previewing'} disabled={items.length === 0} onClick={() => void start()}>Önizle</Button>)}
      </>}>
      <div className="flex flex-col gap-3" data-form-guard="off">
        {error != null && <ErrorCallout error={error} />}
        {!shown && <p className="text-sm text-muted">{items.length} kayıt seçili. Önizleme hiçbir değişiklik yapmadan her kaydın sonucunu gösterir.</p>}
        {shown && <Callout tone={shown.summary.failed ? 'warning' : 'info'} title={result ? 'Sonuç' : 'Önizleme'}>
          {result ? `${result.summary.ok} kayıt işlendi` : `${preview!.summary.ok} kayıt hazır`}{shown.summary.failed ? `, ${shown.summary.failed} kayıt yapılamaz` : ''}.
        </Callout>}
        {shown && <ul className="flex max-h-80 flex-col gap-1.5 overflow-y-auto" aria-label={result ? 'Toplu işlem sonucu' : 'Toplu işlem önizlemesi'}>
          {shown.results.map((r) => {
            const item = byId.get(r.id);
            const fix = r.error ? errorFix(new ApiError(422, r.error.code, r.error.message, r.error.details), can)?.fix : undefined;
            return <li key={r.id} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              {r.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Hazır" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Yapılamaz" />}
              <span className="min-w-0 flex-1">
                <span className="block">{item?.label ?? r.id}{item?.detail && <span className="text-muted"> · {item.detail}</span>}</span>
                <span className={r.ok ? 'block text-xs text-muted' : 'block text-xs text-danger'}>{r.ok && r.value !== undefined ? describe(r.value) : r.error?.message}</span>
                {fix && <Link to={fix.to} className="link text-xs" onClick={() => onOpenChange(false)}>{fix.label}</Link>}
              </span>
            </li>;
          })}
        </ul>}
      </div>
    </Modal>
  );
}
