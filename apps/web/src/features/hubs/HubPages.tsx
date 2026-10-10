import { HubPage, lazyPage, type HubTab } from '../../components/layout/HubPage';

/**
 * Birleşik merkez sayfalar: aynı konuyu bölen ayrı menü öğeleri tek sayfada sekme olur. Sekme içeriği mevcut sayfanın kendisidir
 * (iş kuralı/izin değişmez); eski adresler router'da ilgili sekmeye yönlendirilir.
 */
const HR_TABS: HubTab[] = [
  { key: 'payroll', label: 'Bordro', module: 'hr.payroll', permission: 'hr.payroll', component: lazyPage(() => import('../hr/PayrollSettingsPage'), 'PayrollSettingsPage') },
  { key: 'social', label: 'SGK', module: 'hr.socialsecurity', permission: 'hr.payroll', component: lazyPage(() => import('../hr/SocialSettingsPage'), 'SocialSettingsPage') },
  { key: 'foreign', label: 'Yabancı işçi', module: 'hr.foreign', permission: 'hr.read', component: lazyPage(() => import('../hr/ForeignSettingsPage'), 'ForeignSettingsPage') },
];
export function HrSettingsHub() {
  return (
    <HubPage
      idPrefix="hr-settings"
      title="İK ve bordro ayarları"
      helpKey="hr-settings"
      description="Bordro parametreleri, SGK prim kuralları ve yabancı işçi belge ayarları tek yerde. Tarihli parametreler yalnız doğrulandıktan sonra kullanılır."
      tabs={HR_TABS}
    />
  );
}

const CASH_TABS: HubTab[] = [
  { key: 'forecast', label: 'Projeksiyon', module: 'core.treasury', permission: 'treasury.read', component: lazyPage(() => import('../treasury/CashForecastPage'), 'CashForecastPage') },
  { key: 'scenarios', label: 'Senaryolar', module: 'core.treasury', permission: 'treasury.read', component: lazyPage(() => import('../workspace/ScenariosPage'), 'ScenariosPage') },
];
export function CashPlanningHub() {
  return (
    <HubPage
      idPrefix="cash-planning"
      title="Nakit planlama"
      helpKey="cash-planning"
      description="Vadeli alacak, borç, çek ve taksitlerden üretilen nakit projeksiyonu ile “ya şöyle olursa” senaryoları."
      tabs={CASH_TABS}
    />
  );
}

const INTEGRATION_TABS: HubTab[] = [
  { key: 'channels', label: 'Kanal bağlantıları', module: 'core.integrations', permission: 'core.integrations.read', component: lazyPage(() => import('../manufacturing/ManufacturingPages'), 'ManufacturingIntegrationsPage') },
  { key: 'api', label: 'API ve webhook', module: 'core.integrations', permission: 'core.integrations.read', component: lazyPage(() => import('../settings/PlatformIntegrationsPage'), 'PlatformIntegrationsPage') },
];
export function IntegrationsHub() {
  return (
    <HubPage
      idPrefix="integrations"
      title="Entegrasyonlar"
      helpKey="integrations"
      description="Pazaryeri ve satış kanalı bağlantıları ile dış sistemler için API anahtarları ve webhook tanımları."
      tabs={INTEGRATION_TABS}
    />
  );
}

const DATA_TABS: HubTab[] = [
  { key: 'exchange', label: 'İçe ve dışa aktarma', module: 'core.settings', permission: 'workspace.use', component: lazyPage(() => import('../imports/FileExchangePage'), 'FileExchangePage') },
  { key: 'export', label: 'Tüm veriyi dışa aktar', module: 'core.settings', permission: 'data.export', component: lazyPage(() => import('../reports/DataExportPage'), 'DataExportPage') },
];
export function DataTransferHub() {
  return (
    <HubPage
      idPrefix="data-transfer"
      title="Veri aktarımı"
      helpKey="data-transfer"
      description="Excel/CSV ile toplu kayıt içe aktarma, liste dışa aktarma ve şirket verisinin tamamını yedek amaçlı dışa aktarma."
      tabs={DATA_TABS}
    />
  );
}

const EXPENSE_TABS: HubTab[] = [
  { key: 'entries', label: 'Gider fişleri', module: 'treasury.expenses', permission: 'treasury.read', component: lazyPage(() => import('../expenses/ExpenseEntriesPage'), 'ExpenseEntriesPage') },
  { key: 'cards', label: 'Gider türleri', module: 'treasury.expenses', permission: 'treasury.read', component: lazyPage(() => import('../expenses/ExpenseCardsPage'), 'ExpenseCardsPage') },
];
export function ExpensesHub() {
  return (
    <HubPage
      idPrefix="expenses"
      title="Giderler"
      helpKey="expense-entries"
      description="Kasa/bankadan ödenen giderlerin fişleri ve bu fişlerde kullanılan gider türleri (kartlar)."
      tabs={EXPENSE_TABS}
    />
  );
}
