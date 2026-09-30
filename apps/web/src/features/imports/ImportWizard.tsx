import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, FileSpreadsheet, TriangleAlert, Upload } from 'lucide-react';
import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  IMPORT_FIELDS,
  IMPORT_KIND_LABELS,
  IMPORT_LIMITS,
  todayIso,
  type ImportCommitResult,
  type ImportKind,
  type ImportParseResult,
  type ImportPreview,
  type ImportPreviewRow,
  type NumberFormat,
} from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th } from '../../components/ui/Table';
import { apiBlob } from '../../lib/api';
import { saveBlob } from '../../lib/download';
import { errorMessage } from '../../lib/errors';
import { useCompanyApi, useCQuery } from '../../lib/queries';
import type { Account } from '../../lib/types';

type Step = 'file' | 'map' | 'preview' | 'done';
const STEPS = ['file', 'map', 'preview', 'done'] as const;

/** Karşı hesap seçeneği gereken türler; yalnızca bu türlerde hesap listesi yüklenir. */
const NEEDS_OFFSET: readonly ImportKind[] = ['party_openings', 'ledger_openings'];
const NEEDS_DATE: readonly ImportKind[] = ['party_openings', 'stock_openings', 'ledger_openings'];
const NEEDS_SKIP: readonly ImportKind[] = ['parties', 'items'];
const NEEDS_CLOSING: readonly ImportKind[] = ['bank_statement'];
/** Önizleme tablosunda gösterilen en çok satır (yanıt zaten tüm satırları taşır; DOM'u şişirmemek için). */
const SHOW_ROWS = 500;

/** Tarayıcıdan dosyayı base64 olarak okur (data URL'nin sonek kısmı). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('Dosya okunamadı'));
    reader.readAsDataURL(file);
  });
}

interface Props {
  kind: ImportKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Her isteğe eklenen sabit seçenekler (örn. ekstrenin banka hesabı). */
  fixedOptions?: Record<string, unknown>;
  /** Önceki içe aktarmada kullanılan eşleme (alan → sütun başlığı): başlık aynıysa öneri yerine kullanılır. */
  previousMapping?: Record<string, string>;
  /** Başarılı içe aktarmadan sonra (sorgular zaten yenilenir). */
  onDone?: (result: ImportCommitResult) => void;
}

/**
 * Genel içe aktarma sihirbazı: dosya → sütun eşleme → ön izleme → sonuç. Sunucu durumsuzdur; her adımda
 * eşlenmiş satırlar yeniden gönderilir. Ön izleme ve gerçek içe aktarma aynı doğrulamayı çalıştırır ve tek bir
 * hata bile varsa hiçbir kayıt yazılmaz.
 */
