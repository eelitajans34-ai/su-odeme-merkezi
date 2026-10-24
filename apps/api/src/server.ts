import { buildApp, createDeps } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const deps = createDeps(config);
const app = await buildApp(deps);
await app.listen({ port: config.PORT, host: config.HOST });
if (config.allowSandboxAdapters) {
  app.log.warn('Simülatör adaptörleri etkin (geliştirme/test). Gerçek ödeme veya yükleme yapılmaz.');
}
const shutdown = async () => {
  await app.close();
  await deps.db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
