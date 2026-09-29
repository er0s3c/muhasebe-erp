import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTR, todayIso } from '@erp/shared';
import { Field, Input } from '../../components/ui/Field';

/** Varsayılan dönem: yılbaşından bugüne. */
export function useReportPeriod() {
  const year = todayIso().slice(0, 4);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(todayIso());
  return { from, to, setFrom, setTo, valid: Boolean(from && to && from <= to) };
}

export const periodText = (from: string, to: string) => `${formatDateTR(from)} – ${formatDateTR(to)}`;

/** Tarih aralığı süzgeci (yazdırırken gizlenir; dönem baskı başlığında yazılıdır). */
export function PeriodFields({ from, to, onFrom, onTo }: { from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => onFrom(e.target.value)} className="w-44" />}</Field>
      <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => onTo(e.target.value)} className="w-44" />}</Field>
    </>
  );
}
