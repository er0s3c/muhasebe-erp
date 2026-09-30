import nodemailer from 'nodemailer';
import type { Config } from '../../config';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  /** Giden posta yapılandırılmış mı (kapalıysa parola sıfırlama/doğrulama akışları arayüzde gizlenir). */
  readonly enabled: boolean;
  send(message: MailMessage): Promise<void>;
}

interface Logger {
  info(obj: unknown, msg?: string): void;
}

/**
 * `SMTP_URL` ile nodemailer taşıyıcısı (TLS sertifikası doğrulaması açık kalır); `MAIL_TRANSPORT=log` yalnızca
 * geliştirmede iletiyi günlüğe yazar; hiçbiri yoksa posta kapalıdır.
 */
export function createMailer(config: Pick<Config, 'MAIL_MODE' | 'SMTP_URL' | 'MAIL_FROM'>, log: Logger): Mailer {
  if (config.MAIL_MODE === 'off') return { enabled: false, send: async () => {} };
  if (config.MAIL_MODE === 'log') {
    return {
      enabled: true,
      send: async (m) => {
        log.info({ to: m.to, subject: m.subject, text: m.text }, 'e-posta (günlük modu, gönderilmedi)');
      },
    };
  }
  const transport = nodemailer.createTransport(config.SMTP_URL!);
  return {
    enabled: true,
    send: async (m) => {
      await transport.sendMail({ from: config.MAIL_FROM, to: m.to, subject: m.subject, text: m.text, html: m.html });
    },
  };
}

/** Testler için: gönderilenleri bellekte toplar. */
export class OutboxMailer implements Mailer {
  readonly enabled = true;
  readonly sent: MailMessage[] = [];
  /** true iken send hata fırlatır (posta hatasının isteği bozmadığını sınamak için). */
  failing = false;

  async send(message: MailMessage): Promise<void> {
    if (this.failing) throw new Error('SMTP bağlantı hatası');
    this.sent.push(message);
  }

  /** Belirli alıcıya giden son iletideki bağlantı jetonu. */
  lastTokenFor(to: string): string | undefined {
    const m = [...this.sent].reverse().find((x) => x.to === to);
    return m ? /[?&]token=([\w-]+)/.exec(m.text)?.[1] : undefined;
  }
}
