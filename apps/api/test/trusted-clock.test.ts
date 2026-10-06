import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { TrustedLicenseClock } from '../src/licensing/trusted-clock';

describe('trusted license time', () => {
  it('uses elapsed time, detects wall changes and recovers with signed server anchor', () => {
    let wall = 1_700_000_000_000, mono = 0;
    const c = new TrustedLicenseClock(undefined, () => wall, () => mono);
    c.anchor(wall, randomUUID(), 'key'); mono += 60_000; wall += 60_000;
    expect(c.now()).toBe(wall); wall -= 86400_000;
    expect(c.now()).toBe(1_700_000_060_000); expect(c.uncertain).toBe(true);
    c.anchor(1_700_000_060_000, randomUUID(), 'key'); expect(c.uncertain).toBe(false);
  });
  it('persists outside database backups, survives restart and refuses journal corruption', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clock-')); const file = join(dir, 'clock.json'); const id = randomUUID();
    let wall = 1_700_000_000_000, mono = 0;
    try {
      const c = new TrustedLicenseClock(file, () => wall, () => mono); c.anchor(wall, id, 'key');
      wall += 86_400_000; mono += 86_400_000; c.checkpoint(id, 'key');
      const next = new TrustedLicenseClock(file, () => wall, () => 0); next.restore(id, 'key', 1_700_000_000_000);
      expect(next.now()).toBe(wall); expect(next.uncertain).toBe(false);
      const data = readFileSync(file, 'utf8'); writeFileSync(file, data.replace(String(wall), '1700000000000'));
      const tampered = new TrustedLicenseClock(file, () => wall, () => 0); tampered.restore(id, 'key', wall); expect(tampered.uncertain).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
