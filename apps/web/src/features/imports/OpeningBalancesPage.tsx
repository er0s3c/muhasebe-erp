import { Upload } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ImportKind } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { useCan, useNavigation } from '../../lib/queries';
import { ImportWizard } from './ImportWizard';

type OpeningKind = Extract<ImportKind, 'party_openings' | 'stock_openings' | 'ledger_openings'>;

/** Sekme → gereken modül ve izin (sunucu uçlarıyla aynı). */
const OPENINGS: readonly { kind: OpeningKind; module: string; permission: string }[] = [
  { kind: 'party_openings', module: 'core.ledger', permission: 'ledger.post' },
  { kind: 'stock_openings', module: 'core.inventory', permission: 'inventory.move' },
  { kind: 'ledger_openings', module: 'core.ledger', permission: 'ledger.post' },
];

const RULE_KEYS = {
  party_openings: ['openings.rules.party_openings.r1', 'openings.rules.party_openings.r2', 'openings.rules.party_openings.r3', 'openings.rules.party_openings.r4'],
  stock_openings: ['openings.rules.stock_openings.r1', 'openings.rules.stock_openings.r2', 'openings.rules.stock_openings.r3'],
  ledger_openings: ['openings.rules.ledger_openings.r1', 'openings.rules.ledger_openings.r2', 'openings.rules.ledger_openings.r3', 'openings.rules.ledger_openings.r4'],
} as const;

/** Açılış bakiyeleri: cari, stok ve genel mizan açılışı için içe aktarma girişleri ve kısa kurallar. */
export function OpeningBalancesPage() {
  const { t } = useTranslation();
  const can = useCan();
  const { data: nav } = useNavigation();
  const available = OPENINGS.filter((o) => can(o.permission) && (nav?.modules ?? []).includes(o.module));
  const [selected, setSelected] = useState<OpeningKind>('party_openings');
  const [importing, setImporting] = useState(false);
  const active = available.find((o) => o.kind === selected) ?? available[0];

  return (
    <>
      <PageHeader title={t('openings.title')} description={t('openings.subtitle')} />
      {!active ? (
        <Callout tone="warning">{t('openings.noAccess')}</Callout>
      ) : (
        <div className="flex flex-col gap-5">
          <SegmentedTabs
            value={active.kind}
            onChange={setSelected}
            items={available.map((o) => ({ key: o.kind, label: t(`openings.tabs.${o.kind}`) }))}
          />
          <Card>
            <CardHeader
              title={t(`openings.tabs.${active.kind}`)}
              description={t(`imports.descriptions.${active.kind}`)}
              action={
                <Button variant="primary" onClick={() => setImporting(true)}>
                  <Upload className="size-4" aria-hidden />
                  {t('imports.button')}
                </Button>
              }
            />
            <div className="px-5 py-4">
              <h3 className="mb-2 text-sm">{t('openings.rulesTitle')}</h3>
              <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted">
                {RULE_KEYS[active.kind].map((key) => (
                  <li key={key}>{t(key)}</li>
                ))}
              </ul>
            </div>
          </Card>
          <p className="text-xs text-muted">{t('openings.order')}</p>
          <p className="text-xs text-muted">{t('openings.reverseHint')}</p>
          <ImportWizard kind={active.kind} open={importing} onOpenChange={setImporting} />
        </div>
      )}
    </>
  );
}
