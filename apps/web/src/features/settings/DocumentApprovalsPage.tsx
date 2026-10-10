import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ROLES } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany, useSession } from '../../lib/session';
import {
  APPROVAL_INVALIDATE,
  APPROVAL_LABELS,
  ApprovalRequestCard,
  type DocumentApproval,
  type DocumentApprovalType,
  type FinancialDraft,
} from '../approvals/common';
import { TransactionSheet } from '../treasury/TransactionSheet';
import { ExpenseDraftEditor } from '../approvals/ExpenseDraftEditor';
import { useProjectOptions } from '../projects/common';

interface Rule {
  id: string;
  docType: DocumentApprovalType;
  minAmount: string;
  maxAmount: string | null;
  isActive: boolean;
  projectId: string | null;
  steps: {
    stepNo: number;
    approverRole: string | null;
    approverUserId: string | null;
    label: string | null;
  }[];
}
export function FinancialDraftList({ type }: { type?: 'payment' | 'expense' }) {
  const company = useCompany(),
    user = useSession().user,
    toast = useToast();
  const query = useCQuery<{ drafts: FinancialDraft[] }>(
    ['financial-approval-drafts'],
    '/api/financial-approval-drafts',
    { refetchOnWindowFocus: true },
  );
  const [editing, setEditing] = useState<FinancialDraft | null>(null),
    [error, setError] = useState<string | null>(null);
  const submit = useCMutation(
    (id: string, call) =>
      call(`/api/financial-approval-drafts/${id}/submit`, { method: 'POST', body: {} }),
    APPROVAL_INVALIDATE,
  );
  const rows = (query.data?.drafts ?? []).filter((draft) => !type || draft.docType === type);
  return (
    <Card className="my-4 flex flex-col gap-3 p-4">
      <h2 className="text-base">Ödeme ve gider onay taslakları</h2>
      <p className="text-sm text-muted">
        Taslaklar son onaydan önce bakiyeyi veya muhasebe kayıtlarını değiştirmez.
      </p>
      {error && <Callout tone="danger">{error}</Callout>}
      {query.error && <Callout tone="danger">{errorMessage(query.error)}</Callout>}
      {query.isPending ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">Henüz mali onay taslağı yok.</p>
      ) : (
        rows.map((draft) => (
          <div className="border-t border-border pt-3" key={draft.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <strong className="text-sm">
                  {APPROVAL_LABELS[draft.docType]} ·{' '}
                  {draft.status === 'draft'
                    ? 'Taslak'
                    : draft.status === 'submitted'
                      ? 'Onay bekliyor'
                      : draft.status === 'rejected'
                        ? 'Yeniden düzenlenebilir'
                        : draft.status === 'posted'
                          ? 'Kesinleşti'
                          : 'İptal edildi'}
                </strong>
                <p className="text-xs text-muted">
                  {formatDateTR(draft.documentDate)} · {moneyIn(draft.amount, company.baseCurrency)}{' '}
                  · {String(draft.payload.description ?? '')}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {['draft', 'rejected'].includes(draft.status) && draft.createdBy === user?.id && (
                  <>
                    <Button size="sm" onClick={() => setEditing(draft)}>
                      Düzenle
                    </Button>
                    <Button
                      size="sm"
                      loading={submit.isPending && submit.variables === draft.id}
                      onClick={() =>
                        submit.mutate(draft.id, {
                          onSuccess: () => toast.success('Taslak onaya gönderildi'),
                          onError: (e) => setError(errorMessage(e)),
                        })
                      }
                    >
                      Onaya gönder
                    </Button>
                  </>
                )}
                {draft.postedDocId && (
                  <Link
                    className="link text-sm"
                    to={
                      draft.docType === 'payment'
                        ? `/treasury/transactions?open=${draft.postedDocId}`
                        : '/treasury/expenses'
                    }
                  >
                    Kesinleşen kaydı aç
                  </Link>
                )}
              </div>
            </div>
            <div className="mt-3 space-y-3">
              {draft.requests.map((request) => (
                <ApprovalRequestCard key={request.id} request={request} />
              ))}
            </div>
          </div>
        ))
      )}
      {editing?.docType === 'payment' && (
        <TransactionSheet
          open
          onOpenChange={(open) => !open && setEditing(null)}
          editingDraft={editing}
          initialType={editing.payload.type as 'payment' | 'other_payment'}
          onSaved={() => setEditing(null)}
        />
      )}{' '}
      {editing?.docType === 'expense' && (
        <ExpenseDraftEditor draft={editing} onClose={() => setEditing(null)} />
      )}
    </Card>
  );
}
export function DocumentApprovalsPage() {
  const { t } = useTranslation(),
    can = useCan(),
    company = useCompany(),
    toast = useToast();
  const query = useCQuery<{ rules: Rule[] }>(
    ['document-approvals', 'rules'],
    '/api/document-approvals/rules',
  );
  const inbox = useCQuery<{ requests: DocumentApproval[] }>(
    ['document-approvals', 'inbox'],
    '/api/document-approvals/inbox',
    { refetchOnWindowFocus: true },
  );
  const [open, setOpen] = useState(false),
    [type, setType] = useState<DocumentApprovalType>('invoice'),
    [min, setMin] = useState('0'),
    [max, setMax] = useState(''),
    [projectId, setProjectId] = useState(''),
    [steps, setSteps] = useState([{ role: 'accountant', userId: '', label: '' }]),
    [error, setError] = useState<string | null>(null);
  const projectOptions = useProjectOptions();
  const members = useCQuery<{ members: { userId: string; fullName: string; role: string }[] }>(
    ['members'],
    '/api/company/members',
    { enabled: can('members.manage') },
  );
  const save = useCMutation(
    (_: void, call) =>
      call('/api/document-approvals/rules', {
        method: 'POST',
        body: {
          docType: type,
          projectId: type === 'sales_quote' ? null : projectId || null,
          minAmount: min,
          maxAmount: max || null,
          separateRequester: true,
          steps: steps.map((step) => ({
            ...(step.userId ? { userId: step.userId } : { role: step.role }),
            label: step.label.trim() || null,
          })),
        },
      }),
    APPROVAL_INVALIDATE,
  );
  const toggle = useCMutation(
    (rule: Rule, call) =>
      call(`/api/document-approvals/rules/${rule.id}`, {
        method: 'PATCH',
        body: { isActive: !rule.isActive },
      }),
    APPROVAL_INVALIDATE,
  );
  const canManage = can('settings.manage') && ['owner', 'admin'].includes(company.role);
  return (
    <>
      <PageHeader
        title="Belge onay kuralları"
        description="Fatura, satış teklifi, ödeme ve gider için tutara göre sıralı onay adımları belirleyin."
        actions={
          canManage && (
            <Button
              variant="primary"
              onClick={() => {
                setError(null);
                setSteps([{ role: 'accountant', userId: '', label: '' }]);
                setOpen(true);
              }}
            >
              Onay kuralı oluştur
            </Button>
          )
        }
      />
      <Callout>
        Aktif kuralın tutar aralığına giren işlem ayrı onay tamamlanmadan kesinleşmez. Tutar
        sınırları defter para birimindedir. Faturalar son onayda kaydedilir; teklifler müşteriye
        gönderilmiş durumuna geçer. Kural olmayan işlemler mevcut kayıt akışını kullanır.
      </Callout>
      <section className="my-5 flex flex-col gap-3">
        <h2 className="text-base">Onay kutum</h2>
        {inbox.isPending ? (
          <PageLoading />
        ) : inbox.error ? (
          <Callout tone="danger">{errorMessage(inbox.error)}</Callout>
        ) : inbox.data?.requests.length ? (
          inbox.data.requests.map((request) => (
            <ApprovalRequestCard key={request.id} request={request} allowDecision />
          ))
        ) : (
          <p className="text-sm text-muted">Sıradaki adımı size ait bekleyen talep yok.</p>
        )}
      </section>
      <FinancialDraftList />
      <Card className="my-5 flex flex-col gap-3 p-4">
        <h2 className="text-base">Onay kuralları</h2>
        {query.error && <Callout tone="danger">{errorMessage(query.error)}</Callout>}
        {(query.data?.rules ?? []).map((rule) => (
          <div
            key={rule.id}
            className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"
          >
            <div>
              <strong className="text-sm">
                {APPROVAL_LABELS[rule.docType]} · {rule.isActive ? 'Etkin' : 'Pasif'}
              </strong>
              <p className="text-xs text-muted">
                {moneyIn(rule.minAmount, company.baseCurrency)} –{' '}
                {rule.maxAmount
                  ? `${moneyIn(rule.maxAmount, company.baseCurrency)} (hariç)`
                  : 'Üst sınır yok'}
              </p>
              <p className="text-sm">
                {rule.steps
                  .map(
                    (step) =>
                      step.label ||
                      (step.approverRole
                        ? t(`roles.${step.approverRole}` as never)
                        : (members.data?.members.find(
                            (member) => member.userId === step.approverUserId,
                          )?.fullName ?? 'Belirli kullanıcı')),
                  )
                  .join(' → ')}
              </p>
            </div>
            {canManage && (
              <Button
                size="sm"
                loading={toggle.isPending && toggle.variables?.id === rule.id}
                onClick={() =>
                  toggle.mutate(rule, { onError: (e) => toast.error(errorMessage(e)) })
                }
              >
                {rule.isActive ? 'Pasifleştir' : 'Etkinleştir'}
              </Button>
            )}
          </div>
        ))}
      </Card>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="Onay kuralı oluştur"
        description="Gönderen kendi talebini onaylayamaz. Kullanıcı veya rolün belge türündeki onay izni, karar anında tekrar kontrol edilir."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Vazgeç</Button>
            <Button
              variant="primary"
              loading={save.isPending}
              onClick={() =>
                save.mutate(undefined, {
                  onSuccess: () => {
                    setOpen(false);
                    toast.success('Onay kuralı kaydedildi');
                  },
                  onError: (e) => setError(errorMessage(e)),
                })
              }
            >
              Kaydet
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error && <Callout tone="danger">{error}</Callout>}
          <Field label="Belge türü">
            {(id) => (
              <Select
                id={id}
                value={type}
                onChange={(e) => {
                  setType(e.target.value as DocumentApprovalType);
                  setProjectId('');
                }}
              >
                {Object.entries(APPROVAL_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {type !== 'sales_quote' && projectOptions.allowed && (
            <Field
              label="Proje kapsamı"
              hint="Boş bırakılırsa şirket genelinde uygulanır. Çok projeli faturada özel kural varsa faturaları proje bazında ayırın."
            >
              {(id) => (
                <Select id={id} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">Tüm projeler ve genel işlemler</option>
                  {projectOptions.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.code} · {project.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="Alt tutar sınırı">
            {(id) => (
              <Input
                id={id}
                inputMode="decimal"
                value={min}
                onChange={(e) => setMin(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Üst tutar sınırı"
            hint="Boş bırakılırsa üst sınır uygulanmaz. Üst sınırın kendisi aralığa dahil değildir."
          >
            {(id) => (
              <Input
                id={id}
                inputMode="decimal"
                value={max}
                onChange={(e) => setMax(e.target.value)}
              />
            )}
          </Field>
          {steps.map((step, i) => (
            <Card key={i} className="flex flex-col gap-3 p-3">
              <strong className="text-sm">{i + 1}. adım</strong>
              <Field label="Onaylayan rol">
                {(id) => (
                  <Select
                    id={id}
                    value={step.role}
                    disabled={!!step.userId}
                    onChange={(e) =>
                      setSteps((prev) =>
                        prev.map((v, n) => (n === i ? { ...v, role: e.target.value } : v)),
                      )
                    }
                  >
                    {ROLES.map((role) => (
                      <option key={role} value={role}>
                        {t(`roles.${role}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {members.data && (
                <Field
                  label="Belirli kullanıcı"
                  hint="Seçerseniz rol yerine yalnızca bu kullanıcı karar verir."
                >
                  {(id) => (
                    <Select
                      id={id}
                      value={step.userId}
                      onChange={(e) =>
                        setSteps((prev) =>
                          prev.map((v, n) => (n === i ? { ...v, userId: e.target.value } : v)),
                        )
                      }
                    >
                      <option value="">Role göre</option>
                      {members.data.members.map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.fullName}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
              <Field label="Adım adı">
                {(id) => (
                  <Input
                    id={id}
                    value={step.label}
                    maxLength={100}
                    onChange={(e) =>
                      setSteps((prev) =>
                        prev.map((v, n) => (n === i ? { ...v, label: e.target.value } : v)),
                      )
                    }
                  />
                )}
              </Field>
              {steps.length > 1 && (
                <Button
                  size="sm"
                  onClick={() => setSteps((prev) => prev.filter((_, n) => n !== i))}
                >
                  Adımı kaldır
                </Button>
              )}
            </Card>
          ))}
          {steps.length < 8 && (
            <Button
              onClick={() =>
                setSteps((prev) => [...prev, { role: 'accountant', userId: '', label: '' }])
              }
            >
              Onay adımı ekle
            </Button>
          )}
        </div>
      </Sheet>
    </>
  );
}
