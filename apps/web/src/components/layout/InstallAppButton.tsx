import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallAppButton() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const ready = (event: Event) => { event.preventDefault(); setPrompt(event as InstallPrompt); };
    const installed = () => setPrompt(null);
    window.addEventListener('beforeinstallprompt', ready);
    window.addEventListener('appinstalled', installed);
    return () => { window.removeEventListener('beforeinstallprompt', ready); window.removeEventListener('appinstalled', installed); };
  }, []);
  if (!prompt) return null;
  return <button className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50" title="Uygulamayı yükle" aria-label="Uygulamayı yükle" disabled={pending} onClick={() => {
    setPending(true);
    void prompt.prompt().then(() => prompt.userChoice).catch(() => undefined).finally(() => { setPrompt(null); setPending(false); });
  }}><Download className="size-5" aria-hidden /></button>;
}
