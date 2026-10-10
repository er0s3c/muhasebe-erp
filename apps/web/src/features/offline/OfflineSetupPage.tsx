import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { OfflineDraftBootstrap } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { PageHeader, Card } from '../../components/ui/Card';
import { Field, Input } from '../../components/ui/Field';
import { Callout } from '../../components/ui/Feedback';
import { errorMessage } from '../../lib/errors';
import { useCompanyApi } from '../../lib/queries';
import { loadDraftPackage, prepareDraftShell, saveDraftPackage } from './draft-store';

export function OfflineSetupPage() {
  const { company, call } = useCompanyApi();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prepare = async () => {
    setBusy(true); setError(null); setSuccess(false);
    try {
      const bootstrap = await call<OfflineDraftBootstrap>('/api/offline-drafts/bootstrap');
      if (!bootstrap.kinds.length) throw new Error('Çevrimdışı taslak oluşturma yetkiniz yok.');
      const previous = await loadDraftPackage(password);
      if (previous && (previous.companyId !== bootstrap.companyId || previous.userId !== bootstrap.userId)) throw new Error('Bu cihazda başka kullanıcıya veya şirkete ait paket var. Önce o paketteki taslakları eşitleyin.');
      await prepareDraftShell();
      await saveDraftPackage({ ...bootstrap, expiresAt: Date.now() + 24 * 60 * 60 * 1000, queue: previous?.queue ?? [], revision: previous?.revision }, password);
      setSuccess(true);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <>
    <PageHeader title="Çevrimdışı depo ve saha" description="İnternet yokken sayım taslağı veya saha görevi hazırlayın; bağlantı gelince kontrol ederek eşitleyin." />
    <Card className="max-w-xl space-y-5 p-5">
      <p className="text-sm">{company.name} için erişebildiğiniz depo ve stok kartları 24 saatlik şifreli cihaz paketine alınır. Mevcut taslaklar paket yenilenirken korunur.</p>
      {error && <Callout tone="danger">{error}</Callout>}
      {success && <Callout tone="info">Paket hazır. Çevrimdışı taslaklar ekranını bu cihazda internet olmadan da açabilirsiniz.</Callout>}
      <Field label="Cihaz kodu" hint="En az 8 karakter. Mevcut paketi yenilerken aynı kodu kullanın; kod cihazda saklanmaz.">{id => <Input id={id} type="password" autoComplete="new-password" value={password} minLength={8} maxLength={128} onChange={event => setPassword(event.target.value)} />}</Field>
      <div className="flex flex-wrap gap-3"><Button variant="primary" loading={busy} disabled={password.length < 8} onClick={() => void prepare()}>Paketi indir / yenile</Button><Link to="/offline-drafts" className="inline-flex items-center rounded-md border border-text px-4 py-2 text-sm">Çevrimdışı taslakları aç</Link></div>
      <p className="text-xs text-muted">Eşitleme sayımın taslağını oluşturur. Stok hareketi ve mali kayıt, sayımı sunucuda ayrıca kesinleştirdiğinizde oluşur. Güncel yetki, depo, stok kartı ve açık dönem tekrar kontrol edilir.</p>
    </Card>
  </>;
}
