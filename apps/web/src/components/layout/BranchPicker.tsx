import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { BranchContext } from '@erp/shared';
import { Select } from '../ui/Field';
import { useCompanyApi, useCQuery } from '../../lib/queries';
import { setActiveBranch, useActiveBranch } from '../../lib/branch';
import { useUnsavedChanges } from '../ui/UnsavedChanges';

export function BranchPicker({ mobile = false }: { mobile?: boolean }) {
  const { company } = useCompanyApi();
  const active = useActiveBranch(company.id);
  const queryClient = useQueryClient();
  const [changing, setChanging] = useState(false);
  const { confirmLeave } = useUnsavedChanges();
  const { data } = useCQuery<{
    branches: { id: string; name: string; isActive: boolean }[];
    scope: BranchContext;
  }>(['branches', 'picker'], '/api/company/branches', {
    branchId: 'all',
    refetchOnWindowFocus: true,
  });
  if (!data?.branches.length) return null;
  const choices = data.branches.filter(
    (branch) => data.scope.mode === 'all' || data.scope.branchIds.includes(branch.id),
  );
  const allowed =
    active === 'all' ||
    (active === 'unassigned' && data.scope.allowUnassigned) ||
    choices.some((branch) => branch.id === active);
  const picker = (
    <Select
      className={mobile ? 'min-w-0 flex-1 text-xs' : 'w-40 shrink-0 text-xs'}
      aria-label="Aktif şube"
      value={allowed ? active : ''}
      disabled={changing}
      onChange={async (event) => {
        const value = event.target.value;
        await confirmLeave(async () => {
        setChanging(true);
        try {
          await queryClient.cancelQueries({ queryKey: [company.id] });
          queryClient.removeQueries({
            queryKey: [company.id],
            predicate: (query) => !query.queryKey.includes('picker'),
          });
          setActiveBranch(company.id, value);
        } finally {
          setChanging(false);
        }
        });
      }}
    >
      {!allowed && (
        <option value="" disabled>
          Şube erişimi değişti
        </option>
      )}
      <option value="all">{data.scope.mode === 'all' ? 'Tüm şubeler' : 'İzinli şubeler'}</option>
      {data.scope.allowUnassigned && <option value="unassigned">Şubeye atanmamış</option>}
      {choices.map((branch) => (
        <option key={branch.id} value={branch.id}>
          {branch.name}
          {branch.isActive ? '' : ' · pasif'}
        </option>
      ))}
    </Select>
  );
  return mobile ? <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-2 text-xs text-muted sm:hidden print:hidden"><span>Çalışılan şube</span>{picker}</div> : picker;
}
