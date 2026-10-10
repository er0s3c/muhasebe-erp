import { ArrowDown, ArrowUp, GripVertical, LayoutGrid, Plus, RotateCcw, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/Card';
import { ErrorState } from '../../components/ui/Feedback';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { formatDateTR } from '../../lib/format';
import { usePreference } from '../../lib/personal';
import { useSession } from '../../lib/session';
import { useDashboardSummary, useSectionAccess, type SummarySection } from './summary';
import { WIDGET_BY_ID, WIDGETS, type WidgetDef, type WidgetSize } from './widgets';

interface LayoutItem {
  id: string;
  size: WidgetSize;
}
interface Layout {
  version: 1;
  widgets: LayoutItem[];
}

function parseLayout(value: unknown): Layout | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { version?: unknown; widgets?: unknown };
  if (v.version !== 1 || !Array.isArray(v.widgets)) return null;
  const widgets = v.widgets.filter(
    (w): w is LayoutItem => !!w && typeof w.id === 'string' && WIDGET_BY_ID.has(w.id) && (w.size === 's' || w.size === 'm' || w.size === 'l'),
  );
  return { version: 1, widgets };
}

const SIZE_CLASS: Record<WidgetSize, string> = {
  s: 'col-span-1',
  m: 'col-span-2',
  l: 'col-span-2 xl:col-span-4',
};
const SIZE_LABEL: Record<WidgetSize, string> = { s: 'Küçük', m: 'Orta', l: 'Geniş' };

/**
 * Kişiselleştirilebilir pano: widget'lar eklenir/çıkarılır, sürükle-bırak veya ok düğmeleriyle sıralanır, boyutu değiştirilir.
 * Düzen kullanıcı + şirket bazında sunucuda saklanır. Göstergeler tek `/api/dashboard/summary` isteğiyle gelir.
 */
