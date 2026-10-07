import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ProductionLink as Link, useProductionCan as useCan, useGenericProduction, productionPath } from './production-context';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { useCompanyApi } from '../../lib/queries';
import { ApiError } from '../../lib/api';

export type Values = Record<string, string>;
export interface Option {
  value: string;
  label: string;
}
export interface FormField {
  name: string;
  label: string;
  type?: 'text' | 'password' | 'number' | 'date' | 'textarea' | 'select';
  options?: Option[];
  required?: boolean;
  value?: string;
  hint?: string;
  min?: number;
  step?: string;
}

/** Domain forms keep the submitted values visible after a failed request. */
export function OperationForm({
  title,
  description,
  fields,
  submit,
  action = 'Kaydet',
  disabled,
  onDone,
  children,
}: {
  title: string;
  description?: string;
  fields: FormField[];
  submit: (values: Values) => Promise<unknown>;
  action?: string;
  disabled?: boolean;
  onDone?: () => void;
  children?: ReactNode;
}) {
  const initial = () => ({
    ...Object.fromEntries(fields.map((field) => [field.name, field.value ?? ''])),
    _requestKey: crypto.randomUUID(),
  });
  const [values, setValues] = useState<Values>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const toast = useToast();
  return (
    <Card className="mb-5">
      <CardHeader title={title} description={description} />
      <form
        aria-label={title}
        className="space-y-4 p-5"
        onSubmit={async (event) => {
          event.preventDefault();
          setPending(true);
          setError('');
          setFieldErrors({});
          try {
            await submit(values);
            toast.success('İşlem kaydedildi');
            setValues(initial());
            onDone?.();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'İşlem kaydedilemedi');
            if (cause instanceof ApiError)
              setFieldErrors(
                Object.fromEntries(
                  cause.fieldErrors.map((detail) => [detail.path, detail.message]),
                ),
              );
          } finally {
            setPending(false);
          }
        }}
      >
        <fieldset disabled={pending} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {fields.map((field) => (
              <Field
                key={field.name}
                label={field.label}
                hint={field.hint}
                error={fieldErrors[field.name]}
                required={field.required}
              >
                {(id) =>
                  field.type === 'select' ? (
                    <Select
                      id={id}
                      required={field.required}
                      value={values[field.name] ?? ''}
                      onChange={(event) =>
                        setValues({ ...values, [field.name]: event.target.value })
                      }
                    >
                      <option value="">Seçiniz</option>
                      {field.options?.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  ) : field.type === 'textarea' ? (
                    <Textarea
                      id={id}
                      required={field.required}
                      value={values[field.name] ?? ''}
                      onChange={(event) =>
                        setValues({ ...values, [field.name]: event.target.value })
                      }
                    />
                  ) : (
                    <Input
                      id={id}
                      type={field.type ?? 'text'}
                      required={field.required}
                      min={field.min}
                      step={field.step ?? (field.type === 'number' ? 'any' : undefined)}
                      value={values[field.name] ?? ''}
                      onChange={(event) =>
                        setValues({ ...values, [field.name]: event.target.value })
                      }
                    />
                  )
                }
              </Field>
            ))}
          </div>
          {children}
          {error && <Callout tone="danger">{error}</Callout>}
          <Button type="submit" variant="primary" loading={pending} disabled={disabled}>
            {action}
          </Button>
        </fieldset>
      </form>
    </Card>
  );
}

export function useLeatherActions() {
  const { call, company } = useCompanyApi();
  const queries = useQueryClient();
  const generic=useGenericProduction();
  return async (path: string, body: unknown, method: 'POST' | 'PATCH' | 'PUT' = 'POST') => {
    const result = await call(productionPath(path,generic), { method, body });
    await Promise.all(
      ['leather', 'pos', 'items', 'inventory-summary', 'stock-status', 'parties', 'treasury'].map(
        (key) => queries.invalidateQueries({ queryKey: [company.id, key] }),
      ),
    );
    return result;
  };
}

