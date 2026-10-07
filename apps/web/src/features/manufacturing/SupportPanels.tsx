import { useQueryClient } from '@tanstack/react-query';
import { useCan, useCompanyApi, useCQuery } from '../../lib/queries';
import { OperationForm, selectField, textField, numberField } from '../leather/common';

type Row = { id: string; name: string; number?: string; month?: string };
export function CustomValuesPanel({
  entity,
  id,
}: {
  entity: 'production' | 'model' | 'resource' | 'item';
  id: string;
}) {
  const can = useCan(),
    { call } = useCompanyApi(),
    queries = useQueryClient();
  const area =
    entity === 'production'
      ? 'manufacturing.production'
      : entity === 'model'
        ? 'manufacturing.catalog'
        : entity === 'item'
          ? 'inventory'
          : 'manufacturing.planning';
  const path = `/api/manufacturing/custom-values/${entity}/${id}`;
  const data = useCQuery<{
    fields: { code: string; name: string; type: string; required: boolean; choices: string[] }[];
    values: Record<string, string>;
  }>(['manufacturing', 'custom-values', entity, id], path, { enabled: can(area + '.read') });
  if (!data.data?.fields.length || !can(area + '.manage')) return null;
  return (
    <OperationForm
      key={JSON.stringify(data.data.values)}
      title="Özel alanlar"
      fields={data.data.fields.map((f) => ({
        ...(f.type === 'choice'
          ? selectField(
              f.code,
              f.name,
              f.choices.map((v) => ({ value: v, label: v })),
            )
          : textField(f.code, f.name)),
        type:
          f.type === 'choice'
            ? 'select'
            : f.type === 'number'
              ? 'number'
              : f.type === 'date'
                ? 'date'
                : 'text',
        required: f.required,
        value: data.data!.values[f.code] ?? '',
      }))}
      submit={async (values) => {
        const { _requestKey, ...input } = values;
        void _requestKey;
        await call(path, { method: 'PUT', body: { values: input } });
        await queries.invalidateQueries();
      }}
    />
  );
}

export function PieceRatePanel() {
  const can = useCan(),
    { call } = useCompanyApi(),
    queries = useQueryClient();
  const enabled = can('manufacturing.costs.manage') && can('hr.payroll_manage');
  const lookups = useCQuery<{ resources: Row[]; runs: Row[]; items: Row[] }>(
    ['manufacturing', 'piece-rate-lookups'],
    '/api/manufacturing/piece-rates/lookups',
    { enabled },
  );
  if (!enabled) return null;
  const opts = (rows: Row[]) => rows.map((r) => ({ value: r.id, label: r.name }));
  return (
    <OperationForm
      title="Üretimden prim veya parça başı ödeme"
      description="Gerçek iyi adet veya saat, seçtiğiniz birim ücretle hesaplanır ve taslak bordronun ek ödeme kalemine bağlanır."
      fields={[
        selectField('resourceId', 'Personele bağlı kaynak', opts(lookups.data?.resources ?? [])),
        selectField(
          'payrollRunId',
          'Taslak bordro',
          (lookups.data?.runs ?? []).map((r) => ({
            value: r.id,
            label: `${r.month} · ${r.number}`,
          })),
        ),
        selectField('payrollItemId', 'Ek ödeme kalemi', opts(lookups.data?.items ?? [])),
        textField('operationKey', 'Operasyon anahtarı'),
        selectField('mode', 'Hesaplama', [
          { value: 'piece', label: 'İyi adet' },
          { value: 'hour', label: 'Gerçek saat' },
        ]),
        numberField('unitRate', 'Birim ücret'),
      ]}
      submit={async (v) => {
        await call('/api/manufacturing/piece-rates', {
          method: 'POST',
          body: { ...v, requestKey: v._requestKey },
        });
        await queries.invalidateQueries();
      }}
      action="Bordroya aktar"
    />
  );
}
