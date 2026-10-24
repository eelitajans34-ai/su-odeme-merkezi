import type { Deps } from '../context.js';
import { withTransaction } from '../db.js';
import { AuthService, normalizeEmail } from '../auth/service.js';
import { audit } from '../services/audit.js';

export interface BootstrapOptions {
  email: string | undefined;
  confirmExistingAccount?: boolean;
  reissueInvite?: boolean;
}

export type BootstrapResult =
  | { status: 'ALREADY_EXISTS'; message: string }
  | { status: 'INVITE_CREATED' | 'INVITE_REISSUED'; userId: string; inviteUrl: string; delivery: 'EMAIL_SENT' | 'PRINTED_FOR_DEV' }
  | { status: 'REFUSED'; message: string };

/**
 * Güvenli, idempotent süper yönetici kurulumu.
 * - E-posta kaynak koddan değil, SUPER_ADMIN_EMAIL ortam değişkeninden/girdiden alınır.
 * - Zaten bir süper yönetici varsa hiçbir değişiklik yapmaz (yeniden çalıştırmak güvenlidir).
 * - Parola oluşturmaz; tek kullanımlık, 24 saat geçerli davet bağlantısı üretir.
 * - Daveti kabul eden kullanıcı ilk girişte MFA (TOTP) kurmadan hiçbir yönetim işlemi yapamaz.
 * - Üretimde davet yalnızca e-posta ile iletilir (e-posta sahipliği doğrulanır); bağlantı konsola yazılmaz.
 */
export async function bootstrapSuperAdmin(deps: Deps, opts: BootstrapOptions): Promise<BootstrapResult> {
  if (!opts.email) return { status: 'REFUSED', message: 'SUPER_ADMIN_EMAIL tanımlı değil.' };
  const email = opts.email.trim();
  const norm = normalizeEmail(email);
  const auth = new AuthService(deps);

  const result = await withTransaction(deps.db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(684202)');
    const existing = (
      await c.query(
        `SELECT u.id, u.email_normalized, u.status FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
          WHERE r.code = 'SUPER_ADMIN' AND u.status IN ('ACTIVE','INVITED')`,
      )
    ).rows;
    if (existing.length > 0) {
      const same = existing.find((e) => e.email_normalized === norm);
      if (opts.reissueInvite && same?.status === 'INVITED') {
        const token = await auth.createInvite(c, same.id);
        await audit(c, { actorType: 'CLI', action: 'admin.bootstrap_reissue_invite', targetType: 'user', targetId: same.id });
        return { status: 'INVITE_REISSUED' as const, userId: same.id as string, token };
      }
      return { status: 'ALREADY_EXISTS' as const, message: 'Süper yönetici zaten tanımlı. Hiçbir değişiklik yapılmadı. Ek yöneticiler panelden, MFA ile rol atanarak eklenir.' };
    }

    let user = (await c.query('SELECT id, status FROM users WHERE email_normalized = $1', [norm])).rows[0];
    if (user && !opts.confirmExistingAccount) {
      return { status: 'REFUSED' as const, message: 'Bu e-posta ile kayıtlı bir hesap var. Hesaba süper yönetici yetkisi vermek için --confirm-existing-account ile yeniden çalıştırın; hesabın parolası sıfırlanır, oturumları kapatılır ve davet e-postası ile yeniden etkinleştirilir.' };
    }
    if (user) {
      await c.query(`UPDATE users SET status = 'INVITED', password_hash = NULL, must_enroll_mfa = true, updated_at = now() WHERE id = $1`, [user.id]);
      await c.query(`UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'SUPER_ADMIN_BOOTSTRAP' WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
    } else {
      user = (
        await c.query(`INSERT INTO users (email, email_normalized, status, must_enroll_mfa) VALUES ($1,$2,'INVITED',true) RETURNING id, status`, [email, norm])
      ).rows[0];
      await c.query(`INSERT INTO user_roles (user_id, role_id, granted_via) SELECT $1, id, 'BOOTSTRAP_CLI' FROM roles WHERE code = 'USER' ON CONFLICT DO NOTHING`, [user.id]);
    }
    await c.query(`INSERT INTO user_roles (user_id, role_id, granted_via) SELECT $1, id, 'BOOTSTRAP_CLI' FROM roles WHERE code = 'SUPER_ADMIN' ON CONFLICT DO NOTHING`, [user.id]);
    const token = await auth.createInvite(c, user.id);
    await audit(c, { actorType: 'CLI', action: 'admin.bootstrap_super_admin', targetType: 'user', targetId: user.id, details: { existingAccount: !!opts.confirmExistingAccount } });
    return { status: 'INVITE_CREATED' as const, userId: user.id as string, token };
  });

  if (result.status === 'ALREADY_EXISTS' || result.status === 'REFUSED') return result;
  const inviteUrl = `${deps.config.APP_BASE_URL}/yonetici-daveti?token=${result.token}`;
  const sent = await deps.notifications.sendTransactionalEmail({
    to: email,
    subject: 'Su Ödeme Merkezi — Süper yönetici daveti',
    text: `Süper yönetici hesabınızı etkinleştirmek için bağlantıyı açın (24 saat, tek kullanımlık):\n${inviteUrl}\n\nİlk girişte iki aşamalı doğrulama (TOTP) kurulumu zorunludur.`,
  });
  if (sent.status === 'SENT') return { status: result.status, userId: result.userId, inviteUrl: '[e-posta ile gönderildi]', delivery: 'EMAIL_SENT' };
  if (!deps.config.isProduction) return { status: result.status, userId: result.userId, inviteUrl, delivery: 'PRINTED_FOR_DEV' };
  throw new Error('Üretimde davet yalnızca e-posta ile gönderilebilir, ancak e-posta kanalı yapılandırılmadı veya gönderim başarısız. Önce SMTP yapılandırın, ardından --reissue-invite ile tekrar çalıştırın.');
}
