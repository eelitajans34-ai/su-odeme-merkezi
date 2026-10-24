import { createDeps } from '../app.js';
import { loadConfig } from '../config.js';
import { withTransaction } from '../db.js';
import { audit } from '../services/audit.js';

/**
 * E-posta (SMTP) kanalını sunucu tarafında yapılandırır. Süper yönetici daveti e-postayla gönderileceği için
 * ilk kurulumda yönetim panelinden önce kullanılır.
 * SMTP adresi komut satırı argümanı olarak DEĞİL, standart girdiden okunur (kabuk geçmişine düşmemesi için):
 *   printf '%s' "$SMTP_URL" | npm run configure-email -w apps/api -- --provider "Sağlayıcı adı" --status ACTIVE
 */
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const providerName = opt('provider');
const status = opt('status') ?? 'ACTIVE';
if (!providerName || !['TEST', 'ACTIVE'].includes(status)) {
  console.error('Kullanım: printf %s "$SMTP_URL" | configure-email --provider <ad> [--status TEST|ACTIVE]');
  process.exit(2);
}
const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const smtpUrl = Buffer.concat(chunks).toString('utf8').trim();
if (!/^smtps?:\/\//.test(smtpUrl)) {
  console.error('Standart girdiden smtp:// veya smtps:// ile başlayan bir adres bekleniyordu.');
  process.exit(2);
}

const config = loadConfig();
const ref = config.EMAIL_PROVIDER_SECRET_REF;
if (!ref || !config.EMAIL_FROM) {
  console.error('EMAIL_PROVIDER_SECRET_REF ve EMAIL_FROM ortam değişkenleri tanımlanmalıdır.');
  process.exit(2);
}
const deps = createDeps(config);
try {
  const meta = await withTransaction(deps.db, async (c) => {
    const m = await deps.secrets.put(c, { ref, environment: ref.split('/')[1] === 'live' ? 'LIVE' : 'TEST', value: smtpUrl, actorId: null });
    await c.query(`UPDATE notification_channels SET provider_name = $1, status = $2, secret_ref = $3, updated_at = now() WHERE channel = 'EMAIL'`, [providerName, status, ref]);
    await audit(c, { actorType: 'CLI', action: 'notification_channel.update', targetType: 'notification_channel', targetId: 'EMAIL', details: { status, providerName, secretFingerprint: m.fingerprint } });
    return m;
  });
  console.log(`E-posta kanalı kaydedildi (${status}). Gizli bilgi parmak izi: ${meta.fingerprint}. Deneme gönderimi yönetim panelinden yapılabilir.`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await deps.db.end();
}
