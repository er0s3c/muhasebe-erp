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
  'reports.read',
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
    'reports.read',
  ],
  sales: ['settings.read'],
  site_manager: ['settings.read'],
  viewer: ['settings.read', 'ledger.read', 'reports.read'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
