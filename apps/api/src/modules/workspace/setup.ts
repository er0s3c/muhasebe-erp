import { sql } from 'drizzle-orm';
import { type Permission } from '@erp/shared';
import type { TenantCtx } from '../../http/context';

export async function setupChecklist(c: TenantCtx) {
  const definitions: {
    key: string;
    title: string;
    description: string;
    to: string;
    module: string;
    permission: Permission;
    query: ReturnType<typeof sql>;
  }[] = [
    {
      key: 'warehouse',
      title: 'Depoyu hazırlayın',
      description: 'Mal kabul ve stok hareketlerinin kullanılacağı depolar.',
      to: '/inventory/warehouses',
      module: 'core.inventory',
      permission: 'inventory.manage',
      query: sql`select exists(select 1 from warehouses) as done`,
    },
    {
      key: 'bank',
      title: 'Kasa / banka hesabı açın',
      description: 'Tahsilat ve ödemeler için para birimi ve muhasebe hesabını bağlayın.',
      to: '/treasury/accounts',
      module: 'core.treasury',
      permission: 'treasury.manage',
      query: sql`select exists(select 1 from treasury_accounts) as done`,
    },
    {
      key: 'customer',
      title: 'İlk cari kartını oluşturun',
      description: 'Müşteri ve tedarikçileri ekleyin veya içe aktarın.',
      to: '/parties',
      module: 'core.parties',
      permission: 'parties.manage',
      query: sql`select exists(select 1 from parties) as done`,
    },
    {
      key: 'first-invoice',
      title: 'İlk faturayı kaydedin',
      description: 'Taslak fatura hazırlayıp stok, cari ve muhasebe bağlantısını kontrol edin.',
      to: '/invoices',
      module: 'core.invoices',
      permission: 'invoices.manage',
      query: sql`select exists(select 1 from invoices where status='posted') as done`,
    },
    {
      key: 'mapping',
      title: 'Hesap eşlemelerini tanımlayın',
      description:
        'Fatura ve stok işlemlerindeki muhasebe hesaplarını kontrol edin. Tanımlı olması mali müşavir onayı anlamına gelmez.',
      to: '/settings/account-mapping',
      module: 'core.ledger',
      permission: 'accounts.manage',
      query: sql`select exists(select 1 from account_mappings) as done`,
    },
  ];
  // Sektör paketi adımları (öneri 1): şirketin işine özgü ilk kayıt
  const sectorSteps: Record<string, typeof definitions> = {
    CONSTRUCTION: [{ key: 'project', title: 'İlk projeyi oluşturun', description: 'Proje, iş kırılımı ve bütçe; maliyetler ve hakediş projeye bağlanır.', to: '/projects', module: 'construction.projects', permission: 'projects.manage', query: sql`select exists(select 1 from projects) as done` }],
    MANUFACTURING_WHOLESALE: [
      { key: 'catalog', title: 'Ürün reçetesini tanımlayın', description: 'Model, malzeme reçetesi ve operasyon rotası; üretim emri bunlardan açılır.', to: '/manufacturing/catalog', module: 'manufacturing.catalog', permission: 'manufacturing.catalog.manage', query: sql`select exists(select 1 from leather_models) as done` },
      { key: 'resource', title: 'Makine ve kaynakları girin', description: 'Kapasite planı ve termin, kaynakların çalışma takvimine göre hesaplanır.', to: '/manufacturing/planning', module: 'manufacturing.planning', permission: 'manufacturing.planning.manage', query: sql`select exists(select 1 from manufacturing_records where kind = 'resource') as done` },
    ],
    LEATHER_FASHION: [{ key: 'leather-model', title: 'İlk modeli tanımlayın', description: 'Model, kalıp ve deri reçetesi; kesim ve üretim emri buna bağlanır.', to: '/leather/models', module: 'leather.catalog', permission: 'leather.catalog.manage', query: sql`select exists(select 1 from leather_models) as done` }],
    RETAIL_MARKET: [{ key: 'pos-sale', title: 'İlk kasa satışını yapın', description: 'Kasa ayarları, barkod ve günlük kasa kapanışını deneyin.', to: '/pos', module: 'sales.pos', permission: 'pos.sell', query: sql`select exists(select 1 from pos_sales) as done` }],
  };
  definitions.push(...(sectorSteps[c.company.sector] ?? []));
  const steps = [];
  for (const d of definitions) {
    if (!c.enabledModules.has(d.module) || !c.can(d.permission)) continue;
    const r = await c.tx.execute<{ done: boolean }>(d.query);
    const { query: _query, module: _module, permission: _permission, ...step } = d;
    steps.push({ ...step, done: r.rows[0]?.done ?? false });
  }
  return { steps };
}
