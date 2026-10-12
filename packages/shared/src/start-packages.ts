import type { Sector } from './module-registry';
import type { Permission, Role } from './permissions';

/**
 * Sektör ve rol başlangıç paketleri (öneri 1, 2). Sektör paketi şirketin işine göre önerilen kurulum yolunu, rol paketi
 * kullanıcının ilk açtığı panoyu ve ilk görevlerini belirler. Modüller ayrıca sektöre göre açılır (module-registry);
 * paket yetki vermez: görev ve pano kartı yalnız kullanıcının izni varsa görünür.
 */
export interface StartTask { label: string; to: string; permission: Permission }
export interface RoleStart { focus: string; widgets: readonly string[]; tasks: readonly StartTask[] }
export interface SectorPackage { label: string; summary: string; tasks: readonly StartTask[] }

export const SECTOR_PACKAGES: Record<Sector, SectorPackage> = {
  COMMERCE: {
    label: 'Ticaret ve dağıtım',
    summary: 'Cari, stok, satış/alış faturası, kasa-banka ve cari mutabakat önce kurulur.',
    tasks: [
      { label: 'Müşteri ve tedarikçileri ekleyin ya da Excel ile aktarın', to: '/parties', permission: 'parties.manage' },
      { label: 'Stok kartlarını ve açılış miktarlarını girin', to: '/inventory/items', permission: 'inventory.manage' },
      { label: 'Banka hesabını açıp ekstre aktarın', to: '/treasury/accounts', permission: 'treasury.manage' },
    ],
  },
  RETAIL_MARKET: {
    label: 'Perakende ve market',
    summary: 'Kasa (POS), barkodlu stok kartları ve günlük kasa kapanışı önce kurulur.',
    tasks: [
      { label: 'Barkodlu stok kartlarını ekleyin ya da Excel ile aktarın', to: '/inventory/items', permission: 'inventory.manage' },
      { label: 'Kasa ayarlarını yapın', to: '/pos/settings', permission: 'pos.manage' },
      { label: 'İlk kasa satışını yapın', to: '/pos', permission: 'pos.sell' },
    ],
  },
  MANUFACTURING_WHOLESALE: {
    label: 'Üretim ve toptan',
    summary: 'Reçete ve rota, makine/kaynak takvimi, üretim emri ve kalite kontrol önce kurulur.',
    tasks: [
      { label: 'Ürün modeli, reçete ve operasyon rotasını tanımlayın', to: '/manufacturing/catalog', permission: 'manufacturing.catalog.manage' },
      { label: 'Makine/kaynak ve çalışma takvimini girin', to: '/manufacturing/planning', permission: 'manufacturing.planning.manage' },
      { label: 'İlk üretim emrini açın', to: '/manufacturing/production', permission: 'manufacturing.production.manage' },
    ],
  },
  LEATHER_FASHION: {
    label: 'Deri ve moda atölyesi',
    summary: 'Model ve kalıp, deri parti/parça takibi, kesim ve fason operasyonlar önce kurulur.',
    tasks: [
      { label: 'Model, koleksiyon ve reçeteyi tanımlayın', to: '/leather/models', permission: 'leather.catalog.manage' },
      { label: 'Deri partilerini girin', to: '/leather/materials', permission: 'leather.materials.manage' },
      { label: 'İlk kesim/üretim emrini açın', to: '/leather/production', permission: 'leather.production.manage' },
    ],
  },
  CONSTRUCTION: {
    label: 'İnşaat ve gayrimenkul',
    summary: 'Proje ve iş kırılımı, bütçe, taşeron sözleşmeleri ve hakediş önce kurulur.',
    tasks: [
      { label: 'Projeyi ve iş kırılımını oluşturun', to: '/projects', permission: 'projects.manage' },
      { label: 'Proje bütçesini girin', to: '/projects', permission: 'projects.budget' },
      { label: 'Taşeron sözleşmesini kaydedin', to: '/subcontracts', permission: 'subcontracts.manage' },
    ],
  },
};

