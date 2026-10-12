import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatTR } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useCan, useCompanyApi, useCQuery } from '../../lib/queries';
import { errorMessage } from '../../lib/errors';
import { useProjectOptions } from '../projects/common';

type Suggestion = { itemId: string; code: string; name: string; unit: string; minLevel: string; targetLevel: string | null;
  onHand: string; onOrder: string; requested: string; projected: string; suggested: string | null; estimateUnitPrice: string | null };

export function ReplenishmentPage() {
  const { company, call } = useCompanyApi();
  const navigate = useNavigate();
  const query = useCQuery<{ rows: Suggestion[] }>(['replenishment'], '/api/procurement/replenishment');
  const canManage = useCan()('procurement.manage');
  const projectBased = company.sector === 'CONSTRUCTION';
  const { projects } = useProjectOptions();
  const [projectId, setProjectId] = useState('');
  const [needDate, setNeedDate] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = query.data?.rows ?? [];
  const eligible = rows.filter(row => row.suggested !== null && Number(row.suggested) > 0);
  const picked = eligible.filter(row => selected.has(row.itemId));
  const create = async () => {
    if (busy || !picked.length || (projectBased && !projectId)) return;
    setBusy(true); setError(null);
    try {
      const output = await call<{ request: { id: string } }>('/api/procurement/replenishment/draft', { method: 'POST',
        body: { projectId: projectBased ? projectId : null, needDate: needDate || null, items: picked.map(row => ({ itemId: row.itemId, quantity: row.suggested })) } });
      navigate(`/purchasing/requests/${output.request.id}`);
    } catch (cause) { setError(errorMessage(cause)); await query.refetch(); }
    finally { setBusy(false); }
  };
  return <>
    <PageHeader title="Stok tamamlama önerileri" description="Minimuma düşen kartları hedef miktara tamamlar. Açık siparişler ve henüz siparişe dönüşmemiş talepler aynı ihtiyacı tekrar oluşturmaz." actions={<Button disabled={busy} onClick={() => { setSelected(new Set()); void query.refetch(); }}>Önerileri yenile</Button>} />
    {query.error && <Callout tone="warning">{errorMessage(query.error)}</Callout>}
    {error && <Callout tone="danger">{error}</Callout>}
    {query.isPending ? <PageLoading /> : query.data && <>
      {canManage && <Card className="mb-5 grid items-end gap-4 p-5 sm:grid-cols-3">
        {projectBased && <Field label="İhtiyacın projesi" required>{id => <Select id={id} value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">Proje seçin</option>{projects.filter(project => !['completed', 'cancelled'].includes(project.status)).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</Select>}</Field>}
        <Field label="İhtiyaç tarihi">{id => <Input id={id} type="date" value={needDate} onChange={event => setNeedDate(event.target.value)} />}</Field>
        <Button variant="primary" loading={busy} disabled={!picked.length || (projectBased && !projectId)} onClick={() => void create()}>Talep taslağı oluştur ({picked.length})</Button>
      </Card>}
      <TableWrap><Table><thead><tr>
        <Th><input type="checkbox" aria-label="Önerilen tüm kalemleri seç" disabled={!canManage || !eligible.length || busy} checked={eligible.length > 0 && eligible.every(row => selected.has(row.itemId))} onChange={event => setSelected(event.target.checked ? new Set(eligible.map(row => row.itemId)) : new Set())} /></Th>
        <Th>Stok kartı</Th><Th>Eldeki</Th><Th>Minimum / hedef</Th><Th>Açık sipariş</Th><Th>Bekleyen talep</Th><Th>Önerilen alım</Th>
      </tr></thead><tbody>{rows.map(row => <Tr key={row.itemId}>
        <Td><input type="checkbox" aria-label={`${row.name} için talep seç`} disabled={!canManage || !row.suggested || Number(row.suggested) <= 0 || busy} checked={selected.has(row.itemId)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(row.itemId); else next.delete(row.itemId); return next; })} /></Td>
        <Td><span className="block text-sm">{row.name}</span><span className="text-xs text-muted">{row.code} · {row.unit}</span></Td><Td>{formatTR(row.onHand, 2)}</Td>
        <Td>{formatTR(row.minLevel, 2)} / {row.targetLevel === null ? 'Tanımlanmamış' : formatTR(row.targetLevel, 2)}</Td><Td>{formatTR(row.onOrder, 2)}</Td><Td>{formatTR(row.requested, 2)}</Td>
        <Td>{row.suggested === null ? 'Hedef miktar gerekli' : Number(row.suggested) > 0 ? formatTR(row.suggested, 2) : 'İhtiyaç karşılanıyor'}</Td>
      </Tr>)}</tbody></Table></TableWrap>
      {!rows.length && <p className="mt-4 text-sm text-muted">Minimum seviyesine düşen aktif stok kartı yok.</p>}
      <p className="mt-4 text-xs text-muted">Minimum ve hedef şirket toplamı içindir; tüm şubeler görünümünde hesaplanır. Kaydetme sırasında öneri yeniden kontrol edilir. Taslakta fiyatları, teslim tarihini ve ihtiyacı inceleyip ayrıca onaya gönderin.</p>
    </>}
  </>;
}
