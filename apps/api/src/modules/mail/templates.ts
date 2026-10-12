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

export interface InvoiceDocumentMailInput {
  company: string;
  partyName: string;
  invoiceNo: string;
  invoiceDate: string;
  dueDate: string | null;
  currency: string;
  lines: readonly { description: string; quantity: string; unit: string | null; unitPrice: string; net: string }[];
  netTotal: string;
  vatTotal: string;
  grossTotal: string;
  payable: string | null;
  note: string | null;
  version: string;
}

/**
 * Müşteriye giden fatura belgesi (öneri 7). Ticari belgedir: alıcıya yönelik numara, tarih, satırlar ve tutarlar yazılır.
 * Altbilgideki sürüm kodu, gönderilen içeriğin gönderim geçmişindeki kayıtla aynı olduğunu doğrulamaya yarar.
 */
export function invoiceDocumentMail(to: string, d: InvoiceDocumentMailInput, format: (amount: string) => string): MailMessage {
  const date = (iso: string) => iso.split('-').reverse().join('.');
  const money = (v: string) => `${format(v)} ${d.currency}`;
  const intro = `${d.company} tarafından düzenlenen ${d.invoiceNo} numaralı fatura bilgileri aşağıdadır.`;
  const meta = [`Fatura tarihi: ${date(d.invoiceDate)}`, ...(d.dueDate ? [`Vade: ${date(d.dueDate)}`] : [])];
  const totals = [`Ara toplam: ${money(d.netTotal)}`, `KDV: ${money(d.vatTotal)}`, `Genel toplam: ${money(d.grossTotal)}`, ...(d.payable ? [`Ödenecek: ${money(d.payable)}`] : [])];
  const footer = `Belge sürümü: ${d.version}. Bu ileti ${d.company} adına Ada ERP ile gönderildi.`;
  const text = [
    `Sayın ${d.partyName},`, '', ...(d.note ? [d.note, ''] : []), intro, ...meta, '',
    ...d.lines.map((l) => `• ${l.description} — ${l.quantity}${l.unit ? ` ${l.unit}` : ''} × ${money(l.unitPrice)} = ${money(l.net)}`),
    '', ...totals, '', footer,
  ].join('\n');
  const cell = 'padding:6px 8px;border-bottom:1px solid #e5e4e2';
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0c0a08;line-height:1.5">` +
    `<p>Sayın ${esc(d.partyName)},</p>` +
    (d.note ? `<p>${esc(d.note).replace(/\n/g, '<br>')}</p>` : '') +
    `<p>${esc(intro)}</p><p>${meta.map(esc).join('<br>')}</p>` +
    `<table style="border-collapse:collapse;width:100%;max-width:640px"><thead><tr>` +
    ['Açıklama', 'Miktar', 'Birim fiyat', 'Tutar'].map((h, i) => `<th style="${cell};text-align:${i ? 'right' : 'left'}">${h}</th>`).join('') +
    `</tr></thead><tbody>` +
    d.lines.map((l) => `<tr><td style="${cell}">${esc(l.description)}</td><td style="${cell};text-align:right">${esc(l.quantity)}${l.unit ? ` ${esc(l.unit)}` : ''}</td><td style="${cell};text-align:right">${esc(money(l.unitPrice))}</td><td style="${cell};text-align:right">${esc(money(l.net))}</td></tr>`).join('') +
    `</tbody></table><p>${totals.map(esc).join('<br>')}</p>` +
    `<p style="color:#6d6c6b;font-size:12px">${esc(footer)}</p></div>`;
  return { to, subject: `${d.company} — ${d.invoiceNo} numaralı fatura`, text, html };
}

/**
 * Cari mutabakat mektubu (öneri 59): tarih itibarıyla kayıtlardaki bakiye ve cevap isteği. Alıcıdan, kendi kayıtlarındaki
 * bakiyeyi bildirerek yanıt vermesi istenir; cevap uygulamaya kullanıcı tarafından işlenir.
 */
export function partyReconciliationMail(to: string, d: { company: string; partyName: string; asOf: string; lines: readonly string[]; note: string | null; reference: string }): MailMessage {
  const date = d.asOf.split('-').reverse().join('.');
  const paragraphs = [
    ...(d.note ? [d.note] : []),
    `${date} tarihi itibarıyla kayıtlarımızda firmanızın bakiyesi aşağıdaki gibidir:`,
    ...d.lines.map((l) => `• ${l}`),
    'Kendi kayıtlarınızla karşılaştırarak mutabık olup olmadığınızı, değilseniz kayıtlarınızdaki bakiyeyi ve farkın nedenini bu iletiyi yanıtlayarak bildirmenizi rica ederiz.',
    `Mutabakat referansı: ${d.reference}`,
  ];
  const text = [`Sayın ${d.partyName},`, '', ...paragraphs, '', d.company].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0c0a08;line-height:1.5"><p>Sayın ${esc(d.partyName)},</p>` +
    paragraphs.map((p) => `<p>${esc(p)}</p>`).join('') + `<p>${esc(d.company)}</p></div>`;
  return { to, subject: `${d.company} — ${date} tarihli cari mutabakat`, text, html };
}
