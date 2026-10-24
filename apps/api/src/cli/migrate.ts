import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { migrate } from '../migrator.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
try {
  const applied = await migrate(db, { log: (m) => console.log(m) });
  console.log(applied.length ? `${applied.length} migration uygulandı.` : 'Veritabanı güncel; uygulanacak migration yok.');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
