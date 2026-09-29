import { SearchX } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/Feedback';

export function NotFoundPage() {
  return (
    <EmptyState
      icon={<SearchX className="size-5" />}
      title="Sayfa bulunamadı"
      description="Aradığınız sayfa taşınmış ya da hiç var olmamış olabilir."
      action={
        <Link to="/">
          <Button variant="primary">Ana sayfaya dön</Button>
        </Link>
      }
    />
  );
}
