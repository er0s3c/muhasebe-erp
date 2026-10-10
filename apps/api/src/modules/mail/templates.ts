import type { MailMessage } from './mailer';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(name: string, paragraphs: string[], link?: { url: string; label: string }): { text: string; html: string } {
  const text = [`Merhaba ${name},`, '', ...paragraphs, ...(link ? ['', link.url] : []), '', 'Ada ERP'].join('\n');
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#0c0a08;line-height:1.5">` +
    `<p>Merhaba ${esc(name)},</p>` +
    paragraphs.map((p) => `<p>${esc(p)}</p>`).join('') +
    (link
      ? `<p><a href="${esc(link.url)}" style="display:inline-block;background:#e4f222;color:#0c0a08;padding:10px 20px;border-radius:6px;text-decoration:none">${esc(link.label)}</a></p>` +
        `<p style="color:#6d6c6b;font-size:13px">Düğme çalışmazsa bu adresi tarayıcınıza yapıştırın:<br>${esc(link.url)}</p>`
      : '') +
    `<p style="color:#6d6c6b;font-size:13px">Ada ERP</p></div>`;
  return { text, html };
}

export function verifyEmailMail(to: string, name: string, url: string): MailMessage {
  const { text, html } = layout(
    name,
    ['E-posta adresinizi doğrulamak için aşağıdaki bağlantıyı kullanın. Bağlantı 3 gün geçerlidir.', 'Bu hesabı siz oluşturmadıysanız bu iletiyi yok sayabilirsiniz.'],
    { url, label: 'E-postamı doğrula' },
  );
  return { to, subject: 'E-posta adresinizi doğrulayın', text, html };
}

export function resetPasswordMail(to: string, name: string, url: string): MailMessage {
  const { text, html } = layout(
    name,
    ['Şifrenizi sıfırlamak için bir istek aldık. Bağlantı 1 saat geçerlidir ve yalnızca bir kez kullanılabilir.', 'Bu isteği siz yapmadıysanız bu iletiyi yok sayın; şifreniz değişmez.'],
    { url, label: 'Şifremi sıfırla' },
  );
  return { to, subject: 'Şifre sıfırlama isteği', text, html };
}

export function passwordChangedMail(to: string, name: string): MailMessage {
  const { text, html } = layout(name, [
    'Hesabınızın şifresi az önce değiştirildi ve tüm açık oturumlarınız kapatıldı.',
    'Bu değişikliği siz yapmadıysanız hemen şirket yöneticinizle iletişime geçin.',
  ]);
  return { to, subject: 'Şifreniz değiştirildi', text, html };
}

/**
 * Günlük bildirim özeti. İçerik GENELDİR: yalnızca bildirim başlıkları (tür + sayı) ve uygulamaya bağlantı; ad, kimlik no, IBAN, ücret,
 * belge numarası ya da tutar yazılmaz (LEGAL-NOTES §5). Şirket adı yalnızca birden çok şirketli kullanıcı hangisi olduğunu bilsin diye geçer.
 */
export function notificationDigestMail(to: string, name: string, company: string, lines: readonly string[], url: string): MailMessage {
  const { text, html } = layout(
    name,
    [
      `${company ? `${company} şirketinde ` : ''}okumadığınız ${lines.length} bildirim var:`,
      ...lines.map((l) => `• ${l}`),
      'Bildirim özeti e-postasını Bildirim tercihleri sayfasından kapatabilirsiniz. Ayrıntılar için uygulamaya girin; bu ileti kişisel veri ya da tutar içermez.',
    ],
    { url, label: 'Bildirimleri aç' },
  );
  return { to, subject: `Bildirim özeti: ${lines.length} okunmamış bildirim`, text, html };
}
