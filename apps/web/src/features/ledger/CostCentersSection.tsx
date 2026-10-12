import { useState } from 'react';
import { ErrorCallout } from '../../components/layout/Blocked';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';

interface CostCenter { id: string; code: string; name: string; isActive: boolean }

/**
 * Departman / maliyet merkezi tanımları (öneri 11). Fatura ve yevmiye satırlarında isteğe bağlı seçilir; boş satır
 * "bilinmiyor" sayılır. Merkez silinmez, pasifleştirilir.
 */
export function CostCentersSection() {
  const can = useCan();
  const toast = useToast();
  const query = useCQuery<{ costCenters: CostCenter[] }>(['cost-centers'], '/api/cost-centers');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const create = useCMutation((_: void, call) => call('/api/cost-centers', { method: 'POST', body: { code, name } }), [['cost-centers']]);
  const toggle = useCMutation((cc: CostCenter, call) => call(`/api/cost-centers/${cc.id}`, { method: 'PATCH', body: { isActive: !cc.isActive } }), [['cost-centers']]);
  const manage = can('settings.manage');
  const rows = query.data?.costCenters ?? [];
  return (
    <Card className="mt-6 p-5">
      <section aria-label="Maliyet merkezleri" className="flex flex-col gap-3">
        <div>
          <h2 className="text-base font-semibold">Departman / maliyet merkezleri</h2>
          <p className="text-xs text-muted">Gelir ve gider satırlarında isteğe bağlı seçilir. Seçilmeyen ve geçmiş kayıtlar "belirtilmedi" kalır; tahmin edilmez.</p>
        </div>
        {(query.error || error) ? <ErrorCallout error={query.error ?? error} /> : null}
        {rows.length === 0 ? <p className="text-sm text-muted">Tanımlı maliyet merkezi yok.</p> : (
          <ul className="flex flex-col divide-y divide-border">
            {rows.map((cc) => (
              <li key={cc.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span><span className="font-mono">{cc.code}</span> · {cc.name} {!cc.isActive && <Badge tone="neutral">Pasif</Badge>}</span>
                {manage && <Button size="sm" variant="ghost" loading={toggle.isPending && toggle.variables?.id === cc.id} onClick={() => toggle.mutate(cc, { onError: (e) => toast.error(errorMessage(e)) })}>{cc.isActive ? 'Pasifleştir' : 'Etkinleştir'}</Button>}
              </li>
            ))}
          </ul>
        )}
        {manage && (
          <form className="flex flex-wrap items-end gap-2" data-form-guard="off" onSubmit={(e) => {
            e.preventDefault(); setError(null);
            create.mutate(undefined, { onSuccess: () => { setCode(''); setName(''); toast.success('Maliyet merkezi eklendi'); }, onError: setError });
          }}>
            <Input aria-label="Kod" placeholder="Kod (ör. SAT)" className="w-32" maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} />
            <Input aria-label="Ad" placeholder="Ad (ör. Satış)" className="w-56" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" loading={create.isPending} disabled={!code.trim() || name.trim().length < 2}>Ekle</Button>
          </form>
        )}
      </section>
    </Card>
  );
}
