import { eq, sql } from 'drizzle-orm';
import { generateKeyPair } from '@erp/license-core';
import type { Db } from '../db/client';
import { licenseState } from '../db/schema';
import { uuidv7 } from 'uuidv7';

export type LicenseRow = typeof licenseState.$inferSelect;

/** `license_state` tek satırının okunması/yazılması. Başka hiçbir yer bu tabloya dokunmaz. */
export class LicenseStore {
  constructor(private readonly db: Db) {}

  async load(): Promise<LicenseRow | null> {
    const [row] = await this.db.select().from(licenseState).where(eq(licenseState.id, 1));
    return row ?? null;
  }

  /** Satır yoksa kurulum kimliği ve anahtar çiftiyle oluşturur (eşzamanlı örneklerde tek kazanan). */
  async loadOrCreate(): Promise<LicenseRow> {
    const existing = await this.load();
    if (existing) return existing;
    const pair = generateKeyPair();
    await this.db
      .insert(licenseState)
      .values({ id: 1, installationId: uuidv7(), publicKey: pair.publicKey, privateKeyPem: pair.privateKeyPem })
      .onConflictDoNothing();
    const row = await this.load();
    if (!row) throw new Error('Lisans durumu oluşturulamadı');
    return row;
  }

  async saveLease(token: string, highWater: number, now: number): Promise<void> {
    await this.db
      .update(licenseState)
      .set({
        leaseToken: token,
        highWater: sql`greatest(${licenseState.highWater}, ${highWater})`,
        lastCheckAt: new Date(now),
        lastSuccessAt: new Date(now),
        lastErrorCode: null,
        lastError: null,
        pendingRequestId: null,
        updatedAt: new Date(now),
      })
      .where(eq(licenseState.id, 1));
  }

  async clearLease(now: number): Promise<void> {
    await this.db
      .update(licenseState)
      .set({ leaseToken: null, pendingRequestId: null, lastErrorCode: null, lastError: null, updatedAt: new Date(now) })
      .where(eq(licenseState.id, 1));
  }

  async recordFailure(code: string, message: string, now: number): Promise<void> {
    await this.db
      .update(licenseState)
      .set({ lastCheckAt: new Date(now), lastErrorCode: code, lastError: message.slice(0, 500), updatedAt: new Date(now) })
      .where(eq(licenseState.id, 1));
  }

  async setPendingRequest(requestId: string | null, now: number): Promise<void> {
    await this.db.update(licenseState).set({ pendingRequestId: requestId, updatedAt: new Date(now) }).where(eq(licenseState.id, 1));
  }

  /** Saat işaretini yalnızca ileri taşır (veritabanı tetikleyicisi de geri almayı reddeder). */
  async bumpHighWater(highWater: number): Promise<void> {
    await this.db
      .update(licenseState)
      .set({ highWater: sql`greatest(${licenseState.highWater}, ${highWater})` })
      .where(eq(licenseState.id, 1));
  }

  /** Bu kurulumdaki toplam şirket sayısı (RLS'i aşan, yalnızca sayı döndüren SECURITY DEFINER işlev). */
  async companyCount(): Promise<number> {
    const res = await this.db.execute<{ n: number }>(sql`select license_company_count() as n`);
    return Number(res.rows[0]?.n ?? 0);
  }
}
