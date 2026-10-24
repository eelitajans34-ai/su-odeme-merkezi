import pg from 'pg';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrator.js';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://su_dev:su_dev_local_only@localhost:5432/su_test';

export default async function setup() {
  const name = new URL(TEST_DB_URL).pathname.slice(1);
  // Güvenlik: yalnızca adı "_test" ile biten veritabanı sıfırlanır
  if (!name.endsWith('_test')) throw new Error(`Test veritabanı adı _test ile bitmeli (şu an: ${name})`);
  const c = new pg.Client({ connectionString: TEST_DB_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  const db = createPool(TEST_DB_URL);
  await migrate(db);
  await db.end();
}
