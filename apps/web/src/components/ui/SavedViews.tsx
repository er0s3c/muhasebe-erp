import { useState } from 'react';
import { Bookmark, Trash2 } from 'lucide-react';
import { Button } from './Button';
import { Field, Input, Select } from './Field';
import { Modal } from './Sheet';

export type ViewFilters = Record<string, string | boolean>;
interface SavedView { id: string; name: string; filters: ViewFilters }
export function savedViewsKey(scope: readonly string[]) { return `ada:views:v1:${scope.map(encodeURIComponent).join(':')}`; }
export function readSavedViews(key: string, template: ViewFilters): SavedView[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 20).flatMap((value) => {
      if (!value || typeof value.id !== 'string' || typeof value.name !== 'string' || !value.filters || typeof value.filters !== 'object') return [];
      const filters: ViewFilters = {};
      for (const [name, initial] of Object.entries(template)) {
        const candidate: unknown = value.filters[name];
        if (typeof candidate === typeof initial && (typeof candidate !== 'string' || candidate.length <= 100)) filters[name] = candidate as string | boolean;
        else return [];
      }
      return [{ id: value.id.slice(0, 80), name: value.name.slice(0, 40), filters }];
    });
  } catch { return []; }
}

/** Only explicit filter preferences are stored. Records, search terms and credentials are excluded by callers. */
export function SavedViews({ scope, filters, onApply, description = 'Yalnızca bu tarayıcıdaki kullanıcı, şirket ve şube için saklanır. Arama metni kaydedilmez.' }: { scope: readonly string[]; filters: ViewFilters; onApply: (filters: ViewFilters) => void; description?: string }) {
  const key = savedViewsKey(scope);
  const [views, setViews] = useState(() => readSavedViews(key, filters));
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const persist = (next: SavedView[]) => {
    try { localStorage.setItem(key, JSON.stringify(next)); setViews(next); setError(undefined); return true; }
    catch { setError('Bu tarayıcıda görünümler saklanamıyor. Tarayıcı depolama ayarlarını kontrol edin.'); return false; }
  };
  return <div className="flex min-w-0 flex-wrap items-center gap-2" data-form-guard="off">
    {views.length > 0 && <Select className="w-52" value="" aria-label="Kayıtlı görünüm uygula" onChange={(event) => {
      const selected = views.find((view) => view.id === event.target.value);
      if (selected) onApply(selected.filters);
    }}><option value="">Kayıtlı görünümler</option>{views.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}</Select>}
    <Button size="sm" variant="ghost" onClick={() => { setName(''); setError(undefined); setOpen(true); }}><Bookmark className="size-4" aria-hidden />Görünümü kaydet</Button>
    <Modal open={open} onOpenChange={setOpen} title="Filtre görünümünü kaydet" description={description}
      footer={<><Button onClick={() => setOpen(false)}>Vazgeç</Button><Button variant="primary" disabled={!name.trim() || views.length >= 20} onClick={() => {
        const next = [...views, { id: crypto.randomUUID(), name: name.trim().slice(0, 40), filters }];
        if (persist(next)) setOpen(false);
      }}>Kaydet</Button></>}>
      <div data-form-guard="off" className="space-y-4"><Field label="Görünüm adı" error={error} required>{(id) => <Input id={id} value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />}</Field>
      {views.length >= 20 && <p className="text-xs text-muted">En fazla 20 görünüm saklanabilir. Yeni görünüm için eskilerden birini kaldırın.</p>}
      {views.map((view) => <div key={view.id} className="flex items-center justify-between gap-3 border-t border-border pt-3 text-sm"><span className="min-w-0 break-words">{view.name}</span><Button size="sm" variant="ghost" aria-label={`${view.name} görünümünü kaldır`} onClick={() => persist(views.filter((item) => item.id !== view.id))}><Trash2 className="size-4" aria-hidden /></Button></div>)}</div>
    </Modal>
  </div>;
}