export function DashboardPage() {
  const { t } = useTranslation();
  const { user, activeCompany } = useSession();
  const toast = useToast();
  const { ready, access, can } = useSectionAccess();
  const available = useMemo(
    () => WIDGETS.filter(w => w.sections.every(s => access[s]) && (w.requires?.(can) ?? true)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, JSON.stringify(access)],
  );
  const defaults = useMemo<Layout>(() => ({ version: 1, widgets: available.map(w => ({ id: w.id, size: w.defaultSize })) }), [available]);
  const pref = usePreference<Layout | null>('dashboard.layout', parseLayout, null);
  const saved = pref.value ?? defaults;
  const [draft, setDraft] = useState<Layout | null>(null);
  const editing = draft !== null;
  const layout = (draft ?? saved).widgets.filter(w => available.some(a => a.id === w.id));
  const hidden = available.filter(w => !layout.some(l => l.id === w.id));

  const sections = useMemo(() => {
    const out = new Set<SummarySection>();
    for (const item of layout) {
      const def = WIDGET_BY_ID.get(item.id)!;
      def.sections.forEach(s => out.add(s));
      def.extraSections?.forEach(s => access[s] && out.add(s));
    }
    return [...out];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.map(l => l.id).join(','), JSON.stringify(access)]);
  const summary = useDashboardSummary(sections, ready && !pref.loading);

  const update = (fn: (items: LayoutItem[]) => LayoutItem[]) => setDraft(d => ({ version: 1, widgets: fn((d ?? saved).widgets.filter(w => available.some(a => a.id === w.id))) }));
  const move = (id: string, delta: -1 | 1) =>
    update(items => {
      const list = [...items];
      const from = list.findIndex(i => i.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= list.length) return list;
      [list[from], list[to]] = [list[to]!, list[from]!];
      return list;
    });
  const [dragging, setDragging] = useState<string | null>(null);
  const dropOn = (targetId: string) =>
    update(items => {
      if (!dragging || dragging === targetId) return items;
      const list = items.filter(i => i.id !== dragging);
      const dragged = items.find(i => i.id === dragging)!;
      list.splice(list.findIndex(i => i.id === targetId), 0, dragged);
      return list;
    });
  const finish = () => {
    if (!draft) return;
    pref.save(draft).then(
      () => {
        setDraft(null);
        toast.success('Pano düzeni kaydedildi.');
      },
      () => toast.error('Pano düzeni kaydedilemedi. Bağlantınızı kontrol edip tekrar deneyin.'),
    );
  };

  const today = summary.data?.today;
  return (
    <>
      <PageHeader
        title={t('dashboard.greeting', { name: user?.fullName.split(' ')[0] ?? '' })}
        helpKey="dashboard"
        favorite={false}
        description={`${t('dashboard.subtitle', { company: activeCompany?.name ?? '' })}${today ? ` · ${formatDateTR(today)}` : ''}`}
        actions={
          editing ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setDraft(defaults)}>
                <RotateCcw className="size-4" aria-hidden />
                Varsayılana dön
              </Button>
              <Button size="sm" onClick={() => setDraft(null)}>Vazgeç</Button>
              <Button size="sm" variant="primary" loading={pref.saving} onClick={finish}>Düzeni kaydet</Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setDraft(saved)} aria-label="Panoyu düzenle: widget ekle, çıkar ve sırala">
              <LayoutGrid className="size-4" aria-hidden />
              Panoyu düzenle
            </Button>
          )
        }
      />

      {editing && (
        <section aria-label="Widget ekle" className="mb-5 rounded-2xl border border-dashed border-border-strong bg-surface p-4">
          <p className="mb-2 text-sm font-medium">Widget ekle</p>
          {hidden.length ? (
            <div className="flex flex-wrap gap-2">
              {hidden.map(w => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => update(items => [...items, { id: w.id, size: w.defaultSize }])}
                  title={w.help}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg px-3 py-1.5 text-sm transition-colors hover:border-border-strong hover:bg-surface-2"
                >
                  <Plus className="size-3.5" aria-hidden />
                  {w.title}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted">Kullanabileceğiniz tüm widget’lar panoda. Kaldırmak için widget üzerindeki × düğmesini kullanın.</p>
          )}
          <p className="mt-3 text-xs text-muted">Sıralamak için widget’ı sürükleyin ya da ok düğmelerini kullanın. Düzen yalnız sizin için ve bu şirkette saklanır.</p>
        </section>
      )}

      {summary.error && !summary.data && (
        <div className="mb-5">
          <ErrorState onRetry={() => void summary.refetch()} retrying={summary.isFetching} />
        </div>
      )}
      {summary.data && summary.data.errors.length > 0 && (
        <p role="status" className="mb-4 text-xs text-warning">Bazı göstergeler hesaplanamadı; ilgili kartlar “—” gösterir.</p>
      )}

      {layout.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border-strong bg-surface p-10 text-center">
          <p className="text-sm text-muted">Panonuzda widget yok.</p>
          {!editing && <Button className="mt-3" size="sm" onClick={() => setDraft(saved)}><Plus className="size-4" aria-hidden />Widget ekle</Button>}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          {layout.map((item, index) => {
            const def = WIDGET_BY_ID.get(item.id)!;
            return (
              <div
                key={item.id}
                className={cn('min-w-0', SIZE_CLASS[item.size], editing && 'flex flex-col rounded-2xl border border-dashed border-border-strong p-1.5', dragging === item.id && 'opacity-50')}
                draggable={editing}
                onDragStart={e => { setDragging(item.id); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => setDragging(null)}
                onDragOver={e => { if (editing && dragging && dragging !== item.id) e.preventDefault(); }}
                onDrop={e => { e.preventDefault(); dropOn(item.id); setDragging(null); }}
              >
                {editing && <WidgetToolbar def={def} item={item} first={index === 0} last={index === layout.length - 1} onMove={d => move(item.id, d)} onResize={size => update(items => items.map(i => (i.id === item.id ? { ...i, size } : i)))} onRemove={() => update(items => items.filter(i => i.id !== item.id))} />}
                <div className={cn('h-full min-h-0', editing && 'pointer-events-none flex-1 select-none opacity-80')} aria-hidden={editing || undefined}>
                  {def.render({ data: summary.data, size: item.size })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function WidgetToolbar({
  def,
  item,
  first,
  last,
  onMove,
  onResize,
  onRemove,
}: {
  def: WidgetDef;
  item: LayoutItem;
  first: boolean;
  last: boolean;
  onMove: (delta: -1 | 1) => void;
  onResize: (size: WidgetSize) => void;
  onRemove: () => void;
}) {
  const btn = 'flex size-7 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40';
  return (
    <div className="mb-1.5 flex min-w-0 items-center gap-1 rounded-lg border border-border bg-surface-raised px-1.5 py-1">
      <GripVertical className="size-4 shrink-0 cursor-grab text-muted" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{def.title}</span>
      {def.sizes.length > 1 && (
        <div role="group" aria-label={`${def.title} boyutu`} className="flex rounded-md bg-surface-2 p-0.5">
          {def.sizes.map(size => (
            <button
              key={size}
              type="button"
              aria-pressed={item.size === size}
              aria-label={`${SIZE_LABEL[size]} boyut`}
              onClick={() => onResize(size)}
              className={cn('h-6 rounded px-1.5 text-[11px] font-medium text-muted', item.size === size && 'bg-surface text-text')}
            >
              {size.toUpperCase()}
            </button>
          ))}
        </div>
      )}
      <button type="button" className={btn} disabled={first} onClick={() => onMove(-1)} aria-label={`${def.title} öne al`}><ArrowUp className="size-3.5" aria-hidden /></button>
      <button type="button" className={btn} disabled={last} onClick={() => onMove(1)} aria-label={`${def.title} geriye al`}><ArrowDown className="size-3.5" aria-hidden /></button>
      <button type="button" className={btn} onClick={onRemove} aria-label={`${def.title} widget’ını kaldır`}><X className="size-3.5" aria-hidden /></button>
    </div>
  );
}