/** Rol başına başlangıç panosu ve ilk görevler. Kayıtlı pano düzeni olan kullanıcıda pano değişmez. */
export const ROLE_STARTS: Record<Role, RoleStart> = {
  owner: {
    focus: 'Şirketi kurun, ekibi davet edin ve nakit/alacak durumunu izleyin.',
    widgets: ['start', 'setup', 'notifications', 'cash', 'receivables', 'overdue', 'month-sales', 'payables', 'sales-trend'],
    tasks: [{ label: 'Ekibi davet edin ve rollerini seçin', to: '/settings/members', permission: 'members.manage' }],
  },
  admin: {
    focus: 'Kurulumu tamamlayın, kullanıcıları ve onay kurallarını düzenleyin.',
    widgets: ['start', 'setup', 'notifications', 'cash', 'receivables', 'month-sales', 'draft-invoices'],
    tasks: [
      { label: 'Ekibi davet edin ve rollerini seçin', to: '/settings/members', permission: 'members.manage' },
      { label: 'Belge onay kurallarını belirleyin', to: '/settings/approvals', permission: 'settings.manage' },
    ],
  },
  accountant: {
    focus: 'Taslakları kaydedin, banka mutabakatını ve dönem kapanışını yürütün.',
    widgets: ['start', 'notifications', 'draft-invoices', 'journal', 'receivables', 'payables', 'cash', 'ledger-balance', 'fx-rates'],
    tasks: [
      { label: 'Hesap eşlemelerini kontrol edin', to: '/settings/account-mapping', permission: 'accounts.manage' },
      { label: 'Banka ekstresi aktarıp eşleştirin', to: '/treasury/accounts', permission: 'treasury.post' },
      { label: 'Dönem kapanış listesine bakın', to: '/settings/periods', permission: 'ledger.read' },
    ],
  },
  sales: {
    focus: 'Teklif ve faturaları hazırlayın, vadesi geçen alacakları takip edin.',
    widgets: ['start', 'notifications', 'month-sales', 'receivables', 'overdue', 'unbilled', 'draft-invoices', 'sales-trend'],
    tasks: [
      { label: 'Yeni satış faturası hazırlayın', to: '/invoices/new?type=sales', permission: 'invoices.manage' },
      { label: 'Müşteri kartlarını güncelleyin', to: '/parties', permission: 'parties.manage' },
    ],
  },
  site_manager: {
    focus: 'Mal kabul ve sevk irsaliyelerini işleyin, malzeme sarfını girin.',
    widgets: ['start', 'notifications', 'low-stock', 'stock-value', 'unbilled'],
    tasks: [
      { label: 'Mal kabul irsaliyesi girin', to: '/delivery-notes/new?type=purchase', permission: 'deliveries.manage' },
      { label: 'Stok sarfı ve transferi girin', to: '/inventory/movements', permission: 'inventory.move' },
    ],
  },
  operations_manager: {
    focus: 'Üretim, sevkiyat ve stok akışını planlayın.',
    widgets: ['start', 'notifications', 'low-stock', 'stock-value', 'unbilled', 'draft-invoices'],
    tasks: [{ label: 'Üretim planını kontrol edin', to: '/manufacturing/planning', permission: 'manufacturing.planning.read' }],
  },
  operator: {
    focus: 'Size atanan iş emirlerini ve atölye görevlerini tamamlayın.',
    widgets: ['start', 'notifications', 'low-stock'],
    tasks: [{ label: 'Atölye iş listesini açın', to: '/manufacturing/production', permission: 'manufacturing.production.read' }],
  },
  viewer: {
    focus: 'Şirketin nakit, alacak ve satış durumunu izleyin.',
    widgets: ['start', 'cash', 'receivables', 'month-sales', 'sales-trend'],
    tasks: [],
  },
};
