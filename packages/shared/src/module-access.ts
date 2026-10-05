import { MODULES } from './module-registry';
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission, type PermissionSet, type Role } from './permissions';

/**
 * KULLANICI BAZLI MODÜL ERİŞİMİ: sahip ve yönetici, her üye için her ERİŞİM ALANINDA (menüde görünen modül grubu) üç düzeyden
 * birini seçebilir:
 *   none  = Erişim yok (menüde görünmez, sayfa yetki ekranı, API 403 MODULE_ACCESS_DENIED)
 *   read  = Sadece görüntüle (alanın okuma izinleri; yazma izinleri alınır)
 *   write = Görüntüle ve düzenle (alanın okuma + yazma izinleri; rolün olmayan izinleri de eklenir)
 * Kayıt yoksa "rol varsayılanı" geçerlidir. Etkin izin kümesi `effectivePermissions` ile hesaplanır ve izin denetiminin TEK kaynağıdır.
 *
 * Neden "alan"? Birkaç kayıt modülü aynı izni paylaşır (ör. çek/senet, teminat ve gider kartları `treasury.*` izinlerini kullanır; teklif
 * ve fiyat listesi `invoices.*` izinlerini). İzin düzeyinde ayrı yönetilemeyen modüller bir üst alana bağlanır (`MODULE_AREA`); alanın
 * anahtarı her zaman bir kayıt modülünün anahtarıdır.
 */

