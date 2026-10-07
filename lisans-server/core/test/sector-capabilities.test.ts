import { describe, expect, it } from 'vitest';
import {
  activateRequestSchema,
  clientSupportsSectors,
  heartbeatRequestSchema,
  offlineRequestSchema,
} from '../src/claims';

describe('sector capabilities', () => {
  it('legacy licenses keep working without a capability claim', () => {
    expect(clientSupportsSectors(['CONSTRUCTION', 'RETAIL_MARKET', 'COMMERCE'])).toBe(true);
  });
  it.each(['LEATHER_FASHION', 'MANUFACTURING_WHOLESALE'] as const)(
    '%s requires the signed capability, including mixed licenses',
    (sector) => {
      expect(clientSupportsSectors([sector])).toBe(false);
      expect(clientSupportsSectors(['CONSTRUCTION', sector], ['CONSTRUCTION'])).toBe(false);
      expect(clientSupportsSectors([sector], [sector])).toBe(true);
    },
  );
  it('all lease request protocols preserve the supported sectors claim', () => {
    const common = {
      installationId: '00000000-0000-4000-8000-000000000001',
      fingerprint: 'a'.repeat(64),
      appVersion: '1.0',
      ts: 1,
      supportedSectors: ['LEATHER_FASHION'],
    };
    const nonce = 'a'.repeat(20);
    expect(
      activateRequestSchema.parse({ ...common, code: 'A'.repeat(25), nonce }).supportedSectors,
    ).toEqual(['LEATHER_FASHION']);
    expect(
      heartbeatRequestSchema.parse({ ...common, nonce, stats: { devices: 0, companies: 0 } })
        .supportedSectors,
    ).toEqual(['LEATHER_FASHION']);
    expect(offlineRequestSchema.parse({ ...common, requestId: nonce }).supportedSectors).toEqual([
      'LEATHER_FASHION',
    ]);
  });
});
