import { createDeps } from '../app.js';
import { loadConfig } from '../config.js';
import { bootstrapSuperAdmin } from './bootstrap.js';

const args = new Set(process.argv.slice(2));
const config = loadConfig();
const deps = createDeps(config);
try {
  const r = await bootstrapSuperAdmin(deps, {
    email: config.SUPER_ADMIN_EMAIL,
    confirmExistingAccount: args.has('--confirm-existing-account'),
    reissueInvite: args.has('--reissue-invite'),
  });
  if (r.status === 'ALREADY_EXISTS' || r.status === 'REFUSED') {
    console.log(r.message);
    if (r.status === 'REFUSED') process.exitCode = 2;
  } else if (r.delivery === 'EMAIL_SENT') {
    console.log('Süper yönetici daveti SUPER_ADMIN_EMAIL adresine e-posta ile gönderildi.');
  } else {
    console.log('[YALNIZCA GELİŞTİRME] E-posta kanalı yapılandırılmadı. Davet bağlantısı (24 saat, tek kullanımlık):');
    console.log(r.inviteUrl);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await deps.db.end();
}