const statusLabels: Record<string, string> = {
  draft: 'Taslak',
  approved: 'Üretime uygun',
  active: 'Aktif',
  inactive: 'Pasif',
  pending: 'Bekliyor',
  accepted: 'Kabul edildi',
  rejected: 'Reddedildi',
  quarantine: 'Karantina',
  available: 'Kullanılabilir',
  reserved: 'Rezerve',
  consumed: 'Tüketildi',
  planned: 'Planlandı',
  released: 'Üretimde',
  in_progress: 'Devam ediyor',
  completed: 'Tamamlandı',
  cancelled: 'İptal',
  open: 'Açık',
  closed: 'Kapalı',
  pass: 'Uygun',
  fail: 'Uygunsuz',
  rework: 'Yeniden işlem',
  repair: 'Onarım',
  scrap: 'Hurda',
  second_quality: 'İkinci kalite',
  sent: 'Gönderildi',
  received: 'Teslim alındı',
  paid: 'Ödendi',
  delivered: 'Teslim edildi',
  confirmed: 'Kesinleşti',
  diagnosed: 'İncelendi',
  repairing: 'Onarımda',
  ready: 'Teslime hazır',
  dispatched: 'Gönderildi',
  returned: 'Geri alındı',
  checked: 'Kontrol edildi',
  second: 'İkinci kalite',
  split: 'Kesildi',
  started: 'Başladı',
};
export function Status({ value }: { value: string }) {
  return (
    <Badge
      tone={
        ['completed', 'accepted', 'approved', 'pass', 'closed'].includes(value)
          ? 'success'
          : ['rejected', 'fail', 'scrap', 'cancelled'].includes(value)
            ? 'danger'
            : 'neutral'
      }
    >
      {statusLabels[value] ?? value}
    </Badge>
  );
}

export function Records<T extends { id: string }>({
  rows,
  columns,
  loading,
  error,
  empty = 'Henüz kayıt yok',
  action,
}: {
  rows?: T[];
  columns: { label: string; render: (row: T) => ReactNode; numeric?: boolean }[];
  loading?: boolean;
  error?: Error | null;
  empty?: string;
  action?: (row: T) => ReactNode;
}) {
  if (loading) return <PageLoading />;
  if (error) return <Callout tone="danger">{error.message}</Callout>;
  if (!rows?.length)
    return (
      <Card>
        <EmptyState title={empty} description="İlk kaydı yukarıdaki formdan oluşturabilirsiniz." />
      </Card>
    );
  return (
    <TableWrap>
      <Table>
        <thead>
          <tr>
            {columns.map((column) => (
              <Th key={column.label} num={column.numeric}>
                {column.label}
              </Th>
            ))}
            {action && <Th>İşlem</Th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map((column) => (
                <Td key={column.label} num={column.numeric}>
                  {column.render(row)}
                </Td>
              ))}
              {action && <Td>{action(row)}</Td>}
            </tr>
          ))}
        </tbody>
      </Table>
    </TableWrap>
  );
}

export function LeatherHeader({ title, description }: { title: string; description?: string }) {
  const can = useCan();
  const generic=useGenericProduction();
  const links = [
    ['/leather', 'Genel bakış', 'leather.catalog.read'],
    ['/leather/models', 'Model ve koleksiyon', 'leather.catalog.read'],
    ['/leather/materials', 'Deri kabul ve kesim', 'leather.materials.read'],
    ['/leather/production', 'Üretim', 'leather.production.read'],
    ['/leather/subcontracts', 'Fason', 'leather.subcontracting.read'],
    ['/leather/quality', 'Kalite', 'leather.quality.read'],
    ['/leather/custom-orders', 'Özel sipariş', 'leather.catalog.read'],
    ['/leather/service', 'Servis ve onarım', 'leather.service.read'],
  ];
  return (
    <>
      <PageHeader title={generic?title.replace(/Deri/g,'Üretim').replace(/deri/g,'ürün'):title} description={description} />
      <nav
        aria-label="Deri üretim ekranları"
        className="mb-5 flex flex-wrap gap-x-5 gap-y-2 text-sm"
      >
        {links
          .filter(([path, , permission]) => (!generic||!['/leather/materials','/leather/custom-orders','/leather/service'].includes(path!)) && can(permission!))
          .map(([path, label]) => (
            <Link key={path} className="link" to={path!}>
              {label}
            </Link>
          ))}
      </nav>
    </>
  );
}

export const textField = (
  name: string,
  label: string,
  required = false,
  hint?: string,
): FormField => ({ name, label, required, hint });
export const numberField = (name: string, label: string, value = '', min = 0): FormField => ({
  name,
  label,
  type: 'number',
  value,
  min,
  required: true,
});
export const selectField = (
  name: string,
  label: string,
  options: Option[],
  required = true,
  value = '',
): FormField => ({ name, label, type: 'select', options, required, value });
export const options = <T extends { id: string }>(
  rows: T[] | undefined,
  label: (row: T) => string,
): Option[] => (rows ?? []).map((row) => ({ value: row.id, label: label(row) }));
export const optional = (value: string | undefined) => value?.trim() || null;

export function useFocusedRecord<T extends { id: string }>(
  rows: T[] | undefined,
  select: (row: T) => void,
  parameter = 'open',
) {
  const [params] = useSearchParams();
  const id = params.get(parameter);
  const resolved = useRef('');
  useEffect(() => {
    if (!id || resolved.current === id) return;
    const row = rows?.find((record) => record.id === id);
    if (row) {
      resolved.current = id;
      select(row);
    }
  }, [id, rows, select]);
}
