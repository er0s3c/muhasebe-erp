import { lazy, Suspense, useMemo, type ComponentType, type LazyExoticComponent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../ui/Card';
import { EmptyState, PageLoading } from '../ui/Feedback';
import { SegmentedTabs, TabPanel } from '../ui/Tabs';
import { useNavigation } from '../../lib/queries';
import { EmbeddedContext } from './shellContext';

export interface HubTab {
  key: string;
  label: string;
  /** Sekmenin görünmesi için gereken izin ve modül (menü kaynağıyla aynı veri). */
  permission: string;
  module: string;
  component: LazyExoticComponent<ComponentType>;
}

/** Adlandırılmış dışa aktarımı tembel bileşene çevirir (her sekme kendi kod parçasında kalır). */
export function lazyPage<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  return lazy(async () => ({ default: (await load())[name] }));
}

export function HubPage({ title, description, helpKey, tabs, idPrefix }: { title: string; description: string; helpKey: string; tabs: HubTab[]; idPrefix: string }) {
  const { data } = useNavigation();
  const [params, setParams] = useSearchParams();
  const visible = useMemo(
    () => tabs.filter(tab => data?.modules.includes(tab.module) && data.permissions.includes(tab.permission) && data.moduleAccess[tab.module] !== 'none'),
    [tabs, data],
  );
  if (!data) return <PageLoading />;
  const requested = params.get('tab');
  const active = visible.find(tab => tab.key === requested) ?? visible[0];
  return (
    <>
      <PageHeader title={title} description={description} helpKey={helpKey} />
      {!active ? (
        <EmptyState title="Bu bölümü görüntüleme yetkiniz yok" description="Yöneticinizden ilgili modül ve izinleri açmasını isteyin." />
      ) : (
        <>
          {visible.length > 1 && (
            <SegmentedTabs
              id={`${idPrefix}-tabs`}
              label={`${title} bölümleri`}
              className="mb-6"
              items={visible.map(tab => ({ key: tab.key, label: tab.label }))}
              value={active.key}
              panelId={key => `${idPrefix}-panel-${key}`}
              onChange={key => {
                const next = new URLSearchParams(params);
                next.set('tab', key);
                setParams(next, { replace: true });
              }}
            />
          )}
          <TabPanel id={`${idPrefix}-panel-${active.key}`} labelledBy={visible.length > 1 ? `${idPrefix}-tabs-${active.key}` : undefined}>
            <EmbeddedContext.Provider value={true}>
              <Suspense fallback={<PageLoading />}>
                <active.component />
              </Suspense>
            </EmbeddedContext.Provider>
          </TabPanel>
        </>
      )}
    </>
  );
}
