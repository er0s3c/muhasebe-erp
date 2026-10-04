import { useCallback, useState } from 'react';

/**
 * Sunucudan gelen değeri düzenlenebilir taslağa bağlar: kullanıcı dokunmadıkça gösterilen değer sunucununkidir,
 * dokunduktan sonra taslaktır. Eski desen (`useEffect(() => setForm(data), [data])`) sorgu kullanıcı yazdıktan SONRA
 * sonuçlanınca ya da yeniden çekilince girilen değeri sessizce eziyordu (pricing-serials e2e kararsızlığı: cariye atanan
 * fiyat listesi kaydedilmeden siliniyor, faturada liste fiyatı 90 yerine kart fiyatı 100 geliyordu).
 * Kaydettikten sonra `reset()` taslağı bırakır; gösterim yeniden çekilen sunucu değerine döner.
 */
export function useServerDraft<T>(server: T) {
  const [draft, setDraft] = useState<T | null>(null);
  const value = draft ?? server;
  const update = useCallback((patch: Partial<T>) => setDraft((d) => ({ ...(d ?? server), ...patch })), [server]);
  const reset = useCallback(() => setDraft(null), []);
  return { value, update, reset, dirty: draft !== null };
}
