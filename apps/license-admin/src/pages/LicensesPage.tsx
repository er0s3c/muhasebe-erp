import { useQuery } from '@tanstack/react-query';
import { Flag } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge } from '@ui/Badge';
import { Button } from '@ui/Button';
import { PageHeader } from '@ui/Card';
import { EmptyState, PageLoading } from '@ui/Feedback';
import { Select } from '@ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '@ui/Table';
import { api, type License } from '../api';
import { CodeModal } from '../components/CodeModal';
import { LicenseFormSheet } from '../components/LicenseFormSheet';
import { KIND_LABELS, SECTOR_LABELS, STATUS_LABELS, STATUS_TONES, fmtDay } from '../format';

export function LicensesPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const customerId = params.get('customerId') ?? '';
  const flaggedOnly = params.get('flagged') === '1';
  const presetNew = params.get('new') ?? undefined;
  const [formOpen, setFormOpen] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  // /licenses?new=<müşteri> (Müşteriler sayfasındaki "Lisans ver") formu ön seçimle açar
  useEffect(() => {
    if (presetNew) setFormOpen(true);
  }, [presetNew]);

  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (customerId) query.set('customerId', customerId);
  const { data, isPending } = useQuery({
    queryKey: ['licenses', status, customerId],
    queryFn: () => api<{ licenses: License[] }>(`/admin/api/licenses${query.size ? `?${query}` : ''}`),
  });

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('new');
    setParams(next, { replace: true });
  };

  const rows = (data?.licenses ?? []).filter((l) => !flaggedOnly || l.flagged);

  return (
    <>
      <PageHeader
        title="Lisanslar"
        description="Verdiğiniz lisanslar, sektör ve kota ayarları, etkinleştirme durumu."
        actions={
          <Button variant="primary" onClick={() => setFormOpen(true)}>
            Yeni lisans
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select aria-label="Durum süzgeci" className="w-44" value={status} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="">Tüm durumlar</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFilter('flagged', e.target.checked ? '1' : '')} />
          Yalnızca klon şüphesi olanlar
        </label>
        {customerId && (
          <Button size="sm" variant="ghost" onClick={() => setFilter('customerId', '')}>
            Müşteri süzgecini kaldır
          </Button>
        )}
      </div>

      {isPending ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <TableWrap>
          <EmptyState title="Lisans yok" description="Süzgeçleri temizleyin ya da yeni lisans verin." />
        </TableWrap>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Müşteri</Th>
                <Th>Tür</Th>
                <Th>Sektörler</Th>
                <Th>Cihaz</Th>
                <Th>Şirket sınırı</Th>
                <Th>Bitiş</Th>
                <Th>Durum</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <Tr key={l.id} data-testid={`license-${l.customer}`}>
                  <Td>
                    <Link to={`/licenses/${l.id}`} className="link">
                      {l.customer}
                    </Link>
                    <span className="block text-xs text-muted">{l.codePrefix}…</span>
                  </Td>
                  <Td>{KIND_LABELS[l.kind]}</Td>
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      {l.sectors.map((s) => (
                        <Badge key={s}>{SECTOR_LABELS[s]}</Badge>
                      ))}
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {l.reportedDevices ?? 0} / {l.deviceLimit}
                  </Td>
                  <Td>{l.companyLimit}</Td>
                  <Td className="whitespace-nowrap">{fmtDay(l.validUntil)}</Td>
                  <Td>
                    <span className="flex items-center gap-1.5">
                      <Badge tone={STATUS_TONES[l.status]}>{STATUS_LABELS[l.status]}</Badge>
                      {l.flagged && (
                        <span title="Klon şüphesi" className="text-danger">
                          <Flag className="size-4" aria-label="Klon şüphesi" />
                        </span>
                      )}
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}

      <LicenseFormSheet
        open={formOpen}
        onOpenChange={(o) => {
          setFormOpen(o);
          if (!o && presetNew) setFilter('new', '');
        }}
        presetCustomerId={presetNew}
        onCreated={(c) => setCode(c)}
      />
      <CodeModal code={code} onClose={() => setCode(null)} />
    </>
  );
}
