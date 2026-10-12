import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SECTORS } from '@erp/shared';

export const FEEDBACK_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const FEEDBACK_INPUT_BODY_LIMIT = 7 * 1024 * 1024 + 32 * 1024;
export const FEEDBACK_ENVELOPE_BODY_LIMIT = 10 * 1024 * 1024;
export const FEEDBACK_STATUSES = ['new', 'in_review', 'resolved'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

const hasControlCharacter = (s: string) => [...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const optionalText = (max: number) => z.string().trim().max(max).refine(s => !s.includes('\0'), 'Metin geçersiz bir karakter içeriyor').default('');
const name = z.string().trim().min(1).max(200).refine(s => !hasControlCharacter(s), 'Ad geçersiz bir karakter içeriyor');
const screenshotSchema = z.object({
  name: z.string().trim().min(1).max(180).refine(s => !hasControlCharacter(s) && !s.includes('/') && !s.includes('\\'), 'Dosya adı geçersiz'),
  mime: z.enum(['image/png', 'image/jpeg']),
  base64: z.string().min(4).max(4 * Math.ceil(FEEDBACK_IMAGE_MAX_BYTES / 3)),
}).strict();

export const feedbackInputSchema = z.object({
  requestId: z.uuid(),
  message: optionalText(4000),
  steps: optionalText(2000),
  expected: optionalText(2000),
  pagePath: z.string().trim().min(1).max(500).regex(/^\/(?!\/)[^?#]*$/, 'Sayfa yolu geçersiz').refine(s => !hasControlCharacter(s) && !s.includes('\\'), 'Sayfa yolu geçersiz'),
  pageTitle: optionalText(200),
  screenshot: screenshotSchema.optional(),
}).strict().refine(v => Boolean(v.message || v.screenshot), {
  message: 'Yaşadığınız sorunu yazın veya bir ekran görüntüsü ekleyin', path: ['message'],
});
export type FeedbackInput = z.infer<typeof feedbackInputSchema>;

export const feedbackRequestSchema = z.object({
  installationId: z.uuid(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  ts: z.number().int().min(0).max(8.64e15),
  protocolVersion: z.literal(2).optional(),
  timeNonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional(),
  appVersion: z.string().max(40),
  reporter: z.object({ id: z.uuid(), name, email: z.email().max(254) }).strict(),
  company: z.object({ id: z.uuid(), name, sector: z.enum(SECTORS) }).strict(),
  feedback: feedbackInputSchema,
}).strict();
export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>;

export const feedbackEnvelopeSchema = z.object({
  p: z.string().min(10).max(FEEDBACK_ENVELOPE_BODY_LIMIT - 1024),
  s: z.string().min(40).max(200),
}).strict();

export const feedbackReceiptSchema = z.object({
  id: z.uuid(), reference: z.string().regex(/^GB-[0-9A-F]{12}$/),
  status: z.enum(FEEDBACK_STATUSES), createdAt: z.iso.datetime(),
});
export type FeedbackReceipt = z.infer<typeof feedbackReceiptSchema>;

/** Checks the actual raster container rather than trusting an extension or browser MIME. */
export function decodeFeedbackImage(image: NonNullable<FeedbackInput['screenshot']>): Buffer {
  const bytes = Buffer.from(image.base64, 'base64');
  if (bytes.length === 0 || bytes.length > FEEDBACK_IMAGE_MAX_BYTES || bytes.toString('base64') !== image.base64)
    throw new Error('Ekran görüntüsü boş, geçersiz veya 5 MB sınırını aşıyor');
  let width = 0, height = 0;
  if (image.mime === 'image/png') {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (!bytes.subarray(0, 8).equals(signature)) throw new Error('Dosya içeriği PNG biçimiyle uyuşmuyor');
    let offset = 8, hasData = false, ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (length > bytes.length - offset - 12) throw new Error('PNG dosyası eksik veya bozuk');
      if (offset === 8) {
        if (type !== 'IHDR' || length !== 13) throw new Error('PNG başlığı geçersiz');
        width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
      } else if (type === 'IHDR') throw new Error('PNG başlığı geçersiz');
      if (type === 'IDAT') hasData ||= length > 0;
      offset += length + 12;
      if (type === 'IEND') { ended = length === 0 && offset === bytes.length; break; }
    }
    if (!hasData || !ended) throw new Error('PNG dosyası eksik veya bozuk');
  } else {
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217)
      throw new Error('Dosya içeriği JPEG biçimiyle uyuşmuyor');
    let offset = 2, hasScan = false;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) throw new Error('JPEG dosyası eksik veya bozuk');
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]!;
      if (marker === 217) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error('JPEG dosyası eksik veya bozuk');
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) throw new Error('JPEG başlığı geçersiz');
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5);
      }
      offset += length;
      if (marker === 218) { hasScan = offset < bytes.length - 2; break; }
    }
    if (!hasScan) throw new Error('JPEG dosyası eksik veya bozuk');
  }
  if (!width || !height || width > 16384 || height > 16384 || width * height > 40_000_000)
    throw new Error('Ekran görüntüsünün boyutları geçersiz veya çok büyük');
  return bytes;
}

/** Transport nonce and time proofs change when retrying; the report content must remain identical. */
export function feedbackContentHash(input: FeedbackRequest): string {
  return createHash('sha256').update(JSON.stringify({ appVersion: input.appVersion, reporter: input.reporter, company: input.company, feedback: input.feedback })).digest('hex');
}
