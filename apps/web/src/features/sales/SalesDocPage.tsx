import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router-dom';
import { SALES_DOC_KINDS } from '@erp/shared';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { errorMessage } from '../../lib/errors';
import { useCan, useCQuery } from '../../lib/queries';
import type { SalesDocDetail, SalesDocKind } from '../../lib/types';
import { SalesDocForm } from './SalesDocForm';
import { SalesDocView } from './SalesDocView';

/** /sales/docs/new?kind=quote|order ve /sales/docs/:id: taslaksa düzenlenebilir form, değilse salt okunur görünüm (eylemler, yazdırma). */
export function SalesDocPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const canManage = useCan()('invoices.manage');
  const kindParam = params.get('kind');
  const newKind: SalesDocKind = (SALES_DOC_KINDS as readonly string[]).includes(kindParam ?? '') ? (kindParam as SalesDocKind) : 'quote';
  const detail = useCQuery<SalesDocDetail>(['sales-doc', id], id ? `/api/sales-docs/${id}` : null);

  if (!id) {
    if (!canManage) return <Callout tone="danger">{t('errors.FORBIDDEN')}</Callout>;
    return <SalesDocForm key={`new-${newKind}`} kind={newKind} />;
  }
  if (detail.error) return <Callout tone="danger">{errorMessage(detail.error)}</Callout>;
  if (!detail.data) return <PageLoading />;
  if (detail.data.doc.status === 'draft' && canManage) return <SalesDocForm key={id} kind={detail.data.doc.kind} initial={detail.data} />;
  return <SalesDocView key={id} data={detail.data} />;
}
