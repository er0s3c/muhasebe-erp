import { useState } from 'react';
import { Bookmark, Trash2, Users } from 'lucide-react';
import { Button } from './Button';
import { Field, Input, Select } from './Field';
import { Modal } from './Sheet';

export type ViewFilters = Record<string, string | boolean>;
export interface SavedViewItem { id: string; name: string; filters: ViewFilters; shared: boolean; mine: boolean; ownerName: string | null }
export const SAVED_VIEWS_MAX = 20;

/** Eski sürümün tarayıcıda tuttuğu görünümlerin anahtarı (yalnız sunucuya bir kez taşımak için okunur). */
export function savedViewsKey(scope: readonly string[]) { return `ada:views:v1:${scope.map(encodeURIComponent).join(':')}`; }

/** Görünüm yalnız ekranın bugünkü filtre alanlarıyla aynı ad ve türdeki değerleri taşıyorsa uygulanır; diğerleri atlanır. */
export function sanitizeViewFilters(candidate: unknown, template: ViewFilters): ViewFilters | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const filters: ViewFilters = {};
  for (const [name, initial] of Object.entries(template)) {
    const value: unknown = (candidate as Record<string, unknown>)[name];
    if (typeof value === typeof initial && (typeof value !== 'string' || value.length <= 100)) filters[name] = value as string | boolean;
    else return null;
  }
  return filters;
}

export function readSavedViews(key: string, template: ViewFilters): { id: string; name: string; filters: ViewFilters }[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, SAVED_VIEWS_MAX).flatMap((value) => {
      if (!value || typeof value.id !== 'string' || typeof value.name !== 'string') return [];
      const filters = sanitizeViewFilters(value.filters, template);
      return filters ? [{ id: value.id.slice(0, 80), name: value.name.slice(0, 40), filters }] : [];
    });
  } catch { return []; }
}

/**
 * Kayıtlı görünüm seçici. Yalnız açık filtre seçimleri saklanır; kayıtlar, arama metni ve kimlik bilgisi saklanmaz.
 * Saklama/paylaşım çağıran tarafındadır (bkz. CompanySavedViews).
 */
export function SavedViews({ views, onApply, onSave, onRemove, onShare, error, busy = false,
  description = 'Hesabınızda bu şirket ve şube seçimi için saklanır; başka cihazda da açılır. Arama metni kaydedilmez.' }: {
  views: readonly SavedViewItem[];
  onApply: (filters: ViewFilters) => void;
  onSave: (name: string, shared: boolean) => Promise<boolean>;
  onRemove: (id: string) => void;
  onShare: (id: string, shared: boolean) => void;
  error?: string;
  busy?: boolean;
  description?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const mine = views.filter((view) => view.mine);
  const team = views.filter((view) => !view.mine);
  const full = mine.length >= SAVED_VIEWS_MAX;
  return <div className="flex min-w-0 flex-wrap items-center gap-2" data-form-guard="off">
    {views.length > 0 && <Select className="w-52" value="" aria-label="Kayıtlı görünüm uygula" onChange={(event) => {
      const selected = views.find((view) => view.id === event.target.value);
      if (selected) onApply(selected.filters);
    }}>
      <option value="">Kayıtlı görünümler</option>
      {mine.length > 0 && <optgroup label="Görünümlerim">{mine.map((view) => <option key={view.id} value={view.id}>{view.name}{view.shared ? ' (ortak)' : ''}</option>)}</optgroup>}
      {team.length > 0 && <optgroup label="Ekip görünümleri">{team.map((view) => <option key={view.id} value={view.id}>{view.name}{view.ownerName ? ` — ${view.ownerName}` : ''}</option>)}</optgroup>}
    </Select>}
    <Button size="sm" variant="ghost" onClick={() => { setName(''); setShared(false); setOpen(true); }}><Bookmark className="size-4" aria-hidden />Görünümü kaydet</Button>
    <Modal open={open} onOpenChange={setOpen} title="Filtre görünümünü kaydet" description={description}
      footer={<><Button onClick={() => setOpen(false)}>Vazgeç</Button><Button variant="primary" loading={busy} disabled={!name.trim() || full} onClick={async () => {
        if (await onSave(name.trim().slice(0, 40), shared)) setOpen(false);
      }}>Kaydet</Button></>}>
      <div data-form-guard="off" className="space-y-4">
        <Field label="Görünüm adı" error={error} required>{(id) => <Input id={id} value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />}</Field>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={shared} onChange={(event) => setShared(event.target.checked)} />
          <span>Ekiple paylaş<span className="block text-xs text-muted">Aynı şirket ve şube seçimindeki üyeler görür; herkes sonuçları kendi yetkisiyle görür.</span></span></label>
        {full && <p className="text-xs text-muted">En fazla {SAVED_VIEWS_MAX} görünüm saklanabilir. Yeni görünüm için eskilerden birini kaldırın.</p>}
        {mine.map((view) => <div key={view.id} className="flex items-center justify-between gap-3 border-t border-border pt-3 text-sm">
          <span className="min-w-0 break-words">{view.name}{view.shared && <span className="ml-2 text-xs text-muted">ortak</span>}</span>
          <span className="flex shrink-0 gap-1">
            <Button size="sm" variant="ghost" aria-label={view.shared ? `${view.name} paylaşımını kaldır` : `${view.name} görünümünü ekiple paylaş`} aria-pressed={view.shared} onClick={() => onShare(view.id, !view.shared)}><Users className="size-4" aria-hidden /></Button>
            <Button size="sm" variant="ghost" aria-label={`${view.name} görünümünü kaldır`} onClick={() => onRemove(view.id)}><Trash2 className="size-4" aria-hidden /></Button>
          </span>
        </div>)}
      </div>
    </Modal>
  </div>;
}
