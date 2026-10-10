import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { hotkeyLabel, useHotkey, useHotkeyList } from '../../lib/hotkeys';
import { Modal } from '../ui/Sheet';
import type { DisplayNavGroup } from './navigation';

/** "g" ile başlayan gezinme dizileri: yalnız kullanıcının menüsünde bulunan (izinli, modülü açık) hedefler kaydedilir. */
export const GO_TARGETS: ReadonlyArray<{ keys: string; path: string; label: string }> = [
  { keys: 'g d', path: '/', label: 'Genel bakış (pano)' },
  { keys: 'g i', path: '/workspace', label: 'Bugünkü işlerim' },
  { keys: 'g f', path: '/invoices/sales', label: 'Satış faturaları' },
  { keys: 'g a', path: '/invoices/purchases', label: 'Alış faturaları' },
  { keys: 'g c', path: '/parties', label: 'Cari hesaplar' },
  { keys: 'g s', path: '/inventory/items', label: 'Stok kartları' },
  { keys: 'g k', path: '/treasury/accounts', label: 'Kasa ve banka' },
  { keys: 'g b', path: '/hr/payroll', label: 'Bordro' },
  { keys: 'g y', path: '/accounting/journal', label: 'Yevmiye kayıtları' },
  { keys: 'g r', path: '/reports/executive-summary', label: 'Yönetici özeti' },
  { keys: 'g n', path: '/notifications', label: 'Bildirimler' },
];

export function Kbd({ keys }: { keys: string }) {
  const parts = hotkeyLabel(keys);
  const sequence = keys.includes(' ');
  return (
    <span className="inline-flex items-center gap-1">
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-[11px] text-muted">{sequence ? 'sonra' : '+'}</span>}
          <kbd className="inline-flex min-w-6 items-center justify-center rounded-md border border-border border-b-2 bg-surface px-1.5 py-0.5 font-sans text-[12px] font-medium text-text">
            {part}
          </kbd>
        </span>
      ))}
    </span>
  );
}

function GoHotkey({ keys, path, label }: { keys: string; path: string; label: string }) {
  const navigate = useNavigate();
  useHotkey(keys, () => navigate(path), { description: label, group: 'Gezinme' });
  return null;
}

/** Kabuk düzeyindeki kısayollar ve "?" rehberi. */
export function ShellHotkeys({ groups, onPalette }: { groups: DisplayNavGroup[]; onPalette: () => void }) {
  const [open, setOpen] = useState(false);
  useHotkey('mod+k', onPalette, { description: 'Arama ve komut paleti', group: 'Genel', allowInInputs: true });
  useHotkey('?', () => setOpen(o => !o), { description: 'Kısayol rehberi', group: 'Genel' });
  const allowed = useMemo(() => {
    const paths = new Set(groups.flatMap(g => g.items.map(i => i.path.split('?')[0])));
    return GO_TARGETS.filter(t => t.path === '/' || paths.has(t.path));
  }, [groups]);
  return (
    <>
      {allowed.map(t => (
        <GoHotkey key={t.keys} {...t} />
      ))}
      <ShortcutsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const list = useHotkeyList();
  const extra = [
    { keys: '/', description: 'Listedeki arama kutusuna git', group: 'Sayfa' },
    { keys: 'mod+s', description: 'Açık formu kaydet', group: 'Sayfa' },
    { keys: 'escape', description: 'Paneli veya pencereyi kapat', group: 'Genel' },
  ];
  const all = [...list, ...extra.filter(e => !list.some(l => l.keys === e.keys))];
  const groups = ['Genel', 'Gezinme', 'Sayfa'].map(name => ({ name, items: all.filter(i => i.group === name) })).filter(g => g.items.length);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Klavye kısayolları"
      description="Yazı alanındayken (Ctrl/⌘ ile başlayanlar hariç) kısayollar çalışmaz. “g” ile başlayanlar için önce G, ardından harfe basın."
    >
      <div className="grid gap-5 sm:grid-cols-2">
        {groups.map(g => (
          <section key={g.name} className="min-w-0">
            <h3 className="micro mb-2">{g.name}</h3>
            <ul className="divide-y divide-border rounded-xl border border-border">
              {g.items.map(item => (
                <li key={item.keys} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0">{item.description}</span>
                  <Kbd keys={item.keys} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}
