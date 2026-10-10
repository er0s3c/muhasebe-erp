import { useSession } from '../../lib/session';
import { useActiveBranch } from '../../lib/branch';
import { SavedViews, savedViewsKey, type ViewFilters } from '../ui/SavedViews';

export function CompanySavedViews({ page, filters, onApply }: { page: string; filters: ViewFilters; onApply: (filters: ViewFilters) => void }) {
  const { user, activeCompany } = useSession();
  const branch = useActiveBranch(activeCompany?.id ?? 'none');
  if (!user || !activeCompany) return null;
  const scope = [user.id, activeCompany.id, branch, page];
  return <SavedViews key={savedViewsKey(scope)} scope={scope} filters={filters} onApply={onApply} />;
}
