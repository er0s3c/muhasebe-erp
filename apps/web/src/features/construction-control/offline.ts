import type { ConstructionDrawing, ConstructionLocation, DrawingPin } from '@erp/shared';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
export interface FieldPackage {
  companyId: string;
  userId: string;
  projectId: string;
  projectName: string;
  expiresAt: number;
  locations: ConstructionLocation[];
  drawing: ConstructionDrawing | null;
  drawingBase64: string | null;
  pins: DrawingPin[];
  queue: FieldSubmission[];
}
export interface FieldSubmission {
  id: string;
  title: string;
  question: string;
  kind: 'rfi' | 'site_report';
  date: string;
  dueDate: string;
  page?: number;
  point: { x: number; y: number } | null;
  locationId: string | null;
  photo: { filename: string; mime: string; base64: string } | null;
  error?: string;
}
type Envelope = { id: 'package'; salt: number[]; iv: number[]; cipher: number[] };
const DB = 'erp-field-offline-v1';
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('package', { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function key(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as Uint8Array<ArrayBuffer>, iterations: 120000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
export async function saveFieldPackage(data: FieldPackage, password: string) {
  if (password.length < 8) throw new Error('Cihaz kodu en az 8 karakter olmalı.');
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await key(password, salt),
    new TextEncoder().encode(JSON.stringify(data)),
  );
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('package', 'readwrite');
    tx.objectStore('package').put({
      id: 'package',
      salt: [...salt],
      iv: [...iv],
      cipher: [...new Uint8Array(cipher)],
    } satisfies Envelope);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
export async function loadFieldPackage(
  password: string,
  allowExpired = false,
): Promise<FieldPackage> {
  const db = await database();
  const record = await new Promise<Envelope | undefined>((resolve, reject) => {
    const r = db.transaction('package').objectStore('package').get('package');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  db.close();
  if (!record) throw new Error('Bu cihazda indirilmiş saha paketi yok.');
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(record.iv) },
      await key(password, new Uint8Array(record.salt)),
      new Uint8Array(record.cipher),
    );
    const data = JSON.parse(new TextDecoder().decode(plain)) as FieldPackage;
    if (!allowExpired && data.expiresAt < Date.now())
      throw new Error('Saha paketinin 24 saatlik erişim süresi doldu; çevrimiçi yenileyin.');
    return data;
  } catch (e) {
    if (e instanceof Error && e.message.includes('24 saat')) throw e;
    throw new Error('Cihaz kodu yanlış veya saha paketi bozuk.', { cause: e });
  }
}
export async function clearFieldPackage() {
  window.dispatchEvent(new Event('field-package-cleared'));
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('package', 'readwrite');
      tx.objectStore('package').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* No prepared package. */
  }
}
export async function prepareFieldPackage(data: FieldPackage, password: string) {
  let old: FieldPackage | null = null;
  try {
    old = await loadFieldPackage(password, true);
  } catch (e) {
    if (!(e instanceof Error && e.message.includes('indirilmiş saha paketi yok'))) throw e;
  }
  if (old?.queue.length) {
    if (
      old.companyId !== data.companyId ||
      old.userId !== data.userId ||
      old.projectId !== data.projectId ||
      old.drawing?.id !== data.drawing?.id
    )
      throw new Error(
        'Bekleyen saha kayıtlarını önce eşitleyin. Paket yenilenirken çizim, kullanıcı veya proje değiştirilemez.',
      );
    data = { ...data, queue: old.queue };
  }
  await saveFieldPackage(data, password);
}
export function fromBase64(base64: string) {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
export async function fileBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]!);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
export async function prepareOfflineShell() {
  if (!('serviceWorker' in navigator))
    throw new Error('Bu tarayıcı çevrimdışı uygulamayı desteklemiyor.');
  await navigator.serviceWorker.register('/field-sw.js');
  const registration = await navigator.serviceWorker.ready;
  await import('./OfflineFieldPage');
  await fetch(pdfWorkerUrl);
  const urls = performance
    .getEntriesByType('resource')
    .map((r) => r.name)
    .filter((u) => {
      const p = new URL(u);
      return (
        p.origin === location.origin &&
        !p.pathname.startsWith('/api/') &&
        /\.(js|mjs|tsx?|css|woff2?)(\?|$)/.test(p.pathname + p.search)
      );
    });
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error('Çevrimdışı kabuk hazırlanamadı.')), 20000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      if (e.data.ok) resolve();
      else reject(new Error('Çevrimdışı dosyalar indirilemedi.'));
    };
    registration.active?.postMessage(
      { type: 'prepare', urls: [...urls, new URL(pdfWorkerUrl, location.origin).href] },
      [channel.port2],
    );
  });
}
