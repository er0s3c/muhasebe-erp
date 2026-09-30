import { describe, expect, it } from 'vitest';
import { CLOCK_SKEW_MS, DAY_MS, evaluateLease, nextHighWater } from '../src';
import { FINGERPRINT, INSTALLATION, NOW, makeLease } from './helpers';

const ctx = (over: Partial<Parameters<typeof evaluateLease>[1]> = {}) => ({
  now: NOW,
  highWater: NOW,
  installationId: INSTALLATION,
  fingerprint: FINGERPRINT,
  ...over,
});

describe('evaluateLease', () => {
  it('kira yoksa lisanssız', () => {
    expect(evaluateLease(null, ctx()).state).toBe('unlicensed');
  });

  it('kira süresi içinde aktif; tolerans içinde grace; sonrasında salt-okunur (sınır değerleri dahil)', () => {
    const lease = makeLease(); // leaseUntil = +7g, graceDays = 14
    expect(evaluateLease(lease, ctx({ now: NOW + 7 * DAY_MS, highWater: NOW })).state).toBe('active');
    expect(evaluateLease(lease, ctx({ now: NOW + 7 * DAY_MS + 1, highWater: NOW })).state).toBe('grace');
    expect(evaluateLease(lease, ctx({ now: NOW + 21 * DAY_MS, highWater: NOW })).state).toBe('grace');
    const after = evaluateLease(lease, ctx({ now: NOW + 21 * DAY_MS + 1, highWater: NOW }));
    expect(after.state).toBe('restricted');
    expect(after.reason).toBe('expired');
  });

  it('abonelik bitişi kira süresini aşamaz: validUntil geçmişse kira yenilense de tolerans validUntil üzerinden işler', () => {
    const lease = makeLease({ validUntil: NOW - DAY_MS, leaseUntil: NOW + 7 * DAY_MS });
    // activeUntil = min(leaseUntil, validUntil) = validUntil (geçmiş) → şu an tolerans içinde (validUntil + 14g)
    expect(evaluateLease(lease, ctx()).state).toBe('grace');
    expect(evaluateLease(lease, ctx({ now: NOW + 14 * DAY_MS })).state).toBe('restricted');
  });

  it('iptal ve askı bildirimleri hemen salt-okunura alır', () => {
    expect(evaluateLease(makeLease({ status: 'revoked' }), ctx())).toMatchObject({ state: 'restricted', reason: 'revoked' });
    expect(evaluateLease(makeLease({ status: 'suspended' }), ctx())).toMatchObject({ state: 'restricted', reason: 'suspended' });
  });

  it('başka kuruluma ya da başka sunucu parmak izine bağlı kira geçersizdir', () => {
    expect(evaluateLease(makeLease(), ctx({ installationId: '00000000-0000-4000-8000-000000000000' }))).toMatchObject({ reason: 'installation_mismatch' });
    expect(evaluateLease(makeLease(), ctx({ fingerprint: 'b'.repeat(64) }))).toMatchObject({ reason: 'fingerprint_mismatch' });
  });

  it('saat geri alma: en yüksek görülen zamandan tolerans kadar geriye gidilirse kilitlenir', () => {
    const lease = makeLease();
    const hw = NOW + 30 * 60 * 1000;
    expect(evaluateLease(lease, ctx({ now: hw - CLOCK_SKEW_MS, highWater: hw })).state).toBe('active'); // tolerans içi
    expect(evaluateLease(lease, ctx({ now: hw - CLOCK_SKEW_MS - 1, highWater: hw }))).toMatchObject({ state: 'restricted', reason: 'clock_rollback' });
    // Sahte "saati geri al + kira süresini uzat" denemesi: saat geri alınınca kilit, süre uzamaz
    expect(evaluateLease(lease, ctx({ now: NOW - 400 * DAY_MS, highWater: NOW })).reason).toBe('clock_rollback');
  });

  it('bitişe 14 gün kala uyarı bayrağı', () => {
    expect(evaluateLease(makeLease({ validUntil: NOW + 14 * DAY_MS }), ctx()).expiresSoon).toBe(true);
    expect(evaluateLease(makeLease({ validUntil: NOW + 15 * DAY_MS + 1 }), ctx()).expiresSoon).toBe(false);
  });

  it('nextHighWater geri gitmez', () => {
    expect(nextHighWater(100, 50)).toBe(100);
    expect(nextHighWater(100, 150, 200)).toBe(200);
    expect(nextHighWater(100, 150)).toBe(150);
  });
});
