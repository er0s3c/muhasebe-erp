import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSession } from '../../lib/session';
import { AdaAIChatSheet } from './AdaAIChatSheet';
import { useActiveBranch } from '../../lib/branch';

export function AdaAIButton() {
  const { activeCompany, user } = useSession();
  const [open, setOpen] = useState(false);
  const branch = useActiveBranch(activeCompany?.id ?? '');

  // Kısayol: Ctrl+J veya Cmd+J ile Ada AI'yı aç
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (!activeCompany || !user) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative flex items-center gap-1.5 rounded-lg border border-border/80 bg-surface px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-brand hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        aria-label="Ada AI Asistanı (Ctrl+J)"
        title="Ada AI Akıllı Asistan (Ctrl+J)"
      >
        <Sparkles className="size-4 text-brand transition-transform group-hover:scale-110" />
        <span className="hidden md:inline">Ada AI</span>
      </button>

      <AdaAIChatSheet key={`${activeCompany.id}:${user.id}:${branch}`} open={open} onOpenChange={setOpen} />
    </>
  );
}
