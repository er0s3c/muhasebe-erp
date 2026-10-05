import { describe, expect, it } from 'vitest';
import { documentUploadSchema } from './workspace';

const validInput = {
  record: { kind: 'project' as const, id: '123e4567-e89b-42d3-a456-426614174000' },
  filename: 'rapor.pdf',
  mime: 'application/pdf' as const,
  base64: 'dGVzdA==',
};

describe('documentUploadSchema', () => {
  it('dosya adında eğik çizgi, ters eğik çizgi ve kontrol karakterlerini reddeder', () => {
    const invalidNames = ['alt/rapor.pdf', 'alt\\rapor.pdf', 'rapor\n2026.pdf', `rapor${String.fromCharCode(0)}.pdf`, `rapor${String.fromCharCode(0x1f)}.pdf`];
    for (const filename of invalidNames) {
      const result = documentUploadSchema.safeParse({ ...validInput, filename });
      expect(result.success, filename).toBe(false);
    }
  });

  it('geçerli dosya adını kabul eder', () => {
    expect(documentUploadSchema.safeParse(validInput).success).toBe(true);
  });
});
