import type { Role } from './permissions';
import type { AccessAreaKey, AccessLevel } from './module-access';

export interface ManufacturingProfile {
  key: string;
  label: string;
  role: Role;
  levels: Partial<Record<AccessAreaKey, AccessLevel>>;
}
export const MANUFACTURING_ACCESS_PROFILES: readonly ManufacturingProfile[] = [
  {
    key: 'planlama',
    label: 'Üretim planlama',
    role: 'operations_manager',
    levels: {
      'manufacturing.catalog': 'write',
      'manufacturing.mrp': 'write',
      'manufacturing.planning': 'write',
      'manufacturing.production': 'write',
      'manufacturing.subcontracting': 'write',
      'core.inventory': 'read',
      'core.procurement': 'read',
      'manufacturing.quality': 'read',
    },
  },
  {
    key: 'atolye',
    label: 'Atölye operatörü',
    role: 'operator',
    levels: {
      'manufacturing.catalog': 'read',
      'manufacturing.production': 'write',
      'manufacturing.quality': 'read',
    },
  },
  {
    key: 'depo',
    label: 'Depo sorumlusu',
    role: 'operator',
    levels: {
      'core.inventory': 'write',
      'inventory.wms': 'write',
      'sales.logistics': 'write',
      'manufacturing.production': 'read',
      'core.procurement': 'write',
      'core.invoices': 'read',
    },
  },
  {
    key: 'kalite',
    label: 'Kalite sorumlusu',
    role: 'operations_manager',
    levels: {
      'manufacturing.catalog': 'read',
      'manufacturing.production': 'read',
      'manufacturing.quality': 'write',
      'inventory.wms': 'write',
    },
  },
  {
    key: 'satis',
    label: 'Toptan satış',
    role: 'sales',
    levels: {
      'core.parties': 'write',
      'core.invoices': 'write',
      'core.inventory': 'read',
      'sales.logistics': 'read',
    },
  },
  {
    key: 'muhasebe',
    label: 'Üretim muhasebesi',
    role: 'accountant',
    levels: {
      'core.ledger': 'write',
      'core.parties': 'write',
      'core.treasury': 'write',
      'core.invoices': 'write',
      'core.inventory': 'read',
      'manufacturing.production': 'read',
      'manufacturing.costs': 'write',
      'core.procurement': 'read',
    },
  },
  {
    key: 'bakim',
    label: 'Bakım operatörü',
    role: 'operator',
    levels: {
      'manufacturing.maintenance': 'write',
      'core.inventory': 'read',
      'manufacturing.planning': 'read',
    },
  },
  { key: 'kasiyer', label: 'Mağaza kasiyeri', role: 'operator', levels: { 'sales.pos': 'write' } },
  {
    key: 'izleyici',
    label: 'Üretim izleyicisi',
    role: 'viewer',
    levels: {
      'manufacturing.catalog': 'read',
      'manufacturing.production': 'read',
      'manufacturing.planning': 'read',
      'manufacturing.mrp': 'read',
    },
  },
];
