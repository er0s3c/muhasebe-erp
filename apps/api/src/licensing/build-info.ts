/**
 * Derleme zamanı sabitleri. Üretim derlemesi (scripts/build.ts, esbuild `define`) bunları koda GÖMER; ortam
 * değişkeniyle değiştirilemezler. Geliştirmede (tsx/vitest) tanımsızdır ve zorlama kapalıdır.
 */
declare const __LICENSE_ENFORCED__: boolean | undefined;
declare const __LICENSE_KEYRING__: string | undefined;
declare const __LICENSE_SERVER_URL__: string | undefined;

/** Bu paket lisans denetimiyle derlendi mi? Üretim paketinde her zaman true. */
export const BUILD_ENFORCED: boolean = typeof __LICENSE_ENFORCED__ !== 'undefined' && __LICENSE_ENFORCED__ === true;
/** Pakete gömülü satıcı açık anahtar halkası (JSON); geliştirmede null. */
export const BUILD_KEYRING_JSON: string | null = typeof __LICENSE_KEYRING__ === 'string' ? __LICENSE_KEYRING__ : null;
/** Derlemede verilen varsayılan lisans sunucusu adresi; LICENSE_SERVER_URL ortam değişkeni bunun yerine geçebilir. */
export const BUILD_SERVER_URL: string | null = typeof __LICENSE_SERVER_URL__ === 'string' && __LICENSE_SERVER_URL__ !== '' ? __LICENSE_SERVER_URL__ : null;
