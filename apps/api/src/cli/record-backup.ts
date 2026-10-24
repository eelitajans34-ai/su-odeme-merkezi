import { loadConfig } from '../config.js';
import { createPool } from '../db.js';

/** scripts/backup.sh ve scripts/restore-test.sh tarafından çağrılır: yedekleme/geri yükleme sonucunu kaydeder. */
const [kind, status, storageRef, ...details] = process.argv.slice(2);
if (!['BACKUP', 'RESTORE_TEST'].includes(kind ?? '') || !['SUCCEEDED', 'FAILED'].includes(status ?? '')) {
  console.error('Kullanım: record-backup <BACKUP|RESTORE_TEST> <SUCCEEDED|FAILED> [depolama-ref] [açıklama]');
  process.exit(2);
}
const db = createPool(loadConfig().DATABASE_URL);
await db.query('INSERT INTO backup_runs (kind, status, storage_ref, details, recorded_by) VALUES ($1,$2,$3,$4,$5)', [kind, status, storageRef ?? null, details.join(' ') || null, 'CLI']);
await db.end();
