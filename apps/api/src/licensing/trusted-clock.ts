import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const stateSchema = z.object({ v: z.literal(1), installationId: z.uuid(), trustedTime: z.number().int().nonnegative(), wallTime: z.number().int().nonnegative() });
const SKEW = 10 * 60_000;
/** License-only clock. The journal must live outside database backups and have service-only ACLs. */
export class TrustedLicenseClock {
  private base = 0;
  private wallBase = 0;
  private monoBase = 0;
  private savedMono = 0;
  private initialized = false;
  uncertain = false;
  constructor(private readonly file?: string, private readonly wall = Date.now, private readonly mono = () => Number(process.hrtime.bigint() / 1_000_000n)) {}
  private mac(data: string, key: string) { return createHmac('sha256', key).update(data).digest('hex'); }
  restore(installationId: string, key: string, minimum: number) {
    if (this.initialized) return;
    this.initialized = true;
    this.base = minimum;
    this.wallBase = this.wall();
    this.monoBase = this.mono();
    if (!this.file) return;
    try {
      if (!existsSync(this.file) || lstatSync(this.file).isSymbolicLink()) throw new Error('Missing clock journal');
      const envelope = JSON.parse(readFileSync(this.file, 'utf8')) as { data: string; mac: string };
      const expected = Buffer.from(this.mac(envelope.data, key));
      const actual = Buffer.from(envelope.mac);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Clock journal signature');
      const s = stateSchema.parse(JSON.parse(envelope.data));
      if (s.installationId !== installationId || s.trustedTime + SKEW < minimum) throw new Error('Clock journal rollback');
      const delta = this.wall() - s.wallTime;
      if (delta < -SKEW) throw new Error('Wall clock rollback');
      this.base = s.trustedTime + Math.max(0, delta);
    } catch { this.uncertain = true; }
  }
  now() {
    const elapsed = Math.max(0, this.mono() - this.monoBase);
    if (Math.abs(this.wall() - this.wallBase - elapsed) > SKEW) this.uncertain = true;
    return Math.floor(this.base + elapsed);
  }
  anchor(serverTime: number, installationId: string, key: string) {
    this.initialized = true;
    this.base = serverTime;
    this.wallBase = this.wall();
    this.monoBase = this.mono();
    this.uncertain = false;
    this.save(installationId, key);
  }
  save(installationId: string, key: string) {
    if (!this.file || this.uncertain) return;
    const data = JSON.stringify({ v: 1, installationId, trustedTime: this.now(), wallTime: this.wall() });
    if (this.uncertain) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    if (existsSync(this.file) && lstatSync(this.file).isSymbolicLink()) throw new Error('Clock journal symlink');
    const temp = `${this.file}.tmp`;
    if (existsSync(temp) && lstatSync(temp).isSymbolicLink()) throw new Error('Clock journal temporary symlink');
    writeFileSync(temp, JSON.stringify({ data, mac: this.mac(data, key) }), { mode: 0o600 });
    renameSync(temp, this.file);
    this.savedMono = this.mono();
  }
  checkpoint(installationId: string, key: string) {
    if (this.mono() - this.savedMono >= 60_000) this.save(installationId, key);
  }
}
