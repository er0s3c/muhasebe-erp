import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Download, FileSpreadsheet, FileText, Printer } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExportFormat } from '@erp/shared';
import { apiBlob } from '../../lib/api';
import { saveBlob } from '../../lib/download';
import { errorMessage } from '../../lib/errors';
import { useCompany } from '../../lib/session';
import { Button } from './Button';
import { useToast } from './Toast';

const menuContent = 'z-50 min-w-60 rounded-xl border border-border bg-surface p-1.5 [animation:pop-in_0.12s_ease-out] print:hidden';
const menuItem = 'flex cursor-pointer select-none items-center gap-2.5 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50';

interface Props {
  /** Sunucudaki dışa aktarma raporu (`/api/exports/<anahtar>`). */
  exportKey?: string;
  /** Kullanıcı düzeyi (şirketsiz) uç: tam yol (örn. `/api/consolidation/groups/<id>/export/consolidated`); verilirse `exportKey` yok sayılır ve şirket başlığı gönderilmez. */
  path?: string;
  /** Rapor sorgusu (ekrandaki süzgeçlerle aynı); boş değerler gönderilmez. */
  params?: Record<string, string | undefined | null>;
  formats?: readonly ExportFormat[];
  /** "Yazdır / PDF olarak kaydet" öğesi (varsayılan açık). */
  print?: boolean;
  disabled?: boolean;
}

/**
 * Dışa aktar menüsü: Excel, CSV ve yazdır/PDF. Dosyalar sunucudan kimlikli istekle inip tarayıcıda kaydedilir;
 * içerik ekrandaki raporla aynı servisten gelir. PDF, tarayıcının yazdır penceresinden "PDF olarak kaydet"tir.
 */
export function ExportMenu({ exportKey, path, params = {}, formats = ['xlsx', 'csv'], print = true, disabled }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const company = useCompany();
  const [busy, setBusy] = useState(false);

  const download = async (format: ExportFormat) => {
    const qs = new URLSearchParams({ format });
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    setBusy(true);
    try {
      const { blob, filename } = await apiBlob(`${path ?? `/api/exports/${exportKey}`}?${qs}`, path ? {} : { companyId: company.id });
      saveBlob(blob, filename ?? `${exportKey ?? 'rapor'}.${format}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild disabled={disabled || busy}>
        <Button className="print:hidden" loading={busy} disabled={disabled}>
          <Download className="size-4" aria-hidden />
          {t('reports.export.button')}
          <ChevronDown className="size-3.5 text-muted" aria-hidden />
        </Button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="end" sideOffset={6} className={menuContent}>
          {formats.includes('xlsx') && (
            <Dropdown.Item className={menuItem} onSelect={() => void download('xlsx')}>
              <FileSpreadsheet className="size-4 text-muted" aria-hidden />
              {t('reports.export.xlsx')}
            </Dropdown.Item>
          )}
          {formats.includes('csv') && (
            <Dropdown.Item className={menuItem} onSelect={() => void download('csv')}>
              <FileText className="size-4 text-muted" aria-hidden />
              {t('reports.export.csv')}
            </Dropdown.Item>
          )}
          {print && (
            <>
              {formats.length > 0 && <Dropdown.Separator className="my-1 h-px bg-border" />}
              <Dropdown.Item className={menuItem} onSelect={() => window.print()}>
                <Printer className="size-4 text-muted" aria-hidden />
                {t('reports.export.print')}
              </Dropdown.Item>
            </>
          )}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
