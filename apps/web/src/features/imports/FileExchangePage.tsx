import { ArrowDownToLine, ArrowUpFromLine, Search } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { IMPORT_KIND_LABELS, type ImportKind } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { errorMessage } from '../../lib/errors';
import { useCQuery, useNavigation } from '../../lib/queries';
import { ImportWizard } from './ImportWizard';

/** Aktarımın izinleri ve doğrulama akışı mevcut kayıt/rapor ekranlarıyla ortaktır. */
export function FileExchangePage() {
  const { t } = useTranslation();
  const access = useCQuery<{ kinds: ImportKind[] }>(['import-access'], '/api/imports/access', { refetchOnWindowFocus: true });
  const navigation = useNavigation();
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState<ImportKind | null>(null);
  const match = (text: string) => text.toLocaleLowerCase('tr-TR').includes(search.toLocaleLowerCase('tr-TR').trim());
  const reports = (navigation.data?.groups.find(group => group.key === 'reports')?.items ?? [])
    .filter(item => !['file-exchange', 'data-export'].includes(item.key) && match(t(item.labelKey as never)));
  const imports = (access.data?.kinds ?? []).filter(kind => match(IMPORT_KIND_LABELS[kind]));
  return <>
    <PageHeader title="İçe ve dışa aktarma" description="Dosyadan kayıtları alın veya raporlarınızı Excel, CSV ve PDF olarak paylaşın." />
    {access.error && <Callout tone="danger">{errorMessage(access.error)}</Callout>}
    <Field label="Aktarım veya rapor ara" className="mb-5 max-w-md">{id => <div className="relative"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" aria-hidden /><Input id={id} className="pl-9" value={search} onChange={event => setSearch(event.target.value)} placeholder="Cari, stok, mizan…" /></div>}</Field>
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader title="Dosyadan içe aktar" description="Excel veya CSV → sütun eşleme → önizleme → kayıt. Bir hata varsa kayıt yapılmaz." />
        <div className="divide-y divide-border">
          {imports.map(kind => <div key={kind} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div className="min-w-0 flex-1 basis-40"><p className="text-sm">{IMPORT_KIND_LABELS[kind]}</p><p className="mt-1 text-xs text-muted">{t(`imports.descriptions.${kind}`)}</p></div>
            {kind === 'bank_statement' ? <Link to="/treasury/accounts" className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"><ArrowDownToLine className="size-4" aria-hidden />Banka hesabını seç</Link> : <Button onClick={() => setImporting(kind)}><ArrowDownToLine className="size-4" aria-hidden />İçe aktar</Button>}
          </div>)}
          {!imports.length && <p className="p-5 text-sm text-muted">{access.isLoading ? 'Aktarım izinleri yükleniyor…' : 'Bu aramada erişebileceğiniz bir içe aktarma türü yok.'}</p>}
        </div>
      </Card>
      <Card>
        <CardHeader title="Raporu dışa aktar" description="Raporu açın, dönemi ve filtreleri seçin; Dışa aktar menüsünden dosyanızı alın." />
        <div className="divide-y divide-border">
          {reports.map(item => <Link key={item.key} to={item.path} className="flex items-center justify-between gap-3 px-5 py-4 hover:bg-surface-2"><span className="min-w-0 text-sm">{t(item.labelKey as never)}</span><ArrowUpFromLine className="size-4 shrink-0 text-muted" aria-hidden /></Link>)}
          {!reports.length && <p className="p-5 text-sm text-muted">Bu aramada erişebileceğiniz bir rapor yok.</p>}
        </div>
      </Card>
    </div>
    <p className="mt-5 text-xs text-muted">İçe aktarma kayıtları güncel dönem ve yetki kontrollerinden geçer. Dosya indirmeleri denetim izine kaydedilir. Banka ekstresi için önce ilgili hesabı açın.</p>
    {importing && <ImportWizard key={importing} kind={importing} open onOpenChange={open => { if (!open) setImporting(null); }} />}
  </>;
}
