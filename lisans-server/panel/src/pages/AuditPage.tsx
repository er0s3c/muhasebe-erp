import { useInfiniteQuery } from '@tanstack/react-query';
import { Button } from '@ui/Button';
import { PageHeader } from '@ui/Card';
import { EmptyState, PageLoading } from '@ui/Feedback';
import { Table, TableWrap, Td, Th, Tr } from '@ui/Table';
import { api, type AuditEntry } from '../api';
import { AUDIT_LABELS, fmtDateTime } from '../format';

const PAGE = 50;

export function AuditPage() {
  const { data, isPending, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['audit'],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api<{ entries: AuditEntry[] }>(`/admin/api/audit?limit=${PAGE}${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (last) => (last.entries.length === PAGE ? last.entries.at(-1)?.id : undefined),
  });
  if (isPending || !data) return <PageLoading />;
  const entries = data.pages.flatMap((p) => p.entries);

  return (
    <>
      <PageHeader title="Denetim kaydı" description="Yönetici ve komut satırı işlemleri ile kurulumların etkinleştirme olayları. Kayıtlar yalnızca eklenir, değiştirilemez." />
      {entries.length === 0 ? (
        <TableWrap>
          <EmptyState title="Kayıt yok" />
        </TableWrap>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Zaman</Th>
                <Th>İşlem</Th>
                <Th>Kaynak</Th>
                <Th>Hedef</Th>
                <Th>IP</Th>
                <Th>Ayrıntı</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <Tr key={e.id}>
                  <Td className="whitespace-nowrap">{fmtDateTime(e.at)}</Td>
                  <Td>{AUDIT_LABELS[e.action] ?? e.action}</Td>
                  <Td>{e.actor === 'admin' ? `yönetici ${e.adminId?.slice(0, 8) ?? ''}` : e.actor === 'cli' ? 'komut satırı' : e.actor === 'installation' ? 'kurulum' : e.actor}</Td>
                  <Td className="text-xs text-muted">{e.targetType ? `${e.targetType} ${e.targetId?.slice(0, 8) ?? ''}` : '—'}</Td>
                  <Td className="whitespace-nowrap text-muted">{e.ip ?? '—'}</Td>
                  <Td className="max-w-[280px] truncate text-xs text-muted" title={e.meta ? JSON.stringify(e.meta) : undefined}>
                    {e.meta ? JSON.stringify(e.meta) : '—'}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
      {hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            Daha eski kayıtlar
          </Button>
        </div>
      )}
    </>
  );
}
