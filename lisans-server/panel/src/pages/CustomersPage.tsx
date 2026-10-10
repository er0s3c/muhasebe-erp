import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@ui/Button';
import { PageHeader } from '@ui/Card';
import { Callout, EmptyState, ErrorState, PageLoading } from '@ui/Feedback';
import { Field, Input, Textarea } from '@ui/Field';
import { Modal, Sheet } from '@ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '@ui/Table';
import { useToast } from '@ui/Toast';
import { markFormSaved } from '@ui/UnsavedChanges';
import { api, errorText, type Customer } from '../api';
import { fmtDate } from '../format';
import { focusValidationError, validationErrors } from '../validation';

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
  const pending = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (Object.keys(fieldErrors).length > 0) focusValidationError(formRef.current);
  }, [fieldErrors]);
  const [removing, setRemoving] = useState<Customer | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const { data, isPending, error: queryError, refetch, isFetching } = useQuery({
    queryKey: ['customers', q],
    queryFn: () => api<{ customers: Customer[] }>(`/admin/api/customers${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`),
  });
  const deletionDetails = useQuery({
    queryKey: ['customer-delete', removing?.id],
    queryFn: () => api<{ licenses: { id: string }[]; activationCount: number }>(`/admin/api/customers/${removing!.id}`),
    enabled: removing !== null,
    staleTime: 0,
    retry: false,
  });

  const submit = async () => {
    if (pending.current || form.name.trim().length < 2) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const body = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim() === '' ? null : v.trim()]));
      await api('/admin/api/customers', { method: 'POST', body });
      markFormSaved(formRef.current);
      toast.success('Müşteri eklendi.');
      setOpen(false);
      setForm(blank);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['customers'] }), queryClient.invalidateQueries({ queryKey: ['dashboard'] })]);
    } catch (e) {
      setFieldErrors(validationErrors(e));
      setError(errorText(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!removing || removeBusy) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await api(`/admin/api/customers/${removing.id}`, { method: 'DELETE' });
      toast.success('Müşteri silindi.');
      setRemoving(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['customers'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['audit'] }),
        queryClient.invalidateQueries({ queryKey: ['licenses'] }),
        queryClient.invalidateQueries({ queryKey: ['license'] }),
        queryClient.removeQueries({ queryKey: ['customer-delete'] }),
      ]);
    } catch (e) {
      setRemoveError(errorText(e));
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Müşteriler"
        description="Lisans verdiğiniz kişi ve kurumlar."
        actions={
          <Button variant="primary" onClick={() => { setError(null); setFieldErrors({}); setOpen(true); }}>
            Yeni müşteri
          </Button>
        }
      />
      <div className="mb-4 max-w-sm">
        <Input aria-label="Müşteri ara" placeholder="Ad ya da e-posta ara…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {queryError ? <ErrorState description={errorText(queryError)} onRetry={() => void refetch()} retrying={isFetching} /> : isPending || !data ? (
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
                      <Button size="sm" variant="danger" onClick={() => { setRemoveError(null); setRemoving(c); }}>
                        Sil
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
        onOpenChange={(next) => { if (!busy) setOpen(next); }}
        title="Yeni müşteri"
        footer={
          <>
            <Button disabled={busy} onClick={() => setOpen(false)}>Vazgeç</Button>
            <Button variant="primary" loading={busy} disabled={form.name.trim().length < 2} onClick={() => void submit()}>
              Ekle
            </Button>
          </>
        }
      >
        <form
          ref={formRef}
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.name.trim().length >= 2) void submit();
          }}
        >
          {error && <Callout tone="danger">{error}</Callout>}
          <Field label="Ad / unvan" required error={fieldErrors.name}>
            {(id) => <Input id={id} aria-invalid={!!fieldErrors.name} required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
          </Field>
          <Field label="İlgili kişi" error={fieldErrors.contactName}>{(id) => <Input id={id} aria-invalid={!!fieldErrors.contactName} value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />}</Field>
          <Field label="E-posta" error={fieldErrors.email}>{(id) => <Input id={id} aria-invalid={!!fieldErrors.email} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
          <Field label="Telefon" error={fieldErrors.phone}>{(id) => <Input id={id} aria-invalid={!!fieldErrors.phone} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}</Field>
          <Field label="Notlar" error={fieldErrors.notes}>{(id) => <Textarea id={id} aria-invalid={!!fieldErrors.notes} rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />}</Field>
        </form>
      </Sheet>
      <Modal
        open={removing !== null}
        onOpenChange={(next) => { if (!next && !removeBusy) setRemoving(null); }}
        title="Müşteriyi sil"
        description={removing ? `“${removing.name}” müşteri kaydı silinecek. Bu işlem geri alınamaz.` : undefined}
        footer={
          <>
            <Button disabled={removeBusy} onClick={() => setRemoving(null)}>Vazgeç</Button>
            <Button variant="danger" loading={removeBusy} disabled={!deletionDetails.data || !!deletionDetails.error} onClick={() => void remove()}>Kalıcı olarak sil</Button>
          </>
        }
      >
        <div className="space-y-3">
          {removeError && <Callout tone="danger">{removeError}</Callout>}
          {deletionDetails.error && <Callout tone="danger">{errorText(deletionDetails.error)}</Callout>}
          {deletionDetails.isPending ? <p className="text-sm text-muted" role="status">Silinecek kayıtlar kontrol ediliyor…</p> : deletionDetails.data && (
            <Callout tone="warning">Müşteriyle birlikte {deletionDetails.data.licenses.length} lisans ve {deletionDetails.data.activationCount} kurulum kaydı kalıcı olarak silinecek.</Callout>
          )}
          <p className="text-sm text-muted">Silinen lisanslarla yeniden etkinleştirme yapılamaz. Mevcut imzalı lisansı olan kurulumlar, o lisansın süresi bitene kadar çalışabilir. Silme işleminin denetim kaydı korunur.</p>
        </div>
      </Modal>
    </>
  );
}
