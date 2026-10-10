import { Sparkles } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useHotkey } from '../../lib/hotkeys';
import { useSession } from '../../lib/session';
import { useActiveBranch } from '../../lib/branch';

// Sohbet paneli ilk açılışta indirilir: ilk sayfa yükünü büyütmez
const AdaAIChatSheet = lazy(() => import('./AdaAIChatSheet').then(m => ({ default: m.AdaAIChatSheet })));
const preload = () => void import('./AdaAIChatSheet');

export function AdaAIButton() {
  const { activeCompany, user } = useSession();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const branch = useActiveBranch(activeCompany?.id ?? '');
  const toggle = (next: boolean) => {
    if (next) setMounted(true);
    setOpen(next);
  };

  // Kısayol: Ctrl+J veya Cmd+J ile Ada AI'yı aç (yazı alanındayken de çalışır)
  useHotkey('mod+j', () => toggle(!open), { description: 'Ada AI asistanını aç/kapat', group: 'Genel', allowInInputs: true, enabled: !!activeCompany && !!user });

  if (!activeCompany || !user) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => toggle(true)}
        onPointerEnter={preload}
        onFocus={preload}
        className="group relative flex items-center gap-1.5 rounded-lg border border-border/80 bg-surface px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        aria-label="Ada AI Asistanı (Ctrl+J)"
        title="Ada AI Akıllı Asistan (Ctrl+J)"
      >
        <span className="flex size-5 items-center justify-center rounded-md bg-brand text-brand-contrast transition-transform group-hover:scale-105">
          <Sparkles className="size-3.5" aria-hidden />
        </span>
        <span className="hidden md:inline">Ada AI</span>
      </button>

      {mounted && (
        <Suspense fallback={null}>
          <AdaAIChatSheet key={`${activeCompany.id}:${user.id}:${branch}`} open={open} onOpenChange={toggle} />
        </Suspense>
      )}
    </>
  );
}
