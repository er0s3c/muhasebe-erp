import { storeUpdateOffer } from '../modules/system/update-store';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { BUILD_ENFORCED, BUILD_KEYRING_JSON, BUILD_SERVER_URL } from './build-info';
import { keyringUsable, parseKeyring } from './keyring';
import devKeys from './public-keys.json';
import { LicenseService, type LicenseLogger } from './service';
import { httpTransport, type LicenseTransport } from './transport';

export { assertLicensed, checkRequest, restrictionMessage } from './gate';
export { LicenseService, type LicenseSnapshot, type LicenseReason } from './service';
export { BUILD_ENFORCED } from './build-info';
export type { LicenseTransport } from './transport';

export interface LicenseSetup {
  /** Verilirse (testler) yapılandırma yerine bu hizmet kullanılır. */
  service?: LicenseService;
  /** Denetimi bu süreçte aç/kapat; verilmezse: üretim paketinde true, geliştirmede LICENSE_ENFORCEMENT_DEV. */
  enforced?: boolean;
  transport?: LicenseTransport | null;
  now?: () => number;
  reloadMs?: number;
  /** İptal edilmiş cihaz denetimi önbelleği (ms); testlerde 0. */
  deviceCacheMs?: number;
}

/** Bu süreçte lisans denetimi açık mı? Üretim paketinde ortam değişkeniyle kapatılamaz. */
export function resolveEnforced(config: Config, override?: boolean): boolean {
  if (BUILD_ENFORCED) return true;
  if (override !== undefined) return override;
  return config.NODE_ENV !== 'production' && config.LICENSE_ENFORCEMENT_DEV;
}

/** Satıcı açık anahtar halkası: derlemeye gömülü; geliştirmede yoksa LICENSE_DEV_KEYRING, o da yoksa depodaki dosya. */
export function resolveKeyring(config: Config) {
  if (BUILD_KEYRING_JSON) return parseKeyring(BUILD_KEYRING_JSON);
  if (config.NODE_ENV !== 'production' && config.LICENSE_DEV_KEYRING) return parseKeyring(config.LICENSE_DEV_KEYRING);
  return parseKeyring(JSON.stringify(devKeys));
}

export function createLicenseService(opts: { db: Db; config: Config; log?: LicenseLogger; setup?: LicenseSetup }): LicenseService {
  const { db, config, setup } = opts;
  if (setup?.service) return setup.service;
  const enforced = resolveEnforced(config, setup?.enforced);
  const keyring = resolveKeyring(config);
  if (enforced && !keyringUsable(keyring)) {
    throw new Error('Lisans denetimi açık ama güvenilir satıcı açık anahtarı yok (derlemede LICENSE_PUBLIC_KEYS_JSON verin)');
  }
  const url = config.LICENSE_SERVER_URL ?? BUILD_SERVER_URL;
  const transport = setup?.transport !== undefined ? setup.transport : url ? httpTransport(url) : null;
  return new LicenseService({
    db,
    keyring,
    enforced,
    transport,
    appVersion: config.APP_VERSION,
    hostIdFile: config.LICENSE_HOST_ID_FILE,
    now: setup?.now,
    reloadMs: setup?.reloadMs,
    log: opts.log,
    platform: config.ERP_KIT_TARGET,
    onUpdateOffer: (offer) => storeUpdateOffer(db, keyring, offer),
  });
}

/** Satıcı lisans sunucusunun adresi (yapılandırma ya da derlemeye gömülü); güncelleme indirme adresi bundan türetilir. */
export const licenseServerUrl = (config: Config): string | null => config.LICENSE_SERVER_URL ?? BUILD_SERVER_URL;
