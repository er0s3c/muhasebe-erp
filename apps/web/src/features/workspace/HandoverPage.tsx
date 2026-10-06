import { Printer, Paperclip } from 'lucide-react';
import { StatusBadge } from './WorkspaceUi';
import { formatDateTR } from '../../lib/format';
import { Link, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { useCQuery } from '../../lib/queries';
import { PageHeader, Card } from '../../components/ui/Card';
import { PageLoading, Callout } from '../../components/ui/Feedback';
import { Button } from '../../components/ui/Button';
type Handover = {
  company: string;
  asOf: string;
  unit: { id: string; block: string; unitNo: string; projectCode: string; projectName: string };
  defects: {
    id: string;
    title: string;
    status: string;
    dueDate: string;
    location: string;
    resolution: string;
    ownerName: string;
    contractorName: string | null;
    documentCount: number;
  }[];
  truncated: boolean;
};
export function HandoverPage() {
  const [params] = useSearchParams();
  const id = z.uuid().safeParse(params.get('unit'));
  const query = useCQuery<Handover>(
    ['handover', params.get('unit')],
    id.success ? `/api/workspace/handover/${id.data}` : null,
  );
  if (!id.success) return <Callout>Önce teslim ve kusur takibinden birim seçin.</Callout>;
  if (query.error) return <Callout tone="danger">{query.error.message}</Callout>;
  if (!query.data) return <PageLoading />;
  const data = query.data;
  return (
    <>
      <PageHeader
        title="Teslim kontrol tutanağı"
        description={`${data.company} · ${data.unit.projectCode} / ${data.unit.projectName}`}
        actions={
          <Button onClick={() => window.print()}>
            <Printer className="size-4" />
            Yazdır / PDF
          </Button>
        }
      />
      <Card className="mb-5 space-y-2 p-5">
        <p>
          Birim: {data.unit.block} {data.unit.unitNo}
        </p>
        <p>Kontrol tarihi: {formatDateTR(data.asOf)}</p>
        <p>
          Açık kusur: {data.defects.filter((d) => d.status === 'open').length} · Tamamlanan:{' '}
          {data.defects.filter((d) => d.status === 'done').length}
        </p>
      </Card>
      {data.truncated && (
        <Callout tone="warning">İlk 1000 kusur gösteriliyor; bu çıktı tam liste değildir.</Callout>
      )}
      <div className="space-y-3">
        {data.defects.map((d, i) => (
          <Card className="break-inside-avoid space-y-2 p-4" key={d.id}>
            <div className="flex flex-wrap justify-between gap-3">
              <h2 className="text-base">
                {i + 1}. {d.title}
              </h2>
              <StatusBadge status={d.status} dueDate={d.dueDate} />
            </div>
            <p className="text-sm">
              Konum: {d.location} · Termin: {formatDateTR(d.dueDate)}
            </p>
            <p className="text-sm">
              Sorumlu: {d.ownerName}
              {d.contractorName ? ` · Taşeron: ${d.contractorName}` : ''}
            </p>
            <p className="whitespace-pre-wrap text-sm">
              Çözüm: {d.resolution || 'Henüz girilmedi.'}
            </p>
            <Link
              className="link inline-flex items-center gap-2 text-sm print:hidden"
              to={`/workspace/documents?kind=defect&id=${d.id}`}
            >
              <Paperclip className="size-4" /> Ekler / fotoğraflar ({d.documentCount})
            </Link>
          </Card>
        ))}
      </div>
      {!data.defects.length && <p>Kayıtlı kusur bulunmuyor.</p>}
      <div className="mt-12 grid grid-cols-2 gap-10">
        <div className="border-t border-border pt-3">
          Teslim eden
          <br />
          Ad soyad / tarih / imza
        </div>
        <div className="border-t border-border pt-3">
          Teslim alan
          <br />
          Ad soyad / tarih / imza
        </div>
      </div>
    </>
  );
}
