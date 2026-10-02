export const PERMISSIONS = [
  'company.manage',
  'members.manage',
  'settings.read',
  'settings.manage',
  'rates.manage',
  'accounts.manage',
  'ledger.read',
  'ledger.post',
  'ledger.close_period',
  'parties.read',
  'parties.manage',
  'inventory.read',
  'inventory.manage',
  'inventory.move',
  'invoices.read',
  'invoices.manage',
  'invoices.post',
  'deliveries.read',
  'deliveries.manage',
  'deliveries.post',
  'treasury.read',
  'treasury.manage',
  'treasury.post',
  'reports.read',
  // Çoklu şirket konsolidasyonu (Faz X7): birden çok şirketin verisini bir arada gösterir; yalnızca sahip ve yönetici
  'reports.consolidation',
  'data.export',
  'projects.read',
  'projects.manage',
  'projects.budget',
  'subcontracts.read',
  'subcontracts.manage',
  'subcontracts.approve',
  'procurement.read',
  'procurement.manage',
  'procurement.approve',
  'realestate.read',
  'realestate.manage',
  'realestate.approve',
  // İnsan kaynakları ve kişisel veri (Faz D)
  'hr.read',
  'hr.manage',
  'hr.sensitive',
  'privacy.manage',
  // Bordro (Faz D3): ücret verisi hr.sensitive'ten ayrı, ayrı izinle açılır
  'hr.payroll',
  'hr.payroll_manage',
  // Rehber ve ajanda (Faz X6): üçüncü kişilerin kişisel verisi içerir; izleyici rolüne verilmez
  'directory.read',
  'directory.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['owner', 'admin', 'accountant', 'sales', 'site_manager', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/**
 * MVP'de roller kod içinde hazır şablonlardır. Özel rol tablosu, ilgili modüller
 * (satış, şantiye) eklendiğinde ve gerçekten ihtiyaç doğduğunda gelecek.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter((p) => p !== 'company.manage'),
  accountant: [
    'settings.read',
    'rates.manage',
    'accounts.manage',
    'ledger.read',
    'ledger.post',
    'ledger.close_period',
    'parties.read',
    'parties.manage',
    'inventory.read',
    'inventory.manage',
    'inventory.move',
    'invoices.read',
    'invoices.manage',
    'invoices.post',
    'deliveries.read',
    'deliveries.manage',
    'deliveries.post',
    'treasury.read',
    'treasury.manage',
    'treasury.post',
    'reports.read',
    'data.export',
    'projects.read',
    'projects.manage',
    'projects.budget',
    'subcontracts.read',
    'subcontracts.manage',
    'subcontracts.approve',
    'procurement.read',
    'procurement.manage',
    'procurement.approve',
    'realestate.read',
    'realestate.manage',
    'realestate.approve',
    'hr.read',
    'hr.payroll',
    'hr.payroll_manage',
    'directory.read',
  ],
  // Satış temsilcisi: müşteri kartı ve cari hareketleri yönetir (kapsam belgesi, Modül 13)
  // Faturayı taslak olarak hazırlar; muhasebeleştirmeyi (invoices.post) muhasebeci yapar.
  // İrsaliyeyi de taslak olarak hazırlar; stok hareketini işleyen (deliveries.post) depo/şantiye/muhasebedir.
  sales: [
    'settings.read',
    'parties.read',
    'parties.manage',
    'inventory.read',
    'inventory.manage',
    'invoices.read',
    'invoices.manage',
    'deliveries.read',
    'deliveries.manage',
    'directory.read',
    'directory.manage',
  ],
  // Şantiye sorumlusu: malzeme sarfı/transferi/sayım girer, stok kartı açmaz; mal kabul (alış irsaliyesi)
  // ve sevk irsaliyesi işler, faturaya dokunmaz.
  // Proje: şantiye şefi proje/iş kalemi/ilerleme girer; bütçeyi (projects.budget) muhasebe/yönetim onaylar.
  site_manager: [
    'settings.read',
    'inventory.read',
    'inventory.move',
    'deliveries.read',
    'deliveries.manage',
    'deliveries.post',
    'projects.read',
    'projects.manage',
    'subcontracts.read',
    'subcontracts.manage',
    'procurement.read',
    'procurement.manage',
    'realestate.read',
    'directory.read',
    'directory.manage',
  ],
  viewer: ['settings.read', 'ledger.read', 'parties.read', 'inventory.read', 'invoices.read', 'deliveries.read', 'treasury.read', 'reports.read', 'projects.read', 'subcontracts.read', 'procurement.read', 'realestate.read'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
