import type { FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { AppError } from './errors';

/**
 * Oturum açma/yenileme gibi çerez kullanan POST uçlarında, tarayıcı `Origin` başlığı gönderiyorsa isteğin
 * kendi kökenimizden ya da izinli bir kökenden geldiğini doğrular (SameSite=Strict'e ek savunma).
 * Başlık yoksa (sunucu-sunucu, curl, testler) geçilir: tarayıcı çapraz-köken POST'ta her zaman gönderir.
 */
export function assertSameOrigin(req: FastifyRequest, config: Pick<Config, 'CORS_ORIGIN'>): void {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '' || origin === 'null') {
    if (origin === 'null') throw new AppError(403, 'BAD_ORIGIN', 'İstek kökeni doğrulanamadı');
    return;
  }
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    throw new AppError(403, 'BAD_ORIGIN', 'İstek kökeni doğrulanamadı');
  }
  if (host === req.host || config.CORS_ORIGIN.includes(origin)) return;
  throw new AppError(403, 'BAD_ORIGIN', 'İstek kökeni izinli değil');
}
