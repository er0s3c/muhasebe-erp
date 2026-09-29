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
  'data.export',
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
  ],
  // Şantiye sorumlusu: malzeme sarfı/transferi/sayım girer, stok kartı açmaz; mal kabul (alış irsaliyesi)
  // ve sevk irsaliyesi işler, faturaya dokunmaz.
  site_manager: ['settings.read', 'inventory.read', 'inventory.move', 'deliveries.read', 'deliveries.manage', 'deliveries.post'],
  viewer: ['settings.read', 'ledger.read', 'parties.read', 'inventory.read', 'invoices.read', 'deliveries.read', 'treasury.read', 'reports.read'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
