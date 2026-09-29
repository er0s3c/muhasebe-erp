import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api } from './api';
import { useCompany } from './session';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Aktif şirkete bağlı API çağırıcısı; sorgu anahtarları şirket kimliğini içerir. */
export function useCompanyApi() {
  const company = useCompany();
  return {
    company,
    call: <T>(path: string, opts: { method?: Method; body?: unknown } = {}) =>
      api<T>(path, { ...opts, companyId: company.id }),
  };
}

export function useCQuery<T>(key: QueryKey, path: string | null, opts: { enabled?: boolean } = {}) {
  const { company, call } = useCompanyApi();
  return useQuery<T>({
    queryKey: [company.id, ...key],
    queryFn: () => call<T>(path as string),
    enabled: path !== null && (opts.enabled ?? true),
  });
}

/** Başarıda verilen anahtar önekleriyle ilgili sorguları geçersiz kılar. */
export function useCMutation<TData, TVars>(
  fn: (vars: TVars, call: ReturnType<typeof useCompanyApi>['call']) => Promise<TData>,
  invalidate: QueryKey[] = [],
) {
  const { company, call } = useCompanyApi();
  const qc = useQueryClient();
  return useMutation<TData, Error, TVars>({
    mutationFn: (vars) => fn(vars, call),
    onSuccess: async () => {
      await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: [company.id, ...k] })));
    },
  });
}

export interface NavigationData {
  company: { id: string; name: string; sector: string; baseCurrency: string; reportingCurrency: string | null; allowNegativeStock: boolean };
  role: string;
  permissions: string[];
  modules: string[];
  groups: {
    key: string;
    labelKey: string;
    items: { key: string; labelKey: string; path: string; icon: string; module: string }[];
  }[];
}

export const useNavigation = () => useCQuery<NavigationData>(['navigation'], '/api/navigation');

export function useCan() {
  const { data } = useNavigation();
  return (permission: string) => data?.permissions.includes(permission) ?? false;
}
