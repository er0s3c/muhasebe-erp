import { SearchX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/Feedback';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={<SearchX className="size-5" />}
      title={t('errorPage.notFoundTitle')}
      description={t('errorPage.notFoundDesc')}
      action={
        <Link to="/">
          <Button variant="primary">{t('common.goHome')}</Button>
        </Link>
      }
    />
  );
}
