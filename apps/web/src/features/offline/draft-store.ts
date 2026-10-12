import type { OfflineDraftBootstrap, OfflineDraftPayload, OfflineDraftReceipt } from '@erp/shared';

export type QueuedDraft = { clientId: string; branchSelection: string; draft: OfflineDraftPayload; createdAt: string; error?: string; receipt?: OfflineDraftReceipt };
export type DraftPackage = OfflineDraftBootstrap & { expiresAt: number; queue: QueuedDraft[]; revision?: number };
type Envelope = { id: 'package'; salt: number[]; iv: number[]; cipher: number[]; revision?: number };
const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('erp-offline-drafts-v1', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('packages', { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function deriveKey(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as Uint8Array<ArrayBuffer>, iterations: 210000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function loadDraftPackage(password: string): Promise<DraftPackage | null> {
  const db = await openDb();
  const envelope = await new Promise<Envelope | undefined>((resolve, reject) => {
    const request = db.transaction('packages').objectStore('packages').get('package');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  }).finally(() => db.close());
  if (!envelope) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(envelope.iv) }, await deriveKey(password, new Uint8Array(envelope.salt)), new Uint8Array(envelope.cipher));
    return { ...JSON.parse(new TextDecoder().decode(plain)) as DraftPackage, revision: envelope.revision ?? 0 };
  } catch { throw new Error('Cihaz kodu yanlış veya çevrimdışı paket bozuk.'); }
}
export async function saveDraftPackage(value: DraftPackage, password: string) {
  if (password.length < 8) throw new Error('Cihaz kodu en az 8 karakter olmalı.');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(password, salt), new TextEncoder().encode(JSON.stringify(value)));
  const db = await openDb();
  const revision = (value.revision ?? 0) + 1;
  try { await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('packages', 'readwrite');
    const store = transaction.objectStore('packages');
    const current = store.get('package');
    current.onsuccess = () => {
      if ((current.result?.revision ?? 0) !== (value.revision ?? 0)) { reject(new Error('Paket başka bir sekmede değişti. Ekranı kilitleyip yeniden açın.')); transaction.abort(); return; }
      store.put({ id: 'package', salt: [...salt], iv: [...iv], cipher: [...new Uint8Array(cipher)], revision } satisfies Envelope);
    };
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
  }); } finally { db.close(); }
  return { ...value, revision };
}
export async function prepareDraftShell() {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) throw new Error('Çevrimdışı kullanım için HTTPS ve servis çalışanı desteği gerekli.');
  await navigator.serviceWorker.register('/field-sw.js');
  const registration = await navigator.serviceWorker.ready;
  await import('./OfflineDraftPage');
  const urls = performance.getEntriesByType('resource').map(entry => entry.name).filter(value => {
    const url = new URL(value); return url.origin === location.origin && !url.pathname.startsWith('/api/') && /\.(js|mjs|css|woff2?)(\?|$)/.test(url.pathname + url.search);
  });
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => { channel.port1.close(); reject(new Error('Çevrimdışı ekran indirilemedi.')); }, 20000);
    channel.port1.onmessage = event => { clearTimeout(timeout); channel.port1.close(); if (event.data?.ok) resolve(); else reject(new Error('Çevrimdışı ekran indirilemedi.')); };
    registration.active?.postMessage({ type: 'prepare', urls: ['/offline-drafts', ...urls] }, [channel.port2]);
  });
}
