import { Barcode } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dec, parseSerialList } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { cn } from '../../lib/cn';

interface Props {
  serials: string[];
  /** Satır miktarı: girilen seri sayısı bununla eşit olmalı. */
  quantity: string;
  onChange: (serials: string[]) => void;
  disabled?: boolean;
  /** Erişilebilirlik etiketi (satır numarası) */
  label: string;
}

/** Seri takipli satır için seri no girişi: yapıştır (satır/virgül/noktalı virgül ayraçlı) ya da CSV/metin dosyası yükle. */
export function SerialEntry({ serials, quantity, onChange, disabled, label }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const need = dec(quantity || '0');
  const ok = need.isInteger() && need.eq(serials.length);

  const parsed = parseSerialList(text);
  const problems = [
    parsed.duplicates.length ? t('serials.entry.duplicates', { list: parsed.duplicates.join(', ') }) : '',
    parsed.tooLong.length ? t('serials.entry.tooLong') : '',
  ].filter(Boolean);

  const openDialog = () => {
    setText(serials.join('\n'));
    setOpen(true);
  };
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    const content = await file.text();
    setText((cur) => (cur.trim() ? `${cur.trim()}\n${content}` : content));
  };

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Barcode className="size-4" aria-hidden />
      <span className={cn(!ok && 'text-warning')} data-testid="serial-count">
        {t('serials.entry.count', { n: serials.length, qty: need.toFixed(0) })}
      </span>
      <Button size="sm" disabled={disabled} onClick={openDialog} aria-label={`${t('serials.entry.button')} ${label}`}>
        {t('serials.entry.button')}
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={t('serials.entry.title')}
        description={t('serials.entry.help')}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={problems.length > 0}
              onClick={() => {
                onChange(parsed.serials);
                setOpen(false);
              }}
            >
              {t('serials.entry.apply', { n: parsed.serials.length })}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {problems.map((p) => (
            <Callout key={p} tone="danger">
              {p}
            </Callout>
          ))}
          <Textarea
            value={text}
            rows={8}
            className="font-mono"
            aria-label={t('serials.entry.title')}
            placeholder={t('serials.entry.placeholder')}
            onChange={(e) => setText(e.target.value)}
          />
          <label className="text-sm text-muted">
            {t('serials.entry.csv')}{' '}
            <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(e) => void readFile(e.target.files?.[0])} />
          </label>
        </div>
      </Modal>
    </span>
  );
}
