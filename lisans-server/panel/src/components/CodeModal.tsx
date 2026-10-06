import { useState } from 'react';
import { Button } from '@ui/Button';
import { Callout } from '@ui/Feedback';
import { Modal } from '@ui/Sheet';

/** Etkinleştirme kodu yalnızca bir kez gösterilir (sunucuda yalnızca özeti saklanır); kapatılmadan önce kopyalanmalıdır. */
export function CodeModal({ code, onClose }: { code: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      /* pano izni yok: kod seçilip elle kopyalanır */
    }
  };
  return (
    <Modal
      open={code !== null}
      onOpenChange={(o) => {
        if (!o) {
          setCopied(false);
          onClose();
        }
      }}
      title="Etkinleştirme kodu"
      description="Bu kodu müşteriye güvenli bir kanaldan iletin."
      footer={
        <>
          <Button onClick={copy}>{copied ? 'Kopyalandı' : 'Kopyala'}</Button>
          <Button variant="primary" onClick={onClose}>
            Kodu kaydettim, kapat
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div data-testid="activation-code" className="select-all rounded-lg border border-border-strong bg-surface-2 px-4 py-3 text-center font-mono text-lg tracking-wider">
          {code}
        </div>
        <Callout tone="warning">Kod yalnızca şimdi gösterilir; sunucuda yalnızca özeti saklanır. Kaybolursa “Yeni kod üret” ile yenilenir (eski kod geçersiz olur).</Callout>
      </div>
    </Modal>
  );
}
