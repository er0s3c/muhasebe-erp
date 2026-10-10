import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Ayrı modül: pdfjs worker URL'i oturum/çıkış yolundan (session.tsx → offline.ts) ilk yüklemeye sızmasın.
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
