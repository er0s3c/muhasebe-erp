import { useMemo, useState } from 'react';
import { dec, type BankLine, type LedgerCandidate } from '@erp/shared';
import { ErrorCallout } from '../../components/layout/Blocked';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Sheet';
import { formatDateTR, money } from '../../lib/format';
import { useCMutation } from '../../lib/queries';

/**
 * Çoktan bire banka eşleştirmesi (öneri 55): ekstre satırını (ör. toplu yatırılan tahsilatlar) toplamı tutarına eşit birden
 * çok defter satırıyla eşleştirme. Yalnız ekstre satırıyla aynı yöndeki (giriş/çıkış) eşleşmemiş defter satırları listelenir.
 */
export function GroupMatchDialog({ line, candidates, onClose, onMatched }: { line: BankLine | null; candidates: readonly LedgerCandidate[]; onClose: () => void; onMatched: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const match = useCMutation((ids: string[], call) => call(`/api/bank-statement-lines/${line!.id}/match-group`, { method: 'POST', body: { journalLineIds: ids } }), [['treasury']]);
  const inflow = line ? dec(line.amount).gt(0) : true;
  const list = useMemo(() => candidates.filter((c) => (inflow ? dec(c.amount).gt(0) : dec(c.amount).lt(0))), [candidates, inflow]);
  const total = picked.reduce((sum, id) => sum.plus(list.find((c) => c.journalLineId === id)?.amount ?? 0), dec(0));
  const remaining = line ? dec(line.amount).minus(total) : dec(0);
  const exact = picked.length >= 2 && remaining.isZero();

  return (
    <Modal open={!!line} onOpenChange={(o) => { if (!o) { setPicked([]); setError(null); onClose(); } }} title="Birden çok kayıtla eşleştir"
      description={line ? `${formatDateTR(line.txnDate)} · ${line.description} · ${money(line.amount)}` : undefined}
      footer={<>
        <Button onClick={() => { setPicked([]); setError(null); onClose(); }}>Vazgeç</Button>
        <Button variant="primary" disabled={!exact} loading={match.isPending} onClick={() => match.mutate(picked, {
          onSuccess: () => { setPicked([]); onMatched(); },
          onError: setError,
        })}>Eşleştir</Button>
      </>}>
      <div className="flex flex-col gap-3" data-form-guard="off">
        {error != null && <ErrorCallout error={error} />}
        <p className={exact ? 'text-sm text-success' : 'text-sm text-muted'} aria-live="polite">
          Seçilen {picked.length} kayıt: {money(total.toFixed(2))} · kalan {money(remaining.toFixed(2))}
        </p>
        {list.length === 0 ? <p className="text-sm text-muted">Bu yönde eşleşmemiş defter satırı yok.</p> : (
          <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {list.map((c) => (
              <li key={c.journalLineId}>
                <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2">
                  <input type="checkbox" className="size-4" checked={picked.includes(c.journalLineId)}
                    onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, c.journalLineId] : cur.filter((id) => id !== c.journalLineId)))} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{c.description}</span>
                    <span className="block text-xs text-muted">{formatDateTR(c.entryDate)} · {c.entryNo}{c.txnNo ? ` · ${c.txnNo}` : ''}{c.partyName ? ` · ${c.partyName}` : ''}</span>
                  </span>
                  <span className="num shrink-0">{money(c.amount)}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
