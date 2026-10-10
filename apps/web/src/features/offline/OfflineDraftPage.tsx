import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { offlineDraftPayloadSchema, type OfflineDraftReceipt } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Callout } from '../../components/ui/Feedback';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useSession } from '../../lib/session';
import { loadDraftPackage, saveDraftPackage, type DraftPackage, type QueuedDraft } from './draft-store';

export function OfflineDraftPage() {
  const session = useSession();
  const [password, setPassword] = useState(''), [data, setData] = useState<DraftPackage | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<'field_task' | 'stock_count'>('field_task');
  const [date, setDate] = useState(''), [title, setTitle] = useState(''), [description, setDescription] = useState('');
  const [priority, setPriority] = useState<'normal' | 'high'>('normal'), [warehouseId, setWarehouseId] = useState('');
  const [lines, setLines] = useState([{ itemId: '', countedQty: '' }]);
  useEffect(() => {
    const lock = () => { setData(null); setPassword(''); };
    window.addEventListener('erp-session-cleared', lock);
    return () => window.removeEventListener('erp-session-cleared', lock);
  }, []);
  const unlock = async () => {
    setBusy(true); setError(null);
    try {
      const value = await loadDraftPackage(password);
      if (!value) throw new Error('Hazırlanmış paket bulunamadı. İnternet varken şirketinizin çevrimdışı depo ve saha ekranından paketi indirin.');
      if (session.user && session.user.id !== value.userId) throw new Error('Bu paket başka bir kullanıcıya ait. Paketi hazırlayan kullanıcıyla giriş yapın.');
      setData(value); setKind(value.kinds[0] ?? 'field_task'); setWarehouseId(value.warehouses[0]?.id ?? '');
      setDate(new Intl.DateTimeFormat('en-CA', { timeZone: value.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  };
  const persist = async (value: DraftPackage) => { const saved = await saveDraftPackage(value, password); setData(saved); return saved; };
  const add = async () => {
    if (!data) return;
    setBusy(true); setError(null);
    try {
      if (data.expiresAt <= Date.now()) throw new Error('Paketin süresi doldu. İnternet varken paketi yenileyin; mevcut taslaklarınız korunur.');
      if (!data.kinds.includes(kind)) throw new Error('Bu taslak türü pakette yok.');
      if (kind === 'stock_count' && new Set(lines.map(line => line.itemId)).size !== lines.length) throw new Error('Aynı stok kartını iki kez eklemeyin.');
      const parsed = offlineDraftPayloadSchema.safeParse(kind === 'stock_count'
        ? { kind, date, warehouseId, description, lines }
        : { kind, date, title, description, priority });
      if (!parsed.success) throw new Error('Tarih, zorunlu alanlar ve miktarları kontrol edin. Saha başlığı en az 2 karakter olmalı; sayım miktarı sıfır veya pozitif olmalı.');
      const entry: QueuedDraft = { clientId: crypto.randomUUID(), branchSelection: data.branchSelection, draft: parsed.data, createdAt: new Date().toISOString() };
      await persist({ ...data, queue: [...data.queue, entry] });
      setTitle(''); setDescription(''); setLines([{ itemId: '', countedQty: '' }]);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  };
  const sync = async () => {
    if (!data) return;
    setBusy(true); setError(null);
    let current = data;
    try {
      if (session.status !== 'authenticated' || session.user?.id !== data.userId || !session.companies.some(company => company.id === data.companyId)) throw new Error('Eşitlemek için paketi hazırlayan kullanıcıyla giriş yapın ve şirkete erişiminizi kontrol edin.');
      for (const entry of current.queue.filter(row => !row.receipt)) {
        let receipt: OfflineDraftReceipt | undefined, failure: string | undefined;
        try { receipt = await api<OfflineDraftReceipt>('/api/offline-drafts/sync', { method: 'POST', companyId: current.companyId, branchId: entry.branchSelection, body: { clientId: entry.clientId, draft: entry.draft } }); }
        catch (cause) { failure = errorMessage(cause); }
        current = await persist({ ...current, queue: current.queue.map(row => row.clientId === entry.clientId ? { ...row, receipt, error: failure } : row) });
      }
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  };
  const remove = async (clientId: string) => {
    if (!data) return;
    setBusy(true); setError(null);
    try { await persist({ ...data, queue: data.queue.filter(row => row.clientId !== clientId) }); }
    catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  };
  const pending = data?.queue.filter(row => !row.receipt).length ?? 0;
  return <main className="min-h-svh bg-bg px-4 py-6 text-text sm:px-8"><div className="mx-auto max-w-4xl space-y-5">
    <PageHeader title="Çevrimdışı taslaklar" description={data ? data.companyName : 'Bu cihazda hazırlanan şifreli depo ve saha paketini açın.'} actions={<Link className="text-sm underline" to="/workspace/offline">Paket hazırlama</Link>} />
    {error && <Callout tone="danger">{error}</Callout>}
    {!data ? <Card className="max-w-md space-y-4 p-5"><Field label="Cihaz kodu">{id => <Input id={id} type="password" autoComplete="current-password" maxLength={128} value={password} onChange={event => setPassword(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && password.length >= 8 && !busy) void unlock(); }} />}</Field><Button loading={busy} disabled={password.length < 8} onClick={() => void unlock()}>Paketi aç</Button><p className="text-xs text-muted">Kod yalnız bu ekranda bellekte tutulur. İşiniz bittiğinde ekranı kilitleyin.</p></Card> : <>
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted">{pending} taslak eşitleme bekliyor · {data.branchSelection === 'all' ? 'Tüm erişilebilir şubeler' : data.branchSelection === 'unassigned' ? 'Şubeye atanmamış' : 'Seçilen şube'}</p><Button size="sm" disabled={busy} onClick={() => { setData(null); setPassword(''); }}>Ekranı kilitle</Button></div>
      {data.expiresAt <= Date.now() && <Callout tone="warning">Paketin süresi doldu. Yeni kayıt için paketi yenileyin. Kuyruktaki taslakları eşitleyebilirsiniz.</Callout>}
      {data.truncated && <Callout tone="warning">Paket ilk 200 depoyu ve 2.000 aktif stok kartını içeriyor. Listede olmayan kayıt için çevrimiçi ekranı kullanın.</Callout>}
      <Card className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2"><Field label="Taslak türü">{id => <Select id={id} value={kind} onChange={event => setKind(event.target.value as typeof kind)}>{data.kinds.map(value => <option key={value} value={value}>{value === 'stock_count' ? 'Depo sayımı' : 'Saha görevi'}</option>)}</Select>}</Field><Field label="Tarih" required>{id => <Input id={id} type="date" value={date} onChange={event => setDate(event.target.value)} />}</Field></div>
        {kind === 'field_task' ? <div className="grid gap-4 sm:grid-cols-2"><Field label="Görev başlığı" required>{id => <Input id={id} value={title} maxLength={200} onChange={event => setTitle(event.target.value)} />}</Field><Field label="Öncelik">{id => <Select id={id} value={priority} onChange={event => setPriority(event.target.value as typeof priority)}><option value="normal">Normal</option><option value="high">Yüksek</option></Select>}</Field></div> : <>
          <Field label="Depo" required>{id => <Select id={id} value={warehouseId} onChange={event => setWarehouseId(event.target.value)}><option value="">Depo seçin</option>{data.warehouses.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</Select>}</Field>
          {lines.map((line, index) => <div key={index} className="grid min-w-0 grid-cols-[minmax(0,1fr)_7rem] items-end gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto]"><Field label={`Stok kartı ${index + 1}`} required>{id => <Select id={id} value={line.itemId} onChange={event => setLines(rows => rows.map((row, i) => i === index ? { ...row, itemId: event.target.value } : row))}><option value="">Stok kartı seçin</option>{data.items.map(row => <option key={row.id} value={row.id}>{row.code} · {row.name} ({row.unit})</option>)}</Select>}</Field><Field label="Sayılan miktar" required>{id => <Input id={id} inputMode="decimal" value={line.countedQty} onChange={event => setLines(rows => rows.map((row, i) => i === index ? { ...row, countedQty: event.target.value.replace(',', '.') } : row))} />}</Field><Button size="sm" disabled={lines.length === 1 || busy} onClick={() => setLines(rows => rows.filter((_, i) => i !== index))}>Satırı kaldır</Button></div>)}
          <Button size="sm" disabled={busy || lines.length >= 2000} onClick={() => setLines(rows => [...rows, { itemId: '', countedQty: '' }])}>Stok kartı ekle</Button>
        </>}
        <Field label="Açıklama (isteğe bağlı)">{id => <Textarea id={id} rows={3} value={description} maxLength={kind === 'stock_count' ? 200 : 4000} onChange={event => setDescription(event.target.value)} />}</Field>
        <Button variant="primary" loading={busy} disabled={data.expiresAt <= Date.now()} onClick={() => void add()}>Cihazda taslak kaydet</Button>
      </Card>
      <Card className="space-y-4 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium">Taslak kuyruğu</h2><Button loading={busy} disabled={!pending || session.status !== 'authenticated'} onClick={() => void sync()}>Bekleyenleri eşitle ({pending})</Button></div>
        {session.status !== 'authenticated' && <p className="text-sm text-muted">Eşitlemek için internet bağlantısı ve oturum gerekli. <Link to="/login" className="underline">Giriş yap</Link></p>}
        {!data.queue.length && <p className="text-sm text-muted">Kaydettiğiniz taslaklar burada görünecek.</p>}
        {data.queue.map(row => <div key={row.clientId} className="space-y-2 border-t border-border pt-4"><div className="flex flex-wrap justify-between gap-3"><p className="min-w-0 break-words text-sm">{row.draft.kind === 'field_task' ? row.draft.title : `Depo sayımı · ${row.draft.lines.length} stok kartı`} <span className="text-muted">· {row.draft.date}</span></p>{row.receipt ? <Link to={row.receipt.resultPath} className="text-sm underline">Sunucudaki taslağı aç</Link> : <span className="text-xs text-muted">Eşitleme bekliyor</span>}</div>{row.error && <Callout tone="danger">{row.error}</Callout>}{!row.receipt && !row.error && <Button size="sm" disabled={busy} onClick={() => void remove(row.clientId)}>Cihazdaki taslağı kaldır</Button>}</div>)}
        <p className="text-xs text-muted">Eşitlenen sayımlar sunucuda taslak kalır. Kesinleştirmeden önce güncel sistem miktarını ve farkları kontrol edin. Aynı taslağın yeniden eşitlenmesi ikinci kayıt oluşturmaz.</p>
      </Card>
    </>}
  </div></main>;
}
