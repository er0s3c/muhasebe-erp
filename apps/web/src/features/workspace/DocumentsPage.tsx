import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  FileText,
  Files,
  Upload,
  Download,
  Eye,
  FileImage,
  Plus,
  History,
  ArrowUpRight,
} from 'lucide-react';
import { recordRefSchema, type SearchHit, type RecordKind } from '@erp/shared';
import { PageHeader, Card, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Field';
import { Callout, PageLoading, EmptyState } from '../../components/ui/Feedback';
import { Sheet, Modal } from '../../components/ui/Sheet';
import { Badge } from '../../components/ui/Badge';
import { useCQuery, useCMutation } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { apiBlob } from '../../lib/api';
import { saveBlob } from '../../lib/download';
import { RecordPicker } from './RecordPicker';
import { SearchBox } from './WorkspaceUi';
const kindLabels: Record<RecordKind, string> = {
  party: 'Cari',
  invoice: 'Fatura',
  project: 'Proje',
  subcontract: 'Taşeron sözleşmesi',
  sales_contract: 'Satış sözleşmesi',
  employee: 'Personel',
  foreign_worker_doc: 'Yabancı işçi belgesi',
  transaction: 'Kasa / banka',
  site_report: 'Saha raporu',
  defect: 'Kusur',
  rfi: 'Teknik talep',
  site_instruction: 'Saha talimatı',
  quality_check: 'Kalite kontrolü',
  safety: 'İş güvenliği',
};
type Doc = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  previousId: string | null;
  createdAt: string;
  createdBy: string;
  recordKind: RecordKind;
  recordId: string;
  recordLabel: string;
  isLatest: boolean;
};
export function DocumentsPage() {
  const company = useCompany();
  const [params] = useSearchParams();
  return <DocumentsContent key={company.id + ':' + params.toString()} />;
}
function DocumentsContent() {
  const company = useCompany();
  const limits=useCQuery<{documentLimitMb:number}>(['upload-limits'],'/api/workspace/upload-limits');
  const maxMb=limits.data?.documentLimitMb ?? 5;
  const [params] = useSearchParams();
  const initial = recordRefSchema.safeParse({ kind: params.get('kind'), id: params.get('id') });
  const [record, setRecord] = useState<SearchHit | null>(
    initial.success ? { ...initial.data, label: 'Bağlı kayıt', path: '' } : null,
  );
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [latest, setLatest] = useState(false);
  const [offset, setOffset] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previousId, setPreviousId] = useState('');
  const [localError, setLocalError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ name: string; url: string; mime: string } | null>(null);
  const [loadingId, setLoadingId] = useState('');
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  const qs = new URLSearchParams({ q: query, latest: String(latest), offset: String(offset) });
  if (record) {
    qs.set('kind', record.kind);
    qs.set('id', record.id);
  } else if (kind) qs.set('kind', kind);
  const docs = useCQuery<{ items: Doc[]; hasMore: boolean }>(
    ['record-documents', qs.toString()],
    '/api/workspace/documents?' + qs,
  );
  const source = useCQuery<SearchHit & { canWrite: boolean }>(
    ['record-source', record?.kind, record?.id],
    record ? '/api/workspace/record?kind=' + record.kind + '&id=' + record.id : null,
  );
  const upload = useCMutation(
    async (_v: void, call) => {
      if (!file || !record) throw new Error('Kayıt ve dosya seçin.');
      if (file.size > maxMb * 1024 * 1024) throw new Error(`Dosya en fazla ${maxMb} MB olabilir.`);
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]!);
        reader.onerror = () => reject(new Error('Dosya okunamadı.'));
        reader.readAsDataURL(file);
      });
      return call('/api/workspace/documents', {
        method: 'POST',
        body: {
          record: { kind: record.kind, id: record.id },
          filename: file.name,
          mime: file.type,
          base64,
          ...(previousId ? { previousId } : {}),
        },
      });
    },
    [['record-documents']],
  );
  async function download(doc: Doc, view = false) {
    setLoadingId(doc.id);
    setLocalError('');
    try {
      const r = await apiBlob('/api/workspace/documents/' + doc.id + '/download', {
        companyId: company.id,
      });
      if (view)
        setPreview({ name: doc.filename, url: URL.createObjectURL(r.blob), mime: doc.mime });
      else saveBlob(r.blob, doc.filename);
    } catch (e) {
      setLocalError((e as Error).message);
    } finally {
      setLoadingId('');
    }
  }
  function start(id = '') {
    setPreviousId(id);
    setFile(null);
    upload.reset();
    setUploadOpen(true);
  }
  const error = localError || docs.error?.message || source.error?.message;
  return (
    <>
      <PageHeader
        title="Belge arşivi"
        description="Proje, sözleşme ve saha belgelerini kaynağı ve sürüm geçmişiyle birlikte yönetin."
        actions={
          <Button variant="primary" disabled={upload.isPending} onClick={() => start()}>
            <Plus className="size-4" />
            Yeni belge
          </Button>
        }
      />
      {error && <Callout tone="danger">{error}</Callout>}
      <Card className="mb-5">
        <CardHeader
          title={source.data?.label ?? 'Arşiv kapsamı'}
          description={
            record
              ? 'Seçilen kayda bağlı belgeler'
              : 'Erişim yetkiniz olan tüm kayıtların belgeleri'
          }
          action={
            source.data && (
              <Link className="link inline-flex items-center gap-1 text-sm" to={source.data.path}>
                Kaydı aç
                <ArrowUpRight className="size-4" />
              </Link>
            )
          }
        />
        <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <RecordPicker
            value={record}
            onChange={(r) => {
              setRecord(r);
              setPreviousId('');
              setOffset(0);
            }}
          />
          <div className="flex items-center gap-4">
            <Files className="size-8 text-muted" />
            <div>
              <p className="text-base">
                {docs.data ? docs.data.items.length + (docs.data.hasMore ? '+' : '') : '—'} belge
                görüntüleniyor
              </p>
              <p className="mt-1 text-xs text-muted">
                PDF, JPEG ve PNG · dosya başına {maxMb} MB · sürüm geçmişi korunur
              </p>
            </div>
          </div>
        </div>
      </Card>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <SearchBox
          value={query}
          onChange={(v) => {
            setQuery(v);
            setOffset(0);
          }}
          placeholder="Dosya adı ara…"
        />
        {!record && (
          <Select
            aria-label="Belge kayıt türü"
            className="w-auto"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">Tüm kayıt türleri</option>
            {Object.entries(kindLabels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={latest}
            onChange={(e) => {
              setLatest(e.target.checked);
              setOffset(0);
            }}
          />
          Yalnızca son sürümler
        </label>
      </div>
      {docs.isPending ? (
        <PageLoading />
      ) : !docs.data?.items.length ? (
        <Card>
          <EmptyState
            icon={<Files className="size-5" />}
            title="Belge bulunamadı"
            description="Bir kayıt seçip dosya ekleyin veya arama filtrelerini değiştirin."
            action={<Button onClick={() => start()}>Belge ekle</Button>}
          />
        </Card>
      ) : (
        <Card className="divide-y divide-border">
          {docs.data.items.map((doc) => (
            <article key={doc.id} className="flex flex-wrap items-center justify-between gap-4 p-5">
              <div className="flex min-w-0 items-start gap-4">
                <div className="rounded-xl border border-border bg-surface-2 p-3">
                  {doc.mime === 'application/pdf' ? (
                    <FileText className="size-5 text-muted" />
                  ) : (
                    <FileImage className="size-5 text-muted" />
                  )}
                </div>
                <div className="min-w-0">
                  <h2 className="break-all text-base">{doc.filename}</h2>
                  <p className="mt-1 text-xs text-muted">
                    {Math.ceil(doc.size / 1024)} KB · {doc.createdBy} ·{' '}
                    {new Date(doc.createdAt).toLocaleString('tr-TR')}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge>{kindLabels[doc.recordKind]}</Badge>
                    <Badge tone={doc.isLatest ? 'success' : 'neutral'}>
                      {doc.isLatest ? 'Son sürüm' : 'Önceki sürüm'}
                    </Badge>
                    {doc.previousId && <History className="size-3.5 text-muted" />}
                    {!record && (
                      <button
                        className="link text-xs"
                        onClick={() => {
                          setRecord({
                            id: doc.recordId,
                            kind: doc.recordKind,
                            label: 'Bağlı kayıt',
                            path: '',
                          });
                          setOffset(0);
                        }}
                      >
                        {doc.recordLabel ?? 'Bağlı kayıt'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!loadingId}
                  onClick={() => void download(doc, true)}
                >
                  <Eye className="size-4" />
                  Önizle
                </Button>
                <Button size="sm" disabled={!!loadingId} onClick={() => void download(doc)}>
                  <Download className="size-4" />
                  İndir
                </Button>
                {source.data?.canWrite && doc.isLatest && (
                  <Button size="sm" disabled={upload.isPending} onClick={() => start(doc.id)}>
                    Yeni sürüm
                  </Button>
                )}
              </div>
            </article>
          ))}
        </Card>
      )}
      {(offset > 0 || docs.data?.hasMore) && (
        <div className="mt-4 flex justify-between">
          <Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 200))}>
            Önceki
          </Button>
          <Button disabled={!docs.data?.hasMore} onClick={() => setOffset(offset + 200)}>
            Sonraki
          </Button>
        </div>
      )}
      <Sheet
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        title={previousId ? 'Yeni belge sürümü' : 'Belge ekle'}
        description="Dosyayı ilgili kayda bağlayın. Önceki sürümler korunur."
        footer={
          <>
            <Button onClick={() => setUploadOpen(false)}>Vazgeç</Button>
            <Button
              variant="primary"
              type="submit"
              form="document-form"
              loading={upload.isPending}
              disabled={!file || !source.data?.canWrite}
            >
              Belge yükle
            </Button>
          </>
        }
      >
        <form
          id="document-form"
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            upload.mutate(undefined, {
              onSuccess: () => {
                setPreviousId('');
                setFile(null);
                setUploadOpen(false);
              },
            });
          }}
        >
          {upload.error && <Callout tone="danger">{upload.error.message}</Callout>}
          <RecordPicker
            value={record}
            onChange={(r) => {
              setRecord(r);
              setPreviousId('');
              setOffset(0);
            }}
          />
          {source.data && <p className="text-sm">{source.data.label}</p>}
          {record && source.data && !source.data.canWrite && (
            <Callout>Bu kayıtta belge yükleme yetkiniz yok.</Callout>
          )}
          <div className="rounded-xl border border-dashed border-border-strong bg-surface-2 p-6 text-center">
            <Upload className="mx-auto mb-3 size-7 text-muted" />
            <p className="text-sm">PDF veya görsel dosyanızı seçin</p>
            <p className="mt-1 text-xs text-muted">En fazla {maxMb} MB</p>
            <label className="mt-4 block text-sm">
              <span className="sr-only">PDF, JPEG veya PNG</span>
              <input
                ref={fileRef}
                className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border-strong file:bg-surface file:px-3 file:py-2 file:text-text"
                type="file"
                accept="application/pdf,image/jpeg,image/png"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            {file && (
              <p className="mt-3 break-all text-xs">
                {file.name} · {Math.ceil(file.size / 1024)} KB
              </p>
            )}
          </div>
          {previousId && <Callout>Seçilen belgenin yeni sürümü yüklenecek.</Callout>}
        </form>
      </Sheet>
      <Modal
        open={!!preview}
        onOpenChange={(v) => {
          if (!v) setPreview(null);
        }}
        title={preview?.name ?? 'Belge önizlemesi'}
        footer={<Button onClick={() => setPreview(null)}>Kapat</Button>}
      >
        {preview?.mime.startsWith('image/') ? (
          <img
            src={preview.url}
            alt={preview.name}
            className="max-h-[60vh] w-full object-contain"
          />
        ) : (
          preview && (
            <>
              <iframe
                title="PDF önizlemesi"
                sandbox=""
                src={preview.url}
                className="h-[60vh] w-full"
              />
              <p className="mt-2 text-xs text-muted">
                Tarayıcı PDF önizlemesini desteklemiyorsa dosyayı indirin.
              </p>
            </>
          )
        )}
      </Modal>
    </>
  );
}
