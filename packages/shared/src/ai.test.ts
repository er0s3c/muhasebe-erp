import { describe, expect, it } from 'vitest';
import { aiChatRequestSchema, aiChatMessageSchema } from './ai';

describe('AI schemas', () => {
  it('geçerli mesajı doğrular', () => {
    const valid = aiChatRequestSchema.parse({
      message: 'Bu ayki satış toplamımız nedir?',
      history: [
        { role: 'user', text: 'Merhaba' },
        { role: 'model', text: 'Merhaba, size nasıl yardımcı olabilirim?' },
      ],
    });
    expect(valid.message).toBe('Bu ayki satış toplamımız nedir?');
    expect(valid.history).toHaveLength(2);
  });

  it('boş mesajı reddeder', () => {
    expect(() => aiChatRequestSchema.parse({ message: '   ' })).toThrow();
  });

  it('aşırı uzun mesajı (2000 karakterden fazla) reddeder', () => {
    const long = 'a'.repeat(2001);
    expect(() => aiChatRequestSchema.parse({ message: long })).toThrow();
  });

  it('geçersiz rolü reddeder', () => {
    expect(() =>
      aiChatMessageSchema.parse({ role: 'system', text: 'yetkisiz' }),
    ).toThrow();
  });
});
