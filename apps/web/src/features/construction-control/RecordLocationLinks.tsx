import { Link } from 'react-router-dom';
import { useCQuery, useModuleEnabled } from '../../lib/queries';
export function RecordLocationLinks({ id, kind }: { id: string; kind: string }) {
  const enabled = useModuleEnabled('construction.projects');
  const data = useCQuery<{
    items: {
      id: string;
      drawingId: string;
      code: string;
      revision: string;
      projectId: string;
      page: number;
      location: string | null;
    }[];
  }>(
    ['control', 'record-links', id],
    enabled &&
      ['rfi', 'quality_check', 'safety', 'defect', 'site_report', 'site_instruction'].includes(kind)
      ? `/api/construction/record-links?kind=${kind}&id=${id}`
      : null,
    { allowForbidden: true },
  );
  if (!data.data?.items.length) return null;
  return (
    <div className="flex flex-wrap gap-3 text-sm">
      {data.data.items.map((p) => (
        <Link
          key={p.id}
          className="underline"
          to={`/workspace/project-control?projectId=${p.projectId}&tab=drawings&drawingId=${p.drawingId}&page=${p.page}&pin=${p.id}`}
        >
          Plan konumu: {p.code} / {p.revision} · Sayfa {p.page}
          {p.location ? ` · ${p.location}` : ''}
        </Link>
      ))}
    </div>
  );
}
