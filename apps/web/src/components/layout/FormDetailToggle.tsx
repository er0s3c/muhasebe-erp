import { SegmentedTabs } from '../ui/Tabs';
import type { FormDetailMode } from '../../lib/personal';

/** Formun temel/ayrıntılı görünüm seçici (öneri 24). Seçim hesapta saklanır; başka cihazda da aynı açılır. */
export function FormDetailToggle({ mode, onChange }: { mode: FormDetailMode; onChange: (mode: FormDetailMode) => void }) {
  return <div className="flex items-center gap-2" data-form-guard="off">
    <span className="text-xs text-muted">Form</span>
    <SegmentedTabs variant="filter" label="Form görünümü" value={mode} onChange={onChange}
      items={[{ key: 'basic', label: 'Temel' }, { key: 'detailed', label: 'Ayrıntılı' }]} />
  </div>;
}
