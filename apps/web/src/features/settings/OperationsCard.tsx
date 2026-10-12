import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/license';

interface DbStats {
  current: {
    databaseBytes: number;
    tables: { table: string; seqScan: number; idxScan: number; liveRows: number; deadRows: number; sizeBytes: number }[];
    statements: { query: string; calls: number; totalMs: number; meanMs: number }[] | null;
    statementsAvailable: boolean;
  };
  lastSnapshotAt: string | null;
  trend: { table: string; sizeDelta: number; seqScanDelta: number; deadRows: number }[];
}
interface Slow {
  thresholdMs: number;
  requests: { at: string; traceId: string; method: string; route: string; status: number; durationMs: number }[];
}
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

/** Kurulum sahibi için işletim görünümü (öneri 113, 114): veritabanı büyüklüğü, tablo eğilimleri ve yavaş istekler. */
export function OperationsCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const stats = useQuery({ queryKey: ['system', 'db-stats'], queryFn: () => api<DbStats>('/api/system/db-stats'), retry: false });
  const slow = useQuery({ queryKey: ['system', 'slow-requests'], queryFn: () => api<Slow>('/api/system/slow-requests'), retry: false });
  const snapshot = useMutation({
    mutationFn: () => api('/api/system/db-stats/snapshot', { method: 'POST', body: {} }),
    onSuccess: async () => {
      toast.success('Anlık görüntü alındı; sonraki görüntüde eğilim hesaplanır');
      await qc.invalidateQueries({ queryKey: ['system', 'db-stats'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  // Sahip olmayan kullanıcıya kart gösterilmez
  if (stats.error || !stats.data) return null;
  const d = stats.data;
  return (
    <Card>
      <CardHeader
        title="İşletim ve performans"
        description="Veritabanı büyüklüğü, en büyük tablolar, son görüntüden bu yana eğilim ve yavaş istekler. Kiracı verisi gösterilmez."
        action={
          <Button size="sm" loading={snapshot.isPending} onClick={() => snapshot.mutate()}>
            Anlık görüntü al
          </Button>
        }
      />
      <div className="space-y-4 px-5 py-4 text-sm">
        <p>
          Veritabanı {mb(d.current.databaseBytes)}
          {d.lastSnapshotAt && <span className="text-muted"> · son görüntü {fmtDateTime(d.lastSnapshotAt)}</span>}
        </p>
        {d.trend.length > 0 && (
          <div>
            <h3 className="mb-1 font-medium">Son görüntüden bu yana</h3>
            <ul className="text-xs">
              {d.trend.slice(0, 8).map((t) => (
                <li key={t.table}>
                  {t.table}: büyüme {mb(t.sizeDelta)}, sıralı tarama +{t.seqScanDelta}
                  {t.deadRows > 1000 && <Badge tone="warning">ölü satır {t.deadRows}</Badge>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Tablo</Th>
                <Th num>Boyut</Th>
                <Th num>Satır</Th>
                <Th num>Sıralı / dizinli tarama</Th>
              </tr>
            </thead>
            <tbody>
              {d.current.tables.slice(0, 10).map((t) => (
                <Tr key={t.table}>
                  <Td className="font-mono text-xs">{t.table}</Td>
                  <Td num>{mb(t.sizeBytes)}</Td>
                  <Td num>{t.liveRows}</Td>
                  <Td num>
                    {t.seqScan} / {t.idxScan}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
        {!d.current.statementsAvailable && <Callout>Sorgu düzeyi istatistik için veritabanında pg_stat_statements eklentisini etkinleştirin.</Callout>}
        {slow.data && (
          <div>
            <h3 className="mb-1 font-medium">
              Yavaş istekler (≥ {slow.data.thresholdMs} ms, bu süreç başladığından beri)
            </h3>
            {slow.data.requests.length === 0 ? (
              <p className="text-muted">Kayıt yok.</p>
            ) : (
              <ul className="text-xs">
                {slow.data.requests.slice(0, 20).map((r) => (
                  <li key={r.traceId + r.at}>
                    {fmtDateTime(r.at)} · {r.method} {r.route} · {r.status} · {r.durationMs} ms · iz {r.traceId.slice(0, 8)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
