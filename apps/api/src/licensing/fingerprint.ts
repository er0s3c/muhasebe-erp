import { existsSync, readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { computeFingerprint } from '@erp/license-core';
import type { Db } from '../db/client';

export interface ServerFingerprint {
  fingerprint: string;
  /** `weak`: ana makine kimliği okunamadı; parmak izi yalnızca veritabanı kümesine bağlıdır (klon koruması zayıf). */
  strength: 'strong' | 'weak';
}

const MACHINE_ID_RE = /^[0-9a-f]{32}$/i;

/**
 * Ana makine kimliğini okur: önce `LICENSE_HOST_ID_FILE` (compose ana makinenin /etc/machine-id dosyasını
 * salt-okunur bağlar), yoksa `/etc/machine-id`. Geçersiz ya da okunamayan değer yok sayılır.
 */
export function readMachineId(file?: string): string | null {
  for (const path of [file, '/etc/machine-id', '/var/lib/dbus/machine-id']) {
    if (!path || !existsSync(path)) continue;
    try {
      const value = readFileSync(path, 'utf8').trim();
      if (MACHINE_ID_RE.test(value)) return value.toLowerCase();
    } catch {
      // okunamıyorsa sıradakini dene
    }
  }
  return null;
}

/** PostgreSQL küme kimliği (initdb'de bir kez üretilir; veritabanı yeniden kurulursa değişir). */
export async function readClusterId(db: Db): Promise<string> {
  const res = await db.execute<{ id: string }>(sql`select system_identifier::text as id from pg_control_system()`);
  const id = res.rows[0]?.id;
  if (!id) throw new Error('PostgreSQL küme kimliği okunamadı');
  return id;
}

export async function serverFingerprint(db: Db, hostIdFile?: string): Promise<ServerFingerprint> {
  const machineId = readMachineId(hostIdFile);
  const clusterId = await readClusterId(db);
  return { fingerprint: computeFingerprint(machineId, clusterId), strength: machineId ? 'strong' : 'weak' };
}
