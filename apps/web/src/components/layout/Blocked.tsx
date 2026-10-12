import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Callout } from '../ui/Feedback';
import { markFormSaved } from '../ui/UnsavedChanges';
import { errorFix, type Blocker } from '../../lib/blockers';
import { errorMessage } from '../../lib/errors';
import { useCan } from '../../lib/queries';

function FixLink({ fix, onNavigate, discardDraft }: { fix: NonNullable<Blocker['fix']>; onNavigate?: () => void; discardDraft?: boolean }) {
  return <Link to={fix.to} className="link inline-flex shrink-0 items-center gap-1 text-sm" onClick={(event) => {
    if (discardDraft) markFormSaved(event.currentTarget);
    onNavigate?.();
  }}>
    {fix.label}<ArrowRight className="size-3.5" aria-hidden />
  </Link>;
}

/**
 * Reddedilen işlemin nedeni ve çözüm bağlantısı (öneri 28): sunucu mesajı gösterilir; engeli kaldıran ekran varsa bağlantı,
 * çözüm kullanıcının yetkisinde değilse kime başvuracağı eklenir. Sheet/Modal içinde `onNavigate` pencereyi kapatır.
 * `discardDraft` yalnız taslağı önemsiz pencerelerde (ör. iptal gerekçesi) verilir; bağlantı ayrılma onayı sormadan açılır.
 */
export function ErrorCallout({ error, title, onNavigate, discardDraft }: { error: unknown; title?: string; onNavigate?: () => void; discardDraft?: boolean }) {
  const can = useCan();
  const resolution = errorFix(error, can);
  return <Callout tone="danger" title={title} action={resolution?.fix && <FixLink fix={resolution.fix} onNavigate={onNavigate} discardDraft={discardDraft} />}>
    {errorMessage(error)}
    {resolution?.ask && <span className="mt-1 block">{resolution.ask}</span>}
  </Callout>;
}

/**
 * Pasif işlemin yanındaki kısa açıklama. Düğme `aria-describedby={id}` ile bu metne bağlanır; dokunmatik cihazda da görünür
 * olduğu için ipucu (title) yerine kullanılır.
 */
export function BlockedHint({ id, blocker, onNavigate }: { id: string; blocker: Blocker; onNavigate?: () => void }) {
  return <p id={id} className="flex flex-wrap items-center gap-x-2 text-xs text-muted" data-blocked-reason>
    <span>{blocker.reason}{blocker.ask && ` ${blocker.ask}`}</span>
    {blocker.fix && <FixLink fix={blocker.fix} onNavigate={onNavigate} />}
  </p>;
}
