import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@ui/Button';
import { PageHeader } from '@ui/Card';
import { Callout, EmptyState, PageLoading } from '@ui/Feedback';
import { Field, Input, Textarea } from '@ui/Field';
import { Sheet } from '@ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '@ui/Table';
import { useToast } from '@ui/Toast';
import { api, errorText, type Customer } from '../api';
import { fmtDate } from '../format';

const blank = { name: '', contactName: '', email: '', phone: '', notes: '' };

export function CustomersPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, isPending } = useQuery({
    queryKey: ['customers', q],
    queryFn: () => api<{ customers: Customer[] }>(`/admin/api/customers${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`),
  });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim() === '' ? null : v.trim()]));
      await api('/admin/api/customers', { method: 'POST', body });
      toast.success('Müşteri eklendi.');
      setOpen(false);
      setForm(blank);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['customers'] }), queryClient.invalidateQueries({ queryKey: ['dashboard'] })]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Müşteriler"
        description="Lisans verdiğiniz kişi ve kurumlar."
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            Yeni müşteri
          </Button>
        }
      />
      <div className="mb-4 max-w-sm">
        <Input aria-label="Müşteri ara" placeholder="Ad ya da e-posta ara…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {isPending || !data ? (
        <PageLoading />
      ) : data.customers.length === 0 ? (
        <TableWrap>
          <EmptyState title={q ? 'Eşleşen müşteri yok' : 'Henüz müşteri yok'} description={q ? undefined : 'İlk müşteriyi ekleyin, ardından ona lisans verin.'} />
        </TableWrap>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Ad</Th>
                <Th>İlgili kişi</Th>
                <Th>E-posta</Th>
                <Th>Telefon</Th>
                <Th>Eklenme</Th>
                <Th className="text-right">İşlemler</Th>
              </tr>
            </thead>
            <tbody>
              {data.customers.map((c) => (
                <Tr key={c.id} data-testid={`customer-${c.name}`}>
                  <Td>{c.name}</Td>
                  <Td>{c.contactName ?? '—'}</Td>
                  <Td>{c.email ?? '—'}</Td>
                  <Td>{c.phone ?? '—'}</Td>
                  <Td className="whitespace-nowrap">{fmtDate(c.createdAt)}</Td>
                  <Td className="text-right">
                    <span className="inline-flex flex-wrap justify-end gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => navigate(`/licenses?customerId=${c.id}`)}>
                        Lisansları gör
                      </Button>
                      <Button size="sm" onClick={() => navigate(`/licenses?new=${c.id}`)}>
                        Lisans ver
                      </Button>
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}

      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="Yeni müşteri"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Vazgeç</Button>
            <Button variant="primary" loading={busy} disabled={form.name.trim().length < 2} onClick={() => void submit()}>
              Ekle
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.name.trim().length >= 2) void submit();
          }}
        >
          {error && <Callout tone="danger">{error}</Callout>}
          <Field label="Ad / unvan" required>
            {(id) => <Input id={id} autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
          </Field>
          <Field label="İlgili kişi">{(id) => <Input id={id} value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />}</Field>
          <Field label="E-posta">{(id) => <Input id={id} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
          <Field label="Telefon">{(id) => <Input id={id} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}</Field>
          <Field label="Notlar">{(id) => <Textarea id={id} rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />}</Field>
        </form>
      </Sheet>
    </>
  );
}
