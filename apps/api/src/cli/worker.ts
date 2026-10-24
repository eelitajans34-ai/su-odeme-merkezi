import { createDeps } from '../app.js';
import { loadConfig } from '../config.js';
import { runWorkerTick } from '../services/fulfillment.js';
import { runMaintenanceChecks } from '../services/maintenance.js';

/** Arka plan görevi: bekleyen işlemleri ilerletir, uzun bekleyenler ve süresi dolan anahtarlar için uyarı üretir. */
const config = loadConfig();
const deps = createDeps(config);
const once = process.argv.includes('--once');
let stopping = false;
process.on('SIGTERM', () => (stopping = true));
process.on('SIGINT', () => (stopping = true));
do {
  try {
    const r = await runWorkerTick(deps);
    await runMaintenanceChecks(deps);
    if (r.processed) console.log(`${r.processed} işlem ilerletildi.`);
  } catch (err) {
    console.error('Görev hatası:', (err as Error).message);
  }
  if (!once) await new Promise((res) => setTimeout(res, 15_000));
} while (!once && !stopping);
await deps.db.end();