export const ACCESS_LEVELS = ['none', 'read', 'write'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ACCESS_LEVEL_LABELS: Record<AccessLevel, string> = {
  none: 'Erişim yok',
  read: 'Sadece görüntüle',
  write: 'Görüntüle ve düzenle',
};

export interface AccessAreaDef {
  /** Okuma izinleri (verme ve kısıtlama kapsamındadır). */
  read: readonly Permission[];
  /** Yazma/işleme/onay izinleri (verme ve kısıtlama kapsamındadır). */
  write: readonly Permission[];
  /**
   * Role BAĞLI izinler: asla kullanıcı istisnasıyla VERİLMEZ; yalnızca rol taşır. Ancak alan "Erişim yok" yapılırsa bastırılır;
   * `write` türündekiler "Sadece görüntüle"de de bastırılır (`read` türündekiler korunur).
   */
  bound?: Partial<Record<Permission, 'read' | 'write'>>;
}

/** Yönetilen erişim alanları. Anahtar = bir kayıt modülünün anahtarı. */
export const ACCESS_AREAS = {
  'core.ledger': {
    read: ['ledger.read', 'reports.read'],
    write: ['ledger.post', 'ledger.close_period', 'accounts.manage', 'rates.manage'],
    // Yıl sonu kapanışı yalnızca rol; konsolidasyon yalnızca okur (şirket verisini grup raporuna taşır)
    bound: { 'ledger.yearend': 'write', 'reports.consolidation': 'read' },
  },
  'core.parties': { read: ['parties.read'], write: ['parties.manage'] },
  'core.inventory': { read: ['inventory.read'], write: ['inventory.manage', 'inventory.move'] },
  'core.invoices': {
    read: ['invoices.read', 'deliveries.read'],
    write: ['invoices.manage', 'invoices.post', 'deliveries.manage', 'deliveries.post'],
  },
  'core.treasury': { read: ['treasury.read'], write: ['treasury.manage', 'treasury.post'] },
  'construction.projects': { read: ['projects.read'], write: ['projects.manage', 'projects.budget'] },
  'construction.subcontracts': { read: ['subcontracts.read'], write: ['subcontracts.manage', 'subcontracts.approve'] },
  'construction.procurement': { read: ['procurement.read'], write: ['procurement.manage', 'procurement.approve'] },
  'construction.realestate': { read: ['realestate.read'], write: ['realestate.manage', 'realestate.approve'] },
  'core.directory': { read: ['directory.read'], write: ['directory.manage'] },
  // Personel: hassas alan görme izni (hr.sensitive) rolün; "Sadece görüntüle"de korunur (rol bugün de aynı görür), verilmez
  'hr.core': { read: ['hr.read'], write: ['hr.manage'], bound: { 'hr.sensitive': 'read', 'privacy.manage': 'write' } },
  // Bordro ücret verisidir: hr.core'dan ayrı alan; personel cari ve sosyal güvenlik de bu izinleri kullanır
  'hr.payroll': { read: ['hr.payroll'], write: ['hr.payroll_manage'] },
} as const satisfies Record<string, AccessAreaDef>;
export type AccessAreaKey = keyof typeof ACCESS_AREAS;
export const ACCESS_AREA_KEYS = Object.keys(ACCESS_AREAS) as AccessAreaKey[];

/**
 * Hiçbir alana ait olmayan, YALNIZCA rolle verilen izinler: şirket/üye yönetimi, ayarlar (her rolde temel okuma dahil) ve veri dışa
 * aktarma. Kullanıcı istisnası bunları ne verir ne alır. (Dışa aktarma kaydı kendi modül iznini de ister; alan kapalıysa dışa aktarma da kapanır.)
 */
export const ROLE_BOUND_PERMISSIONS = ['company.manage', 'members.manage', 'settings.read', 'settings.manage', 'data.export'] as const satisfies readonly Permission[];

/** Her kayıt modülünün bağlı olduğu alan; `null` = yönetilmeyen (kilitli çekirdek ya da henüz açılmamış) modül. */
export const MODULE_AREA: Record<string, AccessAreaKey | null> = {
  'core.dashboard': null,
  'core.settings': null,
  'retail.pos': null,
  'core.ledger': 'core.ledger',
  'reports.executive': 'core.ledger',
  'reports.consolidation': 'core.ledger',
  'core.parties': 'core.parties',
  'core.inventory': 'core.inventory',
  'inventory.serials': 'core.inventory',
  'inventory.imports': 'core.inventory',
  'core.invoices': 'core.invoices',
  'invoices.orders': 'core.invoices',
  'sales.pricelists': 'core.invoices',
  'core.treasury': 'core.treasury',
  'treasury.cheques': 'core.treasury',
  'treasury.guarantees': 'core.treasury',
  'treasury.expenses': 'core.treasury',
  'construction.projects': 'construction.projects',
  'construction.subcontracts': 'construction.subcontracts',
  'construction.procurement': 'construction.procurement',
  'construction.realestate': 'construction.realestate',
  'core.directory': 'core.directory',
  'hr.core': 'hr.core',
  'hr.foreign': 'hr.core',
  'hr.payroll': 'hr.payroll',
  'hr.employee_ledger': 'hr.payroll',
  'hr.socialsecurity': 'hr.payroll',
};

export const isAccessArea = (key: string): key is AccessAreaKey => Object.prototype.hasOwnProperty.call(ACCESS_AREAS, key);
export const isAccessLevel = (v: unknown): v is AccessLevel => typeof v === 'string' && (ACCESS_LEVELS as readonly string[]).includes(v);

/** Kayıt modülünün bağlı olduğu alan (yönetilmiyorsa null). */
export const areaOfModule = (moduleKey: string): AccessAreaKey | null => MODULE_AREA[moduleKey] ?? null;

/** Alana kayıtlı modüller (alanın kendisi dahil), kayıt sırasıyla. */
export const modulesOfArea = (area: AccessAreaKey): string[] => MODULES.filter((m) => MODULE_AREA[m.key] === area).map((m) => m.key);

/** İzni (okuma/yazma/role bağlı) taşıyan alan; alansız (rol-bağlı) izin için null. */
export function areaOfPermission(permission: Permission): AccessAreaKey | null {
  for (const key of ACCESS_AREA_KEYS) {
    const a: AccessAreaDef = ACCESS_AREAS[key];
    if (a.read.includes(permission) || a.write.includes(permission) || (a.bound && permission in a.bound)) return key;
  }
  return null;
}

export type AccessOverrides = Readonly<Partial<Record<string, AccessLevel>>>;

const areaDef = (key: AccessAreaKey): AccessAreaDef => ACCESS_AREAS[key];

/** Alanın verilebilir (role bağlı olmayan) okuma ve yazma izinleri. */
export function grantablePermissions(area: AccessAreaKey, level: 'read' | 'write'): Permission[] {
  const a = areaDef(area);
  return level === 'read' ? [...a.read] : [...a.read, ...a.write];
}

/** Rol şablonunun izin kümesi (kullanıcı istisnası YOK): varsayılan düzeyler ve "rol varsayılanı" ipuçları içindir. */
export function roleDefaultPermissions(role: Role): Set<Permission> {
  return new Set(ROLE_PERMISSIONS[role]);
}

/**
 * Üyenin ETKİN izin kümesi: rol şablonu, sonra alan istisnaları.
 *  - sahip: istisna uygulanmaz (sahibin erişimi kimse tarafından kısılamaz);
 *  - none: alanın okuma+yazma+role bağlı izinleri kalkar;
 *  - read: yazma ve role bağlı yazma izinleri kalkar, alanın okuma izinleri eklenir;
 *  - write: alanın okuma+yazma izinleri eklenir (role bağlı izinler eklenmez, rolde varsa korunur).
 * Bilinmeyen alan anahtarı ya da geçersiz düzey yok sayılır.
 */
export function effectivePermissions(role: Role, overrides: AccessOverrides = {}): Set<Permission> {
  const perms = roleDefaultPermissions(role);
  if (role === 'owner') return perms;
  for (const [key, level] of Object.entries(overrides)) {
    if (!isAccessArea(key) || !isAccessLevel(level)) continue;
    const a = areaDef(key);
    const boundPerms = a.bound ? (Object.keys(a.bound) as Permission[]) : [];
    if (level === 'none') {
      for (const p of [...a.read, ...a.write, ...boundPerms]) perms.delete(p);
    } else if (level === 'read') {
      for (const p of a.write) perms.delete(p);
      for (const p of boundPerms) if (a.bound?.[p] === 'write') perms.delete(p);
      for (const p of a.read) perms.add(p);
    } else {
      for (const p of [...a.read, ...a.write]) perms.add(p);
    }
  }
  return perms;
}

export interface AreaAccessView {
  area: AccessAreaKey;
  /** Etkin düzey: yazma izni varsa write, yoksa okuma izni varsa read, yoksa none. */
  level: AccessLevel;
  /** Düzeyin gerektirdiği alan izinlerinin hepsi yok (ör. rol yalnız irsaliye yazabilir, fatura yazamaz). */
  partial: boolean;
}

/** Bir izin kümesinde alanın görünen düzeyi. */
export function areaAccessOf(permissions: PermissionSet, area: AccessAreaKey): AreaAccessView {
  const a = areaDef(area);
  const hasW = a.write.filter((p) => permissions.has(p));
  const hasR = a.read.filter((p) => permissions.has(p));
  if (hasW.length > 0) return { area, level: 'write', partial: hasW.length < a.write.length || hasR.length < a.read.length };
  if (hasR.length > 0) return { area, level: 'read', partial: hasR.length < a.read.length };
  return { area, level: 'none', partial: false };
}

/** Bir modülün (alanı yönetiliyorsa) kullanıcı istisnasıyla "Erişim yok" yapılmış olması. */
export function isModuleBlocked(overrides: AccessOverrides, role: Role, moduleKey: string): boolean {
  if (role === 'owner') return false;
  const area = areaOfModule(moduleKey);
  return area !== null && overrides[area] === 'none';
}

/** Sonucu ne olursa olsun role bağlı izinleri (ve alan dışı izinleri) listeler. */
export function unclassifiedPermissions(): Permission[] {
  const bound = new Set<string>(ROLE_BOUND_PERMISSIONS);
  return PERMISSIONS.filter((p) => areaOfPermission(p) === null && !bound.has(p));
}

/**
 * Verme sınırı: bir yönetici, hedefte ancak KENDİSİNİN sahip olduğu izinleri açabilir. İstisna sonrası hedefin alan izinleri
 * (role bağlı olmayanlar) çağıranın etkin izinlerinin alt kümesi olmalı; kısıtlama (none) her zaman serbesttir.
 */
export function exceedsGranter(granter: PermissionSet, target: PermissionSet, area: AccessAreaKey): Permission[] {
  const a = areaDef(area);
  return [...a.read, ...a.write].filter((p) => target.has(p) && !granter.has(p));
}

/** Alanın menüdeki grubu (arayüzde alanları gruplamak için). */
export const AREA_NAV_GROUP: Record<AccessAreaKey, 'parties' | 'invoices' | 'treasury' | 'stock' | 'construction' | 'directory' | 'hr' | 'accounting'> = {
  'core.ledger': 'accounting',
  'core.parties': 'parties',
  'core.inventory': 'stock',
  'core.invoices': 'invoices',
  'core.treasury': 'treasury',
  'construction.projects': 'construction',
  'construction.subcontracts': 'construction',
  'construction.procurement': 'construction',
  'construction.realestate': 'construction',
  'core.directory': 'directory',
  'hr.core': 'hr',
  'hr.payroll': 'hr',
};
