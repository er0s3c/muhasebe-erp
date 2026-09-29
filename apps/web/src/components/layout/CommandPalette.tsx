import * as Dialog from '@radix-ui/react-dialog';
import { CornerDownLeft, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { useNavigation } from '../../lib/queries';
import { navIcon } from './icons';

interface Command {
  id: string;
  label: string;
  group: string;
  path: string;
  icon: string;
  keywords?: string;
}

const norm = (s: string) => s.toLocaleLowerCase('tr-TR');

/** Ctrl/⌘+K ile açılan komut paleti: sayfalara ve hızlı işlemlere klavyeyle ulaşım. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: nav } = useNavigation();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    const modules = nav?.modules ?? [];
    const can = (p: string) => nav?.permissions.includes(p) ?? false;
    if (modules.includes('core.ledger') && can('ledger.post')) {
      list.push({ id: 'new-journal', label: t('shell.newJournal'), group: t('shell.quickActions'), path: '/accounting/journal?new=1', icon: 'book-open', keywords: 'yeni fiş kayıt ekle' });
    }
    if (modules.includes('core.settings') && can('rates.manage')) {
      list.push({ id: 'enter-rates', label: t('shell.enterRates'), group: t('shell.quickActions'), path: '/settings/currencies', icon: 'coins', keywords: 'döviz kur dolar euro sterlin' });
    }
    for (const g of nav?.groups ?? []) {
      for (const item of g.items) {
        list.push({ id: item.key, label: t(item.labelKey as never), group: t('shell.pages'), path: item.path, icon: item.icon });
      }
    }
    return list;
  }, [nav, t]);

  const results = useMemo(() => {
    const q = norm(query.trim());
    return q ? commands.filter((c) => norm(`${c.label} ${c.keywords ?? ''}`).includes(q)) : commands;
  }, [commands, query]);

  useEffect(() => setActive(0), [query, open]);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const run = (c: Command) => {
    onOpenChange(false);
    navigate(c.path);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-inverted/50 backdrop-blur-[8px] [animation:fade-in_0.15s_ease-out]" />
        <Dialog.Content className="fixed left-1/2 top-[15vh] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface [animation:pop-in_0.15s_ease-out]">
          <Dialog.Title className="sr-only">{t('shell.commandPalette')}</Dialog.Title>
          <Dialog.Description className="sr-only">{t('shell.typeToSearch')}</Dialog.Description>
          <div className="flex items-center gap-3 border-b border-border px-4">
            <Search className="size-4 text-muted" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, results.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === 'Enter' && results[active]) {
                  e.preventDefault();
                  run(results[active]);
                }
              }}
              placeholder={t('shell.typeToSearch')}
              className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
              aria-label={t('shell.typeToSearch')}
            />
            <kbd className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted">Esc</kbd>
          </div>
          <ul role="listbox" className="max-h-80 overflow-y-auto p-2">
            {results.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">{t('common.noResults')}</li>}
            {results.map((c, i) => {
              const Icon = navIcon(c.icon);
              const showGroup = i === 0 || results[i - 1]!.group !== c.group;
              return (
                <li key={c.id} role="presentation">
                  {showGroup && <p className="micro px-3 pb-1 pt-2">{c.group}</p>}
                  <button
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => run(c)}
                    className={cn('flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm', i === active && 'bg-surface-2')}
                  >
                    <Icon className="size-4 text-muted" aria-hidden />
                    <span className="flex-1">{c.label}</span>
                    {i === active && <CornerDownLeft className="size-3.5 text-muted" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
