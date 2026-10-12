import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeFeedbackImage, feedbackInputSchema, FEEDBACK_IMAGE_MAX_BYTES } from '../src';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const JPEG = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==';
const image = { name: 'hata.png', mime: 'image/png' as const, base64: PNG };

describe('isteğe bağlı geri bildirim görselleri', () => {
  it('gerçek PNG ve JPEG görüntülerini kabul eder, MIME yanıltmasını reddeder', () => {
    expect(decodeFeedbackImage(image)).toEqual(Buffer.from(PNG, 'base64'));
    expect(decodeFeedbackImage({ name: 'hata.jpg', mime: 'image/jpeg', base64: JPEG })).toEqual(Buffer.from(JPEG, 'base64'));
    expect(() => decodeFeedbackImage({ ...image, mime: 'image/jpeg' })).toThrow('JPEG');
    expect(() => decodeFeedbackImage({ ...image, base64: Buffer.from('<svg/>').toString('base64') })).toThrow('PNG');
  });
  it('kesilmiş dosya, eklenmiş veri, kanonik olmayan kodlama ve aşırı büyük görselleri reddeder', () => {
    expect(() => decodeFeedbackImage({ ...image, base64: Buffer.from(PNG, 'base64').subarray(0, 40).toString('base64') })).toThrow();
    expect(() => decodeFeedbackImage({ ...image, base64: Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from('<html/>')]).toString('base64') })).toThrow();
    expect(() => decodeFeedbackImage({ ...image, base64: `${PNG}\n` })).toThrow();
    expect(() => decodeFeedbackImage({ ...image, base64: Buffer.alloc(FEEDBACK_IMAGE_MAX_BYTES + 1).toString('base64') })).toThrow('5 MB');
    const oversizedDimensions = Buffer.from(PNG, 'base64');
    oversizedDimensions.writeUInt32BE(20000, 16);
    expect(() => decodeFeedbackImage({ ...image, base64: oversizedDimensions.toString('base64') })).toThrow('boyutları');
  });
  it('açıklama veya görsel gerekir; tam URL, sorgu, dosya yolu ve sahte kimlik alanları kabul edilmez', () => {
    const input = { requestId: randomUUID(), pagePath: '/pos', message: 'Hata gördüm.' };
    expect(feedbackInputSchema.safeParse(input).success).toBe(true);
    expect(feedbackInputSchema.safeParse({ ...input, message: '', screenshot: image }).success).toBe(true);
    expect(feedbackInputSchema.safeParse({ ...input, message: '  ', steps: 'Yalnızca adımlar' }).success).toBe(false);
    for (const pagePath of ['https://example.com', '//example.com', '/pos?token=private', '/pos#private']) expect(feedbackInputSchema.safeParse({ ...input, pagePath }).success).toBe(false);
    expect(feedbackInputSchema.safeParse({ ...input, reporter: { email: 'spoof@example.com' } }).success).toBe(false);
    expect(feedbackInputSchema.safeParse({ ...input, screenshot: { ...image, name: '../hata.png' } }).success).toBe(false);
  });
});