export function ImportWizard({ kind, open, onOpenChange, fixedOptions, previousMapping, onDone }: Props) {
  const { t } = useTranslation();
  const { company, call } = useCompanyApi();
  const qc = useQueryClient();
  const fields = IMPORT_FIELDS[kind];

  const [step, setStep] = useState<Step>('file');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [fileB64, setFileB64] = useState('');
  const [parsed, setParsed] = useState<ImportParseResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [numberFormat, setNumberFormat] = useState<NumberFormat>('auto');
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [openingDate, setOpeningDate] = useState(`${todayIso().slice(0, 4)}-01-01`);
  const [offsetAccountId, setOffsetAccountId] = useState('');
  const [plugDifference, setPlugDifference] = useState(true);
  const [closingBalance, setClosingBalance] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [filter, setFilter] = useState<'all' | 'error' | 'skip'>('all');
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const accountsQuery = useCQuery<{ accounts: Account[] }>(['accounts'], '/api/accounts', { enabled: open && NEEDS_OFFSET.includes(kind) });
  const offsetAccounts = useMemo(
    () => (accountsQuery.data?.accounts ?? []).filter((a) => a.isPostable && a.isActive && !a.currencyCode && !a.partyControl),
    [accountsQuery.data],
  );

  const reset = () => {
    setStep('file');
    setBusy(false);
    setError(null);
    setNotice(null);
    setFileName('');
    setFileB64('');
    setParsed(null);
    setMapping({});
    setPreview(null);
    setFilter('all');
    setResult(null);
    setClosingBalance('');
    if (fileInput.current) fileInput.current.value = '';
  };
  const close = (o: boolean) => {
    if (!o) reset();
    onOpenChange(o);
  };

  const options = (): Record<string, unknown> => ({
    ...fixedOptions,
    numberFormat,
    ...(NEEDS_CLOSING.includes(kind)
      ? {
          fileName,
          ...(closingBalance.trim() ? { closingBalance: closingBalance.trim() } : {}),
          mapping: Object.fromEntries(fields.flatMap((f) => (mapping[f.key] === null || mapping[f.key] === undefined ? [] : [[f.key, parsed?.headers[mapping[f.key]!] ?? '']]))),
        }
      : {}),
    ...(NEEDS_SKIP.includes(kind) ? { skipDuplicates } : {}),
    ...(NEEDS_DATE.includes(kind) ? { openingDate } : {}),
    ...(NEEDS_OFFSET.includes(kind) && offsetAccountId ? { offsetAccountId } : {}),
    ...(kind === 'ledger_openings' ? { plugDifference } : {}),
  });

  /** Eşlenmiş sütunlardan alan anahtarlı satırlar; hiçbir eşli hücresi dolu olmayan satır atılır. */
  const mappedRows = () => {
    if (!parsed) return [];
    const out: { row: number; cells: Record<string, string> }[] = [];
    for (const r of parsed.rows) {
      const cells: Record<string, string> = {};
      for (const f of fields) {
        const idx = mapping[f.key];
        const v = idx === null || idx === undefined ? '' : (r.cells[idx] ?? '');
        if (v !== '') cells[f.key] = v;
      }
      if (Object.keys(cells).length > 0) out.push({ row: r.no, cells });
    }
    return out;
  };

  const parse = async (b64: string, name: string, sheet?: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await call<ImportParseResult>(`/api/imports/${kind}/parse`, { method: 'POST', body: { fileName: name, contentBase64: b64, sheet } });
      setParsed(res);
      // Önceki içe aktarmadaki eşleme (başlık aynıysa) önerinin önüne geçer
      const remembered = { ...res.suggestedMapping };
      for (const [key, header] of Object.entries(previousMapping ?? {})) {
        const idx = res.headers.indexOf(header);
        if (idx >= 0 && key in remembered) remembered[key] = idx;
      }
      setMapping(remembered);
      setNumberFormat(res.suggestedNumberFormat);
      setStep('map');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const takeFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > IMPORT_LIMITS.maxFileBytes) {
      setError(t('imports.file.tooLarge', { mb: Math.round(IMPORT_LIMITS.maxFileBytes / 1024 / 1024) }));
      return;
    }
    setBusy(true);
    try {
      const b64 = await readBase64(file);
      setFileName(file.name);
      setFileB64(b64);
      await parse(b64, file.name);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void takeFile(e.dataTransfer.files[0]);
  };

  const downloadTemplate = async (format: 'xlsx' | 'csv') => {
    try {
      const { blob, filename } = await apiBlob(`/api/imports/${kind}/template?format=${format}`, { companyId: company.id });
      saveBlob(blob, filename ?? `sablon.${format}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // --- Eşleme adımı doğrulaması --------------------------------------------------------------------------
  const missingRequired = fields.filter((f) => f.required && (mapping[f.key] === null || mapping[f.key] === undefined));
  const openingAmountMissing = kind === 'party_openings' && ['debit', 'credit', 'amount'].every((k) => mapping[k] === null || mapping[k] === undefined);
  const bankAmountMissing = kind === 'bank_statement' && ['amount', 'moneyIn', 'moneyOut'].every((k) => mapping[k] === null || mapping[k] === undefined);
  const canPreview = !missingRequired.length && !openingAmountMissing && !bankAmountMissing && (!NEEDS_DATE.includes(kind) || openingDate !== '');

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await call<ImportPreview>(`/api/imports/${kind}/preview`, { method: 'POST', body: { rows: mappedRows(), options: options() } });
      setPreview(res);
      setFilter(res.counts.error > 0 ? 'error' : 'all');
      setStep('preview');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await call<ImportCommitResult>(`/api/imports/${kind}/commit`, { method: 'POST', body: { rows: mappedRows(), options: options() } });
      setResult(res);
      setStep('done');
      await qc.invalidateQueries({ queryKey: [company.id] });
      onDone?.(res);
    } catch (e) {
      setError(errorMessage(e));
      // Ön izlemeden sonra veri değişmişse (örn. aynı anda başka kullanıcı) yeni ön izleme göster
      try {
        const res = await call<ImportPreview>(`/api/imports/${kind}/preview`, { method: 'POST', body: { rows: mappedRows(), options: options() } });
        setPreview(res);
        setNotice(t('imports.preview.changed'));
      } catch {
        /* ilk hata gösterilir */
      }
    } finally {
      setBusy(false);
    }
  };

  const shownRows: ImportPreviewRow[] = useMemo(() => {
    if (!preview) return [];
    const list = filter === 'all' ? preview.rows : preview.rows.filter((r) => r.status === filter);
    return list.slice(0, SHOW_ROWS);
  }, [preview, filter]);
  const filteredTotal = preview ? (filter === 'all' ? preview.rows.length : preview.rows.filter((r) => r.status === filter).length) : 0;

  const stepIndex = STEPS.indexOf(step);
  const title = `${IMPORT_KIND_LABELS[kind]} — ${t('imports.button')}`;

  let footer: ReactNode = null;
  if (step === 'map') {
    footer = (
      <>
        <Button onClick={() => setStep('file')}>{t('imports.map.back')}</Button>
        <Button variant="primary" loading={busy} disabled={!canPreview} onClick={() => void runPreview()}>
          {t('imports.map.next')}
        </Button>
      </>
    );
  } else if (step === 'preview') {
    footer = (
      <>
        <Button onClick={() => setStep('map')}>{t('imports.map.back')}</Button>
        <Button variant="primary" loading={busy} disabled={!preview?.canCommit} onClick={() => void commit()}>
          {t('imports.preview.commit')}
        </Button>
      </>
    );
  } else if (step === 'done') {
    footer = (
      <>
        <Button onClick={reset}>{t('imports.done.another')}</Button>
        <Button variant="primary" onClick={() => close(false)}>
          {t('imports.done.close')}
        </Button>
      </>
    );
  }

  return (
    <Sheet open={open} onOpenChange={close} title={title} description={t(`imports.descriptions.${kind}`)} wide footer={footer}>
      <ol className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" aria-label={title}>
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2" aria-current={s === step ? 'step' : undefined}>
            <span className={i <= stepIndex ? 'text-text' : 'text-muted'}>
              {i + 1}. {t(`imports.steps.${s}`)}
            </span>
            {i < STEPS.length - 1 && <span className="text-muted" aria-hidden>›</span>}
          </li>
        ))}
      </ol>

      {error && (
        <div className="mb-4">
          <Callout tone="danger">{error}</Callout>
        </div>
      )}
      {notice && (
        <div className="mb-4">
          <Callout tone="warning">{notice}</Callout>
        </div>
      )}

      {step === 'file' && (
        <div className="flex flex-col gap-5">
          <h3 className="text-base">{t('imports.file.title')}</h3>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-10 text-center ${dragging ? 'border-text bg-surface-2' : 'border-border-strong'}`}
          >
            <span className="flex size-11 items-center justify-center rounded-xl bg-surface-2">
              <Upload className="size-5" aria-hidden />
            </span>
            <p className="text-sm">{busy ? t('imports.file.reading') : t('imports.file.drop')}</p>
            <p className="max-w-md text-xs text-muted">
              {t('imports.file.hint', { rows: IMPORT_LIMITS.maxRows.toLocaleString('tr-TR'), mb: Math.round(IMPORT_LIMITS.maxFileBytes / 1024 / 1024) })}
            </p>
            <input
              ref={fileInput}
              id={`import-file-${kind}`}
              type="file"
              className="sr-only"
              accept=".xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => void takeFile(e.target.files?.[0])}
              aria-label={t('imports.file.choose')}
            />
            <Button variant="primary" loading={busy} onClick={() => fileInput.current?.click()}>
              <FileSpreadsheet className="size-4" aria-hidden />
              {t('imports.file.choose')}
            </Button>
          </div>

          <div className="rounded-2xl border border-border p-4">
            <p className="text-sm">{t('imports.file.templateTitle')}</p>
            <p className="mt-1 text-[13px] text-muted">{t('imports.file.templateHint')}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => void downloadTemplate('xlsx')}>
                <Download className="size-4" aria-hidden />
                {t('imports.file.templateXlsx')}
              </Button>
              <Button onClick={() => void downloadTemplate('csv')}>
                <Download className="size-4" aria-hidden />
                {t('imports.file.templateCsv')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {step === 'map' && parsed && (
        <div className="flex flex-col gap-5">
          <div>
            <h3 className="text-base">{t('imports.map.title')}</h3>
            <p className="mt-1 text-[13px] text-muted">{t('imports.map.hint')}</p>
            <p className="mt-1 text-xs text-muted">
              {fileName} · {t('imports.map.rows', { count: parsed.rows.length })}
            </p>
          </div>

          {parsed.sheets.length > 1 && (
            <Field label={t('imports.map.sheet')}>
              {(id) => (
                <Select id={id} value={parsed.sheet ?? ''} onChange={(e) => void parse(fileB64, fileName, e.target.value)} disabled={busy}>
                  {parsed.sheets.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-1/3">{t('imports.map.field')}</Th>
                  <Th>{t('imports.map.column')}</Th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => {
                  const idx = mapping[f.key];
                  const sample = idx === null || idx === undefined ? '' : (parsed.rows.find((r) => (r.cells[idx] ?? '') !== '')?.cells[idx] ?? '');
                  return (
                    <tr key={f.key}>
                      <Td>
                        <label htmlFor={`map-${f.key}`} className="block">
                          {f.label}
                          {f.required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
                        </label>
                        {f.hint && <span className="block text-xs text-muted">{f.hint}</span>}
                      </Td>
                      <Td>
                        <Select
                          id={`map-${f.key}`}
                          value={idx === null || idx === undefined ? '' : String(idx)}
                          onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value === '' ? null : Number(e.target.value) })}
                        >
                          <option value="">{t('imports.map.notMapped')}</option>
                          {parsed.headers.map((h, i) => (
                            <option key={i} value={i}>
                              {h}
                            </option>
                          ))}
                        </Select>
                        {sample && <span className="mt-1 block truncate text-xs text-muted">{t('imports.map.sample', { value: sample })}</span>}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>

          {(missingRequired.length > 0 || openingAmountMissing || bankAmountMissing) && (
            <Callout tone="warning">
              {missingRequired.length > 0
                ? t('imports.map.requiredMissing', { fields: missingRequired.map((f) => f.label).join(', ') })
                : bankAmountMissing
                  ? t('imports.map.bankAmountMissing')
                  : t('imports.map.openingAmountMissing')}
            </Callout>
          )}

          <div className="rounded-2xl border border-border p-4">
            <h3 className="mb-3 text-base">{t('imports.map.options')}</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('imports.map.numberFormat')} hint={t('imports.map.numberFormatHint')}>
                {(id) => (
                  <Select id={id} value={numberFormat} onChange={(e) => setNumberFormat(e.target.value as NumberFormat)}>
                    <option value="auto">{t('imports.map.numberFormats.auto')}</option>
                    <option value="tr">{t('imports.map.numberFormats.tr')}</option>
                    <option value="en">{t('imports.map.numberFormats.en')}</option>
                  </Select>
                )}
              </Field>
              {NEEDS_DATE.includes(kind) && (
                <Field label={t('imports.map.openingDate')} hint={t('imports.map.openingDateHint')} required>
                  {(id) => <Input id={id} type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} />}
                </Field>
              )}
              {NEEDS_CLOSING.includes(kind) && (
                <Field label={t('imports.map.closingBalance')} hint={t('imports.map.closingBalanceHint')}>
                  {(id) => <Input id={id} inputMode="decimal" value={closingBalance} onChange={(e) => setClosingBalance(e.target.value)} placeholder="0,00" />}
                </Field>
              )}
              {NEEDS_OFFSET.includes(kind) && (
                <Field label={t('imports.map.offsetAccount')}>
                  {(id) => (
                    <Select id={id} value={offsetAccountId} onChange={(e) => setOffsetAccountId(e.target.value)}>
                      <option value="">{t('imports.map.offsetDefault')}</option>
                      {offsetAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} {a.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
            </div>
            <div className="mt-4 flex flex-col gap-3">
              {NEEDS_SKIP.includes(kind) && (
                <label className="flex items-start gap-2.5 text-sm">
                  <input type="checkbox" className="mt-1 size-4" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} />
                  <span>
                    {t('imports.map.skipDuplicates')}
                    <span className="block text-xs text-muted">{t('imports.map.skipDuplicatesHint')}</span>
                  </span>
                </label>
              )}
              {kind === 'ledger_openings' && (
                <label className="flex items-start gap-2.5 text-sm">
                  <input type="checkbox" className="mt-1 size-4" checked={plugDifference} onChange={(e) => setPlugDifference(e.target.checked)} />
                  <span>
                    {t('imports.map.plugDifference')}
                    <span className="block text-xs text-muted">{t('imports.map.plugDifferenceHint')}</span>
                  </span>
                </label>
              )}
            </div>
          </div>
        </div>
      )}

      {step === 'preview' && preview && (
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="text-base">{t('imports.preview.title')}</h3>
            <p className="mt-1 text-[13px] text-muted">{t('imports.preview.hint')}</p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ['total', preview.counts.total],
                ['willImport', preview.counts.ok],
                ['willSkip', preview.counts.skip],
                ['errors', preview.counts.error],
              ] as const
            ).map(([key, n]) => (
              <div key={key} className="rounded-xl border border-border px-4 py-3">
                <p className="text-xs text-muted">{t(`imports.preview.${key}`)}</p>
                <p className={`mt-1 text-xl tabular-nums ${key === 'errors' && n > 0 ? 'text-danger' : ''}`}>{n.toLocaleString('tr-TR')}</p>
              </div>
            ))}
          </div>

          {preview.summary.length > 0 && (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-xl bg-surface-2 px-4 py-3 text-sm sm:grid-cols-2">
              {preview.summary.map((s) => (
                <div key={s.label} className="flex justify-between gap-3">
                  <dt className="text-muted">{s.label}</dt>
                  <dd className="text-right tabular-nums">{s.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {preview.general.map((m, i) => (
            <Callout key={i} tone={m.severity === 'error' ? 'danger' : 'warning'}>
              {m.message}
            </Callout>
          ))}
          {!preview.canCommit &&
            (preview.counts.error > 0 || preview.general.some((m) => m.severity === 'error') ? (
              <Callout tone="danger" title={t('imports.preview.errors')}>
                {t('imports.preview.blocked')}
              </Callout>
            ) : (
              <Callout tone="warning">{t('imports.preview.nothing')}</Callout>
            ))}

          <SegmentedTabs
            value={filter}
            onChange={setFilter}
            items={[
              { key: 'all', label: t('imports.preview.filterAll') },
              { key: 'error', label: `${t('imports.preview.filterErrors')} (${preview.counts.error})` },
              { key: 'skip', label: `${t('imports.preview.filterSkipped')} (${preview.counts.skip})` },
            ]}
          />

          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-16">{t('imports.preview.row')}</Th>
                  <Th className="w-28">{t('imports.preview.status')}</Th>
                  <Th>{t('imports.preview.record')}</Th>
                  <Th>{t('imports.preview.messages')}</Th>
                </tr>
              </thead>
              <tbody>
                {shownRows.length === 0 && (
                  <tr>
                    <Td colSpan={4} className="py-8 text-center text-muted">
                      {t('imports.preview.noRows')}
                    </Td>
                  </tr>
                )}
                {shownRows.map((r) => (
                  <tr key={r.row}>
                    <Td className="tabular-nums text-muted">{r.row}</Td>
                    <Td>
                      <Badge tone={r.status === 'ok' ? 'success' : r.status === 'skip' ? 'neutral' : 'danger'}>
                        {r.status === 'error' && <TriangleAlert className="mr-1 size-3" aria-hidden />}
                        {t(r.status === 'ok' ? 'imports.preview.statusOk' : r.status === 'skip' ? 'imports.preview.statusSkip' : 'imports.preview.statusError')}
                      </Badge>
                    </Td>
                    <Td className="max-w-56 truncate">{r.label}</Td>
                    <Td>
                      {r.messages.map((m, i) => (
                        <span key={i} className={`block text-[13px] ${m.severity === 'error' ? 'text-danger' : m.severity === 'warning' ? 'text-warning' : 'text-muted'}`}>
                          {m.message}
                        </span>
                      ))}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          {filteredTotal > SHOW_ROWS && <p className="text-xs text-muted">{t('imports.preview.showing', { shown: SHOW_ROWS, total: filteredTotal })}</p>}
        </div>
      )}

      {step === 'done' && result && (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-6 shrink-0 text-success" aria-hidden />
            <div>
              <h3 className="text-base">{t('imports.done.title')}</h3>
              <p className="mt-1 text-sm text-muted">{t('imports.done.created', { count: result.created, skipped: result.skipped })}</p>
            </div>
          </div>
          {result.summary.length > 0 && (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-xl bg-surface-2 px-4 py-3 text-sm sm:grid-cols-2">
              {result.summary.map((s) => (
                <div key={s.label} className="flex justify-between gap-3">
                  <dt className="text-muted">{s.label}</dt>
                  <dd className="text-right tabular-nums">{s.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {result.entries.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm">
              {result.entries.map((e) => (
                <li key={e.id}>
                  <span className="text-muted">{e.type === 'journal' ? t('imports.done.journal') : t('imports.done.stock')}: </span>
                  {e.type === 'journal' ? (
                    <Link to={`/accounting/journal?open=${e.id}`} className="link font-mono text-[13px]" onClick={() => close(false)}>
                      {e.no}
                    </Link>
                  ) : (
                    <span className="font-mono text-[13px]">{e.no}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {result.entries.some((e) => e.type === 'journal') && <p className="text-xs text-muted">{t('imports.done.undoHint')}</p>}
        </div>
      )}
    </Sheet>
  );
}
