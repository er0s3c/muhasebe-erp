import { useEffect, useRef, useState } from 'react';

/** Tarayıcının bağlantı durumu (çevrimiçi/çevrimdışı olaylarıyla güncellenir). */
export function useOnlineStatus() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/**
 * Bağlantı geri geldiğinde bekleyen kuyruğu bir kez eşitler (F10: öneri 17). Paket açık değilse ya da eşitleme sürüyorsa
 * çalışmaz; her taslak istemci kimliğiyle gönderildiği için tekrar eşitleme çift kayıt oluşturmaz.
 */
export function useAutoSyncOnReconnect(ready: boolean, pending: number, run: () => Promise<void> | void) {
  const online = useOnlineStatus();
  const latest = useRef(run);
  latest.current = run;
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current && ready && pending > 0) void latest.current();
    wasOnline.current = online;
  }, [online, ready, pending]);
  return online;
}
