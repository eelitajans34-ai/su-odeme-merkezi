import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

// Kaynaktan (src/) ve derlenmiş çıktıdan (dist/src/) çalışırken aynı apps/api/migrations klasörü kullanılır
const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = [path.resolve(here, '..', 'migrations'), path.resolve(here, '..', '..', 'migrations')].find((d) => existsSync(d))!;

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export async function readMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (f) => {
      const sql = await readFile(path.join(dir, f), 'utf8');
      return {
        version: f.slice(0, 4),
        name: f,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
}

/**
 * Sürümlü, yalnızca ileri yönlü migration çalıştırıcısı.
 * - Her migration kendi transaction'ı içinde uygulanır.
 * - Uygulanmış bir dosyanın içeriği değişirse çalışma durdurulur (checksum).
 * - Eşzamanlı çalıştırmaya karşı advisory lock alınır.
 * - Hiçbir zaman tablo silmez/sıfırlamaz.
 */
export async function migrate(db: Db, opts: { upTo?: string; dir?: string; log?: (m: string) => void } = {}) {
  const log = opts.log ?? (() => undefined);
  const migrations = await readMigrations(opts.dir);
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(684201)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const m of migrations) {
      if (opts.upTo && m.version > opts.upTo) break;
      const existing = done.get(m.version);
      if (existing) {
        if (existing !== m.checksum) {
          throw new Error(`Migration ${m.name} uygulandıktan sonra değiştirilmiş (checksum uyuşmuyor). Yeni bir migration dosyası oluşturun.`);
        }
        continue;
      }
      log(`Uygulanıyor: ${m.name}`);
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)', [m.version, m.name, m.checksum]);
        await client.query('COMMIT');
        applied.push(m.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.name} başarısız: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(684201)').catch(() => undefined);
    client.release();
  }
  return applied;
}
