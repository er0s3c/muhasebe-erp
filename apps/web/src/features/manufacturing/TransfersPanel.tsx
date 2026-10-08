import { useQueryClient } from '@tanstack/react-query';
import { useCan, useCompanyApi, useCQuery } from '../../lib/queries';
import { OperationForm, Records, Status, selectField, numberField } from '../leather/common';
import { displayQuantity } from '../../lib/presentation';

type Transfer = {
  id: string;
  orderId: string;
  fromOperation: string;
  toOperation: string;
  quantity: string;
  receivedQty: string;
  status: string;
};
export function TransfersPanel({
  orderId,
  operations,
}: {
  orderId: string;
  operations: { key: string; name: string }[];
}) {
  const can = useCan(),
    { call } = useCompanyApi(),
    queries = useQueryClient();
  const records = useCQuery<{ records: Transfer[] }>(
    ['manufacturing', 'transfers', orderId],
    '/api/manufacturing/transfers',
  );
  const save = async (path: string, body: unknown) => {
    await call(path, { method: 'POST', body });
    await queries.invalidateQueries();
  };
  const choices = operations.map((o) => ({ value: o.key, label: o.name }));
  return (
    <>
      <h3 className="mb-3 mt-5">Operasyonlar arası transferler</h3>
      <Records
        rows={records.data?.records.filter((r) => r.orderId === orderId)}
        loading={records.isPending}
        error={records.error}
        columns={[
          {
            label: 'Kaynak',
            render: (r) =>
              operations.find((o) => o.key === r.fromOperation)?.name ?? r.fromOperation,
          },
          {
            label: 'Hedef',
            render: (r) => operations.find((o) => o.key === r.toOperation)?.name ?? r.toOperation,
          },
          { label: 'Gönderilen', numeric: true, render: (r) => displayQuantity(r.quantity) },
          { label: 'Kabul', numeric: true, render: (r) => displayQuantity(r.receivedQty) },
          { label: 'Durum', render: (r) => <Status value={r.status} /> },
        ]}
        action={(r) =>
          can('manufacturing.production.manage') &&
          ['draft', 'approved', 'dispatched', 'part_received'].includes(r.status) ? (
            <OperationForm
              title="Transfer işlemi"
              fields={[
                selectField(
                  'action',
                  'İşlem',
                  r.status === 'draft'
                    ? can('manufacturing.production.approve')
                      ? [
                          { value: 'approve', label: 'Onayla' },
                          { value: 'cancel', label: 'İptal' },
                        ]
                      : [{ value: 'cancel', label: 'İptal' }]
                    : r.status === 'approved'
                      ? [
                          { value: 'dispatch', label: 'Gönder' },
                          { value: 'cancel', label: 'İptal' },
                        ]
                      : [{ value: 'receive', label: 'Kısmi kabul' }],
                ),
                { ...numberField('quantity', 'Kabul adedi'), required: false },
              ]}
              submit={(v) =>
                save(`/api/manufacturing/transfers/${r.id}/actions`, {
                  action: v.action,
                  quantity: v.quantity || undefined,
                  requestKey: v._requestKey,
                })
              }
            />
          ) : null
        }
      />
      {can('manufacturing.production.manage') && (
        <OperationForm
          title="Transfer talebi"
          fields={[
            selectField('fromOperation', 'Kaynak operasyon', choices),
            selectField('toOperation', 'Hedef operasyon', choices),
            numberField('quantity', 'Gönderilecek iyi adet'),
          ]}
          submit={(v) => save('/api/manufacturing/transfers', { orderId, ...v })}
        />
      )}
    </>
  );
}
