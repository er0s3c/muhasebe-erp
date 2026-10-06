import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CloudOff, LockKeyhole, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Callout } from '../../components/ui/Feedback';
import { DrawingCanvas } from './DrawingCanvas';
import {
  clearFieldPackage,
  fileBase64,
  fromBase64,
  loadFieldPackage,
  saveFieldPackage,
  type FieldPackage,
  type FieldSubmission,
} from './offline';

export function OfflineFieldPage() {
  const session = useSession();
  const [password, setPassword] = useState(''),
    [data, setData] = useState<FieldPackage | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<'rfi' | 'site_report'>('rfi'),
    [page, setPage] = useState(1),
    [title, setTitle] = useState(''),
    [question, setQuestion] = useState(''),
    [due, setDue] = useState(new Date().toISOString().slice(0, 10)),
    [locationId, setLocationId] = useState(''),
    [point, setPoint] = useState<{ x: number; y: number } | null>(null),
    [photo, setPhoto] = useState<File | null>(null);
  const bytes = useMemo(
    () => (data?.drawingBase64 ? fromBase64(data.drawingBase64) : null),
    [data?.drawingBase64],
  );
  useEffect(() => {
    const lock = () => {
      setData(null);
      setPassword('');
    };
    window.addEventListener('field-package-cleared', lock);
    return () => window.removeEventListener('field-package-cleared', lock);
  }, []);
  async function unlock() {
    setBusy(true);
    setError('');
    try {
      const loaded = await loadFieldPackage(password, Boolean(session.user));
      if (
        session.user &&
        (session.user?.id !== loaded.userId || session.activeCompany?.id !== loaded.companyId)
      )
        throw new Error(
          'Saha paketi farklı kullanıcı veya şirkete ait; indiren kullanıcı ve şirketle giriş yapın.',
        );
      setData(loaded);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function persist(next: FieldPackage) {
    await saveFieldPackage(next, password);
    setData(next);
  }
  async function enqueue() {
    if (!data) return;
    setBusy(true);
    setError('');
    try {
      if (title.trim().length < 2 || question.trim().length < 2)
        throw new Error('Başlık ve açıklama en az iki karakter olmalı.');
      if (
        photo &&
        (photo.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg'].includes(photo.type))
      )
        throw new Error('Fotoğraf PNG/JPEG ve en fazla 5 MB olmalı.');
      if (photo && !locationId) throw new Error('Fotoğraf için konum seçin.');
      if (Date.now() > data.expiresAt) throw new Error('Saha paketi süresi doldu.');
      const entry: FieldSubmission = {
        id: crypto.randomUUID(),
        title: title.trim(),
        question: question.trim(),
        kind,
        date: new Date().toISOString().slice(0, 10),
        dueDate: due,
        page,
        point,
        locationId: locationId || null,
        photo: photo
          ? { filename: photo.name, mime: photo.type, base64: await fileBase64(photo) }
          : null,
      };
      await persist({ ...data, queue: [...data.queue, entry] });
      setTitle('');
      setQuestion('');
      setPoint(null);
      setPhoto(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function sync() {
    if (!data) return;
    if (session.user?.id !== data.userId || session.activeCompany?.id !== data.companyId) {
      setError('Eşitlemek için paketi indiren kullanıcı ve şirketle çevrimiçi oturum açın.');
      return;
    }
    setBusy(true);
    setError('');
    let next = data;
    try {
      for (const entry of data.queue) {
        try {
          const body = {
            id: entry.id,
            projectId: data.projectId,
            ownerId: data.userId,
            kind: entry.kind,
            title: entry.title,
            eventDate: entry.date,
            dueDate: entry.dueDate,
            payload:
              entry.kind === 'rfi'
                ? { discipline: 'other', question: entry.question }
                : { workers: 0, workDone: entry.question, issues: '' },
          };
          const result = await api<{ item: { id: string } }>('/api/workspace/operations', {
            companyId: data.companyId,
            method: 'POST',
            body,
          });
          if (entry.point && data.drawing)
            await api('/api/construction/pins', {
              companyId: data.companyId,
              method: 'POST',
              body: {
                drawingId: data.drawing.id,
                page: entry.page ?? 1,
                ...entry.point,
                locationId: entry.locationId,
                recordKind: entry.kind,
                recordId: result.item.id,
                label: entry.title,
                clientId: entry.id,
              },
            });
          if (entry.photo) {
            const f = await api<{ item: { id: string } }>('/api/construction/assets', {
              companyId: data.companyId,
              method: 'POST',
              body: { projectId: data.projectId, ...entry.photo },
            });
            await api('/api/construction/photos', {
              companyId: data.companyId,
              method: 'POST',
              body: {
                projectId: data.projectId,
                clientId: entry.id,
                assetId: f.item.id,
                locationId: entry.locationId,
                date: entry.date,
                caption: entry.title,
                operationId: result.item.id,
              },
            });
          }
          next = { ...next, queue: next.queue.filter((q) => q.id !== entry.id) };
          await persist(next);
        } catch (e) {
          if (e instanceof ApiError && [401, 403].includes(e.status)) {
            await clearFieldPackage();
            setData(null);
            throw new Error('Erişim değişti; yerel saha paketi kilitlendi ve temizlendi.', {
              cause: e,
            });
          }
          next = {
            ...next,
            queue: next.queue.map((q) =>
              q.id === entry.id ? { ...q, error: (e as Error).message } : q,
            ),
          };
          await persist(next);
          throw e;
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto min-h-screen max-w-5xl space-y-5 bg-background p-4 md:p-8">
      <PageHeader
        title="Çevrimdışı şantiye"
        description={data ? data.projectName : 'İndirdiğiniz saha paketini cihaz koduyla açın.'}
        actions={
          <Link to="/workspace/construction" className="text-sm underline">
            Çevrimiçi çalışma alanı
          </Link>
        }
      />
      {error && <Callout tone="danger">{error}</Callout>}
      {!data ? (
        <Card className="max-w-md p-6">
          <LockKeyhole className="mb-4 size-6 text-muted" />
          <Field label="Cihaz kodu">
            {(id) => (
              <Input
                id={id}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
              />
            )}
          </Field>
          <Button variant="primary" className="mt-4" onClick={() => void unlock()} disabled={busy}>
            Saha paketini aç
          </Button>
        </Card>
      ) : (
        <>
          <Callout title="Cihazda saklanan proje paketi">
            24 saat geçerlidir. Oturum kapatma veya şirket değiştirme yerel paketi temizler.
            Kayıtlar eşitlenene kadar bekleyen işler listesinde kalır.
          </Callout>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void sync()} disabled={busy}>
              <RefreshCw className="size-4" />
              Bekleyenleri eşitle ({data.queue.length})
            </Button>
            <Button
              onClick={() => {
                setData(null);
                setPassword('');
              }}
            >
              Paketi kilitle
            </Button>
            {session.status !== 'authenticated' && (
              <Link to="/login" className="text-sm underline">
                Eşitlemek için giriş yap
              </Link>
            )}
          </div>
          <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
            <Card className="p-4">
              {bytes && (
                <Field label="Çizim sayfası">
                  {(id) => (
                    <Input
                      id={id}
                      type="number"
                      min={1}
                      max={1000}
                      value={page}
                      onChange={(e) => {
                        setPage(Math.max(1, Math.min(1000, Number(e.target.value) || 1)));
                        setPoint(null);
                      }}
                    />
                  )}
                </Field>
              )}
              {bytes ? (
                <DrawingCanvas
                  data={bytes}
                  page={page}
                  pins={data.pins.filter((p) => p.page === page)}
                  points={point ? [point] : []}
                  onPoint={setPoint}
                />
              ) : (
                <p className="text-muted">Bu pakette çizim yok; saha raporu girebilirsiniz.</p>
              )}
            </Card>
            <Card className="space-y-4 p-5">
              <CardHeader title="Yeni saha kaydı" />
              <Field label="Kayıt türü">
                {(id) => (
                  <Select
                    id={id}
                    value={kind}
                    onChange={(e) => setKind(e.target.value as 'rfi' | 'site_report')}
                  >
                    <option value="rfi">Teknik bilgi talebi</option>
                    <option value="site_report">Günlük saha raporu</option>
                  </Select>
                )}
              </Field>
              <Field label="Başlık">
                {(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} />}
              </Field>
              <Field label="Açıklama / yapılan işler">
                {(id) => (
                  <Textarea
                    id={id}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Termin">
                {(id) => (
                  <Input id={id} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
                )}
              </Field>
              <Field label="Konum">
                {(id) => (
                  <Select
                    id={id}
                    value={locationId}
                    onChange={(e) => setLocationId(e.target.value)}
                  >
                    <option value="">Konum seçin</option>
                    {data.locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Fotoğraf">
                {(id) => (
                  <input
                    id={id}
                    aria-label="Fotoğraf"
                    type="file"
                    accept="image/jpeg,image/png"
                    onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
                  />
                )}
              </Field>
              {point && (
                <p className="text-xs text-muted">
                  Plan konumu: %{Math.round(point.x * 100)}, %{Math.round(point.y * 100)}
                </p>
              )}
              <Button variant="primary" onClick={() => void enqueue()} disabled={busy}>
                <CloudOff className="size-4" />
                Cihazda kaydet
              </Button>
            </Card>
          </div>
          <Card>
            <CardHeader title="Bekleyen işler" />
            {data.queue.length === 0 ? (
              <p className="p-5 text-sm text-muted">Bekleyen kayıt yok.</p>
            ) : (
              data.queue.map((q) => (
                <div key={q.id} className="border-t border-border p-4">
                  <p>{q.title}</p>
                  <p className="mt-1 text-xs text-muted">
                    {q.kind === 'rfi' ? 'Teknik bilgi talebi' : 'Saha raporu'} · {q.dueDate}
                  </p>
                  {q.error && <p className="mt-2 text-sm text-danger">{q.error}</p>}
                  {q.error && q.point && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void persist({
                          ...data,
                          queue: data.queue.map((item) =>
                            item.id === q.id ? { ...item, point: null, error: undefined } : item,
                          ),
                        })
                      }
                    >
                      Eski plan işaretini kaldırıp kaydı yeniden eşitle
                    </Button>
                  )}
                </div>
              ))
            )}
          </Card>
        </>
      )}
    </main>
  );
}
