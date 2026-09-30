import type { FastifyInstance } from 'fastify';
import type { MailMessage } from './mailer';

/**
 * İletiyi arka planda gönderir: istek SMTP yanıtını beklemez (yanıt süresinden kullanıcı var/yok sızmaz, yavaş
 * posta sunucusu istekleri tutmaz) ve gönderim hatası isteği bozmaz. Hata günlüğüne yalnızca hata düşer; iletinin
 * içeriği (bağlantı jetonu) asla yazılmaz.
 */
export function queueMail(app: FastifyInstance, message: MailMessage): void {
  app.mailer.send(message).catch((err: unknown) => {
    app.log.error({ err: err instanceof Error ? err.message : String(err), subject: message.subject }, 'e-posta gönderilemedi');
  });
}
