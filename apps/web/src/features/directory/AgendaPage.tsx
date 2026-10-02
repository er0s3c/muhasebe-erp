import { CalendarCheck, Check, Plus, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Stat } from '../../components/ui/Stat';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { AgendaBucketKey, AgendaItem } from '../../lib/types';
import { AgendaItemSheet } from './AgendaItemSheet';
import { DIRECTORY_INVALIDATE } from './common';

type Scope = 'mine' | 'company' | 'all';
const SECTIONS: readonly AgendaBucketKey[] = ['overdue', 'today', 'upcoming', 'later'];

/** Ajanda satırı: tamamla / iptal / yeniden aç ve düzenle. Sahibi her zaman kendi kalemini düzenler. */
export function AgendaRow({ item, compact, onEdit }: { item: AgendaItem; compact?: boolean; onEdit?: (i: AgendaItem) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const act = useCMutation((a: 'complete' | 'cancel' | 'reopen', call) => call(`/api/agenda/${item.id}/${a}`, { method: 'POST' }), DIRECTORY_INVALIDATE);
  const run = (a: 'complete' | 'cancel' | 'reopen') => act.mutate(a, { onError: (e) => toast.error(errorMessage(e)) });
  const closed = item.status !== 'open';
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm" data-testid="agenda-row">
      {item.status === 'open' ? (
        <Button size="sm" aria-label={t('agenda.complete')} onClick={() => run('complete')}><Check className="size-3.5" aria-hidden />{compact ? null : t('agenda.complete')}</Button>
      ) : (
        <Button size="sm" aria-label={t('agenda.reopen')} onClick={() => run('reopen')}><RotateCcw className="size-3.5" aria-hidden />{compact ? null : t('agenda.reopen')}</Button>
      )}
      <div className="min-w-0 flex-1">
        <div className={closed ? 'text-muted line-through' : ''}>{item.title}</div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span>{formatDateTR(item.dueDate)}{item.allDay ? '' : ` ${item.startTime}${item.endTime ? `–${item.endTime}` : ''}`}</span>
          <Badge>{t(`agenda.kinds.${item.kind}`)}</Badge>
          {item.status !== 'open' && <Badge tone={item.status === 'done' ? 'success' : 'neutral'}>{t(`agenda.status.${item.status}`)}</Badge>}
          {item.remindBeforeMinutes != null && <span>{t('agenda.remindShort', { minutes: item.remindBeforeMinutes })}</span>}
          {item.contactId && <Link className="underline" to={`/directory/contacts/${item.contactId}`}>{item.contactName}</Link>}
          {item.partyId && <Link className="underline" to={`/parties/${item.partyId}`}>{item.partyName}</Link>}
          {item.projectCode && <Badge tone="brand">{item.projectCode}</Badge>}
          <span>{item.ownerName ?? t('agenda.companyOwner')}</span>
        </div>
      </div>
      {!compact && (
        <div className="flex gap-2">
          {item.status === 'open' && onEdit && <Button size="sm" onClick={() => onEdit(item)}>{t('common.edit')}</Button>}
          {item.status === 'open' && <Button size="sm" aria-label={t('agenda.cancel')} onClick={() => run('cancel')}><X className="size-3.5" aria-hidden />{t('agenda.cancel')}</Button>}
        </div>
      )}
    </li>
  );
}

/** Ajanda: gecikmiş / bugün / yaklaşan listeleri. Hatırlatma ofseti yalnızca veridir; bildirim gönderilmez. */
export function AgendaPage() {
  const { t } = useTranslation();
  const can = useCan();
  const [scope, setScope] = useState<Scope>('mine');
  const [showClosed, setShowClosed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AgendaItem | null>(null);
  const { data, isPending, error } = useCQuery<{ asOf: string; items: AgendaItem[] }>(['agenda', 'list', scope], `/api/agenda?scope=${scope}`);
  const items = data?.items ?? [];
  const by = (b: AgendaBucketKey) => items.filter((i) => i.bucket === b);
  const addButton = (
    <Button variant="primary" onClick={() => setAdding(true)}>
      <Plus className="size-4" aria-hidden />
      {t('agenda.add')}
    </Button>
  );
  return (
    <>
      <PageHeader title={t('agenda.title')} description={t('agenda.subtitle')} actions={<div className="flex flex-wrap gap-2"><ExportMenu exportKey="agenda" params={{ scope }} print={false} disabled={items.length === 0} />{addButton}</div>} />
      <div className="mb-4"><Callout tone="info">{t('agenda.reminderNote')}</Callout></div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SegmentedTabs
          value={scope}
          onChange={setScope}
          items={[
            { key: 'mine', label: t('agenda.scopes.mine') },
            { key: 'company', label: t('agenda.scopes.company') },
            { key: 'all', label: can('directory.manage') ? t('agenda.scopes.all') : t('agenda.scopes.allMine') },
          ]}
        />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />{t('agenda.showClosed')}</label>
      </div>
      {error ? (
        <Callout tone="danger">{errorMessage(error)}</Callout>
      ) : isPending ? (
        <PageLoading />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label={t('agenda.sections.overdue')}>{by('overdue').length}</Stat>
            <Stat label={t('agenda.sections.today')}>{by('today').length}</Stat>
            <Stat label={t('agenda.sections.upcoming')} sub={t('agenda.upcomingHint')}>{by('upcoming').length}</Stat>
          </div>
          {items.filter((i) => i.status === 'open').length === 0 && (
            <Card><EmptyState icon={<CalendarCheck className="size-5" />} title={t('agenda.empty')} description={t('agenda.emptyDesc')} action={addButton} /></Card>
          )}
          {SECTIONS.map((s) => {
            const list = by(s);
            if (list.length === 0) return null;
            return (
              <Card key={s} data-testid={`agenda-${s}`}>
                <CardHeader title={`${t(`agenda.sections.${s}`)} (${list.length})`} />
                <ul className="divide-y divide-border">{list.map((i) => <AgendaRow key={i.id} item={i} onEdit={setEditing} />)}</ul>
              </Card>
            );
          })}
          {showClosed && by('closed').length > 0 && (
            <Card>
              <CardHeader title={`${t('agenda.sections.closed')} (${by('closed').length})`} />
              <ul className="divide-y divide-border">{by('closed').map((i) => <AgendaRow key={i.id} item={i} />)}</ul>
            </Card>
          )}
        </div>
      )}
      <AgendaItemSheet open={adding || editing !== null} onOpenChange={(o) => { if (!o) { setAdding(false); setEditing(null); } }} edit={editing ?? undefined} />
    </>
  );
}
