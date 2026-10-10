import * as Dialog from '@radix-ui/react-dialog';
import { CornerDownLeft, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { useCQuery, useNavigation } from '../../lib/queries';
import type { SearchHit } from '@erp/shared';
import { navIcon } from './icons';
import { buildDisplayNavigation } from './navigation';

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
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const timer = setTimeout(() => setDebounced(query.trim()), 250); return () => clearTimeout(timer); }, [query]);
  const recordSearch = useCQuery<{ items: SearchHit[] }>(['record-search', debounced], open && debounced.length >= 2 ? `/api/workspace/search?q=${encodeURIComponent(debounced)}` : null);
  const [active, setActive] = useState(0);
  const listId = useId();
  const optionId = (i: number) => `${listId}-o${i}`;

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    const modules = nav?.modules ?? [];
    const can = (p: string) => nav?.permissions.includes(p) ?? false;
    if (modules.includes('core.ledger') && can('ledger.post')) {
      list.push({ id: 'new-journal', label: t('shell.newJournal'), group: t('shell.quickActions'), path: '/accounting/journal?new=1', icon: 'book-open', keywords: 'yeni fiş kayıt ekle' });
    }
    if (modules.includes('core.invoices') && can('invoices.manage')) {
      list.push({ id: 'new-sales-invoice', label: t('shell.newSalesInvoice'), group: t('shell.quickActions'), path: '/invoices/new?type=sales', icon: 'receipt', keywords: 'yeni satış fatura kes' });
      list.push({ id: 'new-purchase-invoice', label: t('shell.newPurchaseInvoice'), group: t('shell.quickActions'), path: '/invoices/new?type=purchase', icon: 'receipt-text', keywords: 'yeni alış fatura gider' });
    }
    if (modules.includes('core.invoices') && can('deliveries.manage')) {
      list.push({ id: 'new-sales-delivery', label: t('shell.newSalesDelivery'), group: t('shell.quickActions'), path: '/delivery-notes/new?type=sales', icon: 'truck', keywords: 'yeni satış irsaliye sevk' });
      list.push({ id: 'new-purchase-delivery', label: t('shell.newPurchaseDelivery'), group: t('shell.quickActions'), path: '/delivery-notes/new?type=purchase', icon: 'package-check', keywords: 'yeni alış irsaliye mal kabul' });
    }
    if (modules.includes('core.treasury') && can('treasury.post')) {
      list.push({ id: 'new-receipt', label: t('shell.newReceipt'), group: t('shell.quickActions'), path: '/treasury/transactions?new=receipt', icon: 'wallet', keywords: 'yeni tahsilat para al kasa banka' });
      list.push({ id: 'new-payment', label: t('shell.newPayment'), group: t('shell.quickActions'), path: '/treasury/transactions?new=payment', icon: 'landmark', keywords: 'yeni ödeme para ver kasa banka' });
    }
    if (modules.includes('construction.projects') && can('projects.manage')) {
      list.push({ id: 'new-project', label: t('shell.newProject'), group: t('shell.quickActions'), path: '/projects?new=1', icon: 'hard-hat', keywords: 'yeni proje şantiye inşaat ekle' });
    }
    if (modules.includes('core.settings') && can('rates.manage')) {
      list.push({ id: 'enter-rates', label: t('shell.enterRates'), group: t('shell.quickActions'), path: '/settings/currencies', icon: 'coins', keywords: 'döviz kur dolar euro sterlin' });
    }
    for (const g of buildDisplayNavigation(nav?.groups)) {
      for (const item of g.items) {
        list.push({ id: item.key, label: item.label ?? t(item.labelKey as never), group: g.label, path: item.path, icon: item.icon });
      }
    }
    return list;
  }, [nav, t]);

  const results = useMemo(() => {
    const q = norm(query.trim());
    const pages = q ? commands.filter((c) => norm(`${c.label} ${c.keywords ?? ''}`).includes(q)) : commands;
    const records: Command[] = debounced === query.trim() && q.length >= 2 ? (recordSearch.data?.items ?? []).map((item) => ({ id: `${item.kind}:${item.id}`, label: item.label, group: 'Kayıtlar', path: item.path, icon: 'search' })) : [];
    return [...pages, ...records];
  }, [commands, query, debounced, recordSearch.data]);

  useEffect(() => setActive(0), [query, open]);
  // Ok tuşlarıyla seçilen öğe görünür kalsın
  useEffect(() => {
    if (open) document.getElementById(`${listId}-o${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open, listId]);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  // Arka arkaya gelen aynı gruptaki sonuçlar tek başlık altında (listbox > group > option)
  const groups = useMemo(() => {
    const out: { name: string; index: number; items: { c: Command; i: number }[] }[] = [];
    results.forEach((c, i) => {
      const last = out[out.length - 1];
      if (last && last.name === c.group) last.items.push({ c, i });
      else out.push({ name: c.group, index: out.length, items: [{ c, i }] });
    });
    return out;
  }, [results]);

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
              role="combobox"
              aria-expanded={results.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={results[active] ? optionId(active) : undefined}
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
            <kbd className="rounded border border-border px-1.5 py-0.5 text-[12px] text-muted">Esc</kbd>
          </div>
          <div id={listId} role="listbox" aria-label={t('shell.commandPalette')} className="max-h-80 overflow-y-auto p-2">
            {recordSearch.isFetching && <p role="status" className="px-3 py-2 text-sm text-muted">Kayıtlar aranıyor…</p>}
            {recordSearch.isError && <p role="alert" className="px-3 py-2 text-sm text-danger">Kayıt araması yüklenemedi.</p>}
            {results.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted">{t('common.noResults')}</p>}
            {groups.map((g) => (
              <div key={g.name} role="group" aria-labelledby={`${listId}-g-${g.index}`}>
                <p id={`${listId}-g-${g.index}`} role="presentation" className="micro px-3 pb-1 pt-2">
                  {g.name}
                </p>
                {g.items.map(({ c, i }) => {
                  const Icon = navIcon(c.icon);
                  return (
                    <div
                      key={c.id}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === active}
                      onMouseEnter={() => setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => run(c)}
                      className={cn('flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left text-sm', i === active && 'bg-surface-2')}
                    >
                      <Icon className="size-4 text-muted" aria-hidden />
                      <span className="flex-1">{c.label}</span>
                      {i === active && <CornerDownLeft className="size-3.5 text-muted" aria-hidden />}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
