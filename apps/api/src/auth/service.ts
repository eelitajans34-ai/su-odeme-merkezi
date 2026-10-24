import type { Deps } from '../context.js';
import { withTransaction, type DbClient } from '../db.js';
import { decrypt, encrypt, hashPassword, randomToken, sha256Hex, verifyPassword } from '../lib/crypto.js';
import { AppError, badRequest, forbidden, unauthorized } from '../lib/errors.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../lib/totp.js';
import { audit } from '../services/audit.js';

export const PASSWORD_MIN = 12;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const USER_SESSION_DAYS = 14;
const STAFF_SESSION_HOURS = 8;
const STAFF_IDLE_MINUTES = 30;

export interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  status: string;
  clientType: 'WEB' | 'MOBILE';
  roles: string[];
  permissions: Set<string>;
  isStaff: boolean;
  hasMfa: boolean;
  mustEnrollMfa: boolean;
  mfaVerifiedAt: Date | null;
  csrfHash: string | null;
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function validatePassword(pw: string) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) throw badRequest(`Parola en az ${PASSWORD_MIN} karakter olmalıdır.`, 'WEAK_PASSWORD');
  if (pw.length > 200) throw badRequest('Parola çok uzun.', 'WEAK_PASSWORD');
  if (!/[a-zçğıöşü]/.test(pw) || !/[A-ZÇĞİÖŞÜ]/.test(pw) || !/\d/.test(pw)) {
    throw badRequest('Parola büyük harf, küçük harf ve rakam içermelidir.', 'WEAK_PASSWORD');
  }
}

async function createToken(db: DbClient, userId: string, purpose: string, ttlMinutes: number) {
  const token = randomToken(32);
  await db.query(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose]);
  await db.query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4))`,
    [userId, purpose, sha256Hex(token), ttlMinutes],
  );
  return token;
}

async function consumeToken(db: DbClient, token: string, purpose: string) {
  const { rows } = await db.query(
    `UPDATE auth_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [sha256Hex(String(token)), purpose],
  );
  if (!rows[0]) throw badRequest('Bağlantı geçersiz veya süresi dolmuş.', 'INVALID_TOKEN');
  return rows[0].user_id as string;
}

export class AuthService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  private key() {
    return Buffer.from(this.deps.config.SECRETS_ENCRYPTION_KEY, 'base64');
  }

  /** Kayıt: rol istemciden ALINMAZ; her yeni kullanıcı yalnızca USER rolü alır (süper yönetici e-postası dahil). */
  async register(input: { email: string; password: string; fullName?: string; phone?: string; consentDocumentIds?: string[] }, meta: { ip?: string; ua?: string }) {
    validatePassword(input.password);
    const email = input.email.trim();
    const norm = normalizeEmail(email);
    const passwordHash = await hashPassword(input.password);
    const created = await withTransaction(this.db, async (c) => {
      const existing = await c.query('SELECT id FROM users WHERE email_normalized = $1', [norm]);
      if (existing.rows[0]) return null;
      const u = (
        await c.query(
          `INSERT INTO users (email, email_normalized, full_name, phone, password_hash, status) VALUES ($1,$2,$3,$4,$5,'PENDING_VERIFICATION') RETURNING id`,
          [email, norm, input.fullName ?? null, input.phone ?? null, passwordHash],
        )
      ).rows[0];
      await c.query(`INSERT INTO user_roles (user_id, role_id, granted_via) SELECT $1, id, 'REGISTRATION' FROM roles WHERE code = 'USER'`, [u.id]);
      for (const docId of input.consentDocumentIds ?? []) {
        await c.query(`INSERT INTO consent_records (user_id, document_id, action, ip_address, user_agent) SELECT $1, id, 'ACKNOWLEDGED', $3, $4 FROM legal_documents WHERE id = $2`, [u.id, docId, meta.ip ?? null, meta.ua ?? null]);
      }
      const token = await createToken(c, u.id, 'EMAIL_VERIFY', 24 * 60);
      await audit(c, { actorUserId: u.id, actorType: 'USER', action: 'user.register', targetType: 'user', targetId: u.id, ip: meta.ip, userAgent: meta.ua });
      return { id: u.id as string, token };
    });
    if (created) {
      await this.deps.notifications.sendTransactionalEmail({
        to: email,
        subject: 'E-posta adresinizi doğrulayın',
        text: `Hesabınızı etkinleştirmek için bağlantıyı açın (24 saat geçerli):\n${this.deps.config.APP_BASE_URL}/eposta-dogrula?token=${created.token}`,
      });
      await this.deps.notifications.notifyUser({ userId: created.id, eventType: 'ACCOUNT_CREATED', title: 'Hesabınız oluşturuldu', body: 'E-posta adresinizi doğruladıktan sonra giriş yapabilirsiniz.', channels: [] });
    } else {
      await this.deps.notifications.sendTransactionalEmail({ to: email, subject: 'Kayıt denemesi', text: 'Bu e-posta adresiyle zaten bir hesap var. Parolanızı unuttuysanız sıfırlama bağlantısını kullanın.' });
    }
    // Hesap varlığı ifşa edilmez
    return { message: 'Kayıt alındı. E-posta adresinize gönderilen bağlantıyla hesabınızı doğrulayın.' };
  }

  async verifyEmail(token: string) {
    await withTransaction(this.db, async (c) => {
      const userId = await consumeToken(c, token, 'EMAIL_VERIFY');
      await c.query(`UPDATE users SET email_verified_at = now(), status = CASE WHEN status = 'PENDING_VERIFICATION' THEN 'ACTIVE' ELSE status END, updated_at = now() WHERE id = $1`, [userId]);
      await audit(c, { actorUserId: userId, actorType: 'USER', action: 'user.email_verified', targetType: 'user', targetId: userId });
    });
  }

  async login(input: { email: string; password: string; clientType: 'WEB' | 'MOBILE' }, meta: { ip?: string; ua?: string }) {
    const norm = normalizeEmail(input.email);
    const user = (await this.db.query('SELECT * FROM users WHERE email_normalized = $1', [norm])).rows[0];
    const fail = async (reason: string, userId?: string) => {
      await this.db.query('INSERT INTO login_events (user_id, email_normalized, success, reason, ip_address, user_agent) VALUES ($1,$2,false,$3,$4,$5)', [userId ?? null, norm, reason, meta.ip ?? null, meta.ua ?? null]);
    };
    const ok = await verifyPassword(String(input.password ?? ''), user?.password_hash);
    if (!user) {
      await fail('NO_USER');
      throw unauthorized('E-posta veya parola hatalı.');
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await fail('LOCKED', user.id);
      throw new AppError(423, 'ACCOUNT_LOCKED', 'Çok sayıda hatalı deneme nedeniyle hesap geçici olarak kilitlendi. Daha sonra tekrar deneyin.');
    }
    if (!ok) {
      const n = user.failed_login_count + 1;
      if (n >= MAX_FAILED) {
        await this.db.query(`UPDATE users SET failed_login_count = 0, locked_until = now() + make_interval(mins => $2) WHERE id = $1`, [user.id, LOCK_MINUTES]);
        await this.deps.notifications.notifyUser({ userId: user.id, eventType: 'SUSPICIOUS_LOGIN', severity: 'WARNING', title: 'Hesabınız geçici olarak kilitlendi', body: 'Hesabınıza art arda hatalı giriş denemesi yapıldı. Siz değilseniz parolanızı değiştirin.' });
      } else {
        await this.db.query('UPDATE users SET failed_login_count = $2 WHERE id = $1', [user.id, n]);
      }
      await fail('BAD_PASSWORD', user.id);
      throw unauthorized('E-posta veya parola hatalı.');
    }
    if (user.status === 'PENDING_VERIFICATION') throw forbidden('E-posta adresinizi doğrulamadan giriş yapamazsınız.', 'EMAIL_NOT_VERIFIED');
    if (user.status !== 'ACTIVE') throw forbidden('Hesap etkin değil.', 'ACCOUNT_INACTIVE');

    const roles = await this.roles(this.db, user.id);
    const isStaff = roles.some((r) => r.is_staff);
    const hasMfa = await this.hasConfirmedMfa(this.db, user.id);
    const token = randomToken(32);
    const csrf = randomToken(24);
    const expires = isStaff ? `now() + interval '${STAFF_SESSION_HOURS} hours'` : `now() + interval '${USER_SESSION_DAYS} days'`;

    // Şüpheli giriş: daha önce başarılı giriş yapılmış ve bu IP/cihaz son 90 günde görülmemiş
    const seen = await this.db.query(
      `SELECT count(*) FILTER (WHERE ip_address = $2 AND user_agent = $3) AS same, count(*) AS total FROM login_events
        WHERE user_id = $1 AND success AND created_at > now() - interval '90 days'`,
      [user.id, meta.ip ?? null, meta.ua ?? null],
    );
    const suspicious = Number(seen.rows[0].total) > 0 && Number(seen.rows[0].same) === 0;

    const session = await withTransaction(this.db, async (c) => {
      const s = (
        await c.query(
          `INSERT INTO user_sessions (user_id, token_hash, csrf_hash, client_type, ip_address, user_agent, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6, ${expires}) RETURNING id`,
          [user.id, sha256Hex(token), sha256Hex(csrf), input.clientType, meta.ip ?? null, meta.ua?.slice(0, 300) ?? null],
        )
      ).rows[0];
      await c.query('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
      await c.query('INSERT INTO login_events (user_id, email_normalized, success, ip_address, user_agent, suspicious) VALUES ($1,$2,true,$3,$4,$5)', [user.id, norm, meta.ip ?? null, meta.ua ?? null, suspicious]);
      if (isStaff) await audit(c, { actorUserId: user.id, actorType: 'ADMIN', action: 'staff.login', targetType: 'session', targetId: s.id, ip: meta.ip, userAgent: meta.ua, details: { suspicious } });
      return s;
    });
    if (suspicious) {
      await this.deps.notifications.notifyUser({ userId: user.id, eventType: 'SUSPICIOUS_LOGIN', severity: 'WARNING', title: 'Yeni bir cihazdan giriş yapıldı', body: 'Hesabınıza daha önce görülmeyen bir cihaz/konumdan giriş yapıldı. Siz değilseniz tüm oturumları sonlandırıp parolanızı değiştirin.' });
      if (isStaff) await this.deps.notifications.alertAdmins({ eventType: 'SECURITY_EVENT', severity: 'WARNING', title: 'Personel hesabına yeni cihazdan giriş', body: `Kullanıcı ${user.id} yeni bir cihazdan giriş yaptı.` });
    }
    const mustEnroll = user.must_enroll_mfa || (isStaff && !hasMfa && this.deps.config.MFA_REQUIRED_FOR_SUPER_ADMIN);
    return { token, csrfToken: csrf, sessionId: session.id as string, mfaRequired: hasMfa, mfaEnrollmentRequired: mustEnroll && !hasMfa };
  }

  async roles(db: DbClient, userId: string) {
    const { rows } = await db.query('SELECT r.code, r.is_staff FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1', [userId]);
    return rows as { code: string; is_staff: boolean }[];
  }

  async hasConfirmedMfa(db: DbClient, userId: string) {
    const { rows } = await db.query(`SELECT 1 FROM mfa_methods WHERE user_id = $1 AND confirmed_at IS NOT NULL AND disabled_at IS NULL AND type IN ('TOTP','PASSKEY') LIMIT 1`, [userId]);
    return rows.length > 0;
  }

  /** Oturum belirtecinden yetki bağlamı. Rol ve yetkiler her istekte veritabanından okunur (istemciye güvenilmez). */
  async authenticate(token: string): Promise<AuthContext | null> {
    if (!token || token.length > 200) return null;
    const { rows } = await this.db.query(
      `SELECT s.id AS session_id, s.user_id, s.client_type, s.mfa_verified_at, s.csrf_hash, s.last_seen_at, u.email, u.status, u.must_enroll_mfa
         FROM user_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [sha256Hex(token)],
    );
    const s = rows[0];
    if (!s || s.status !== 'ACTIVE') return null;
    const roleRows = await this.roles(this.db, s.user_id);
    const isStaff = roleRows.some((r) => r.is_staff);
    if (isStaff && Date.now() - new Date(s.last_seen_at).getTime() > STAFF_IDLE_MINUTES * 60_000) {
      await this.db.query(`UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'IDLE_TIMEOUT' WHERE id = $1`, [s.session_id]);
      return null;
    }
    const perms = await this.db.query(
      `SELECT DISTINCT p.code FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions p ON p.id = rp.permission_id WHERE ur.user_id = $1`,
      [s.user_id],
    );
    await this.db.query('UPDATE user_sessions SET last_seen_at = now() WHERE id = $1', [s.session_id]);
    return {
      sessionId: s.session_id,
      userId: s.user_id,
      email: s.email,
      status: s.status,
      clientType: s.client_type,
      roles: roleRows.map((r) => r.code),
      permissions: new Set(perms.rows.map((r) => r.code)),
      isStaff,
      hasMfa: await this.hasConfirmedMfa(this.db, s.user_id),
      mustEnrollMfa: s.must_enroll_mfa,
      mfaVerifiedAt: s.mfa_verified_at,
      csrfHash: s.csrf_hash,
    };
  }

  async logout(sessionId: string) {
    await this.db.query(`UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'LOGOUT' WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
  }

  async listSessions(userId: string, currentId: string) {
    const { rows } = await this.db.query(
      `SELECT id, client_type, ip_address::text AS ip, user_agent, created_at, last_seen_at FROM user_sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`,
      [userId],
    );
    return rows.map((r) => ({ ...r, current: r.id === currentId }));
  }

  async revokeSession(userId: string, sessionId: string) {
    const r = await this.db.query(`UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'USER_REVOKED' WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [sessionId, userId]);
    if (!r.rowCount) throw badRequest('Oturum bulunamadı.');
  }

  async revokeOtherSessions(userId: string, keepSessionId: string | null, reason = 'USER_REVOKED_ALL', db: DbClient = this.db) {
    await db.query(`UPDATE user_sessions SET revoked_at = now(), revoked_reason = $3 WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`, [userId, keepSessionId, reason]);
  }

  async requestPasswordReset(email: string) {
    const u = (await this.db.query(`SELECT id, email FROM users WHERE email_normalized = $1 AND status IN ('ACTIVE','PENDING_VERIFICATION','LOCKED')`, [normalizeEmail(email)])).rows[0];
    if (u) {
      const token = await createToken(this.db, u.id, 'PASSWORD_RESET', 60);
      await this.deps.notifications.sendTransactionalEmail({ to: u.email, subject: 'Parola sıfırlama', text: `Parolanızı sıfırlamak için (1 saat geçerli):\n${this.deps.config.APP_BASE_URL}/parola-sifirla?token=${token}\nBu isteği siz yapmadıysanız bu e-postayı yok sayın.` });
    }
    return { message: 'Hesap mevcutsa parola sıfırlama bağlantısı e-posta adresine gönderildi.' };
  }

  async resetPassword(token: string, newPassword: string) {
    validatePassword(newPassword);
    const hash = await hashPassword(newPassword);
    const userId = await withTransaction(this.db, async (c) => {
      const userId = await consumeToken(c, token, 'PASSWORD_RESET');
      await c.query('UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [userId, hash]);
      await this.revokeOtherSessions(userId, null, 'PASSWORD_RESET', c);
      await audit(c, { actorUserId: userId, actorType: 'USER', action: 'user.password_reset', targetType: 'user', targetId: userId });
      return userId;
    });
    await this.deps.notifications.notifyUser({ userId, eventType: 'SECURITY_SETTING_CHANGED', severity: 'WARNING', title: 'Parolanız değiştirildi', body: 'Parolanız sıfırlandı ve tüm oturumlar sonlandırıldı. Bu işlemi siz yapmadıysanız hemen destekle iletişime geçin.' });
  }

  async changePassword(ctx: AuthContext, current: string, next: string) {
    const u = (await this.db.query('SELECT password_hash FROM users WHERE id = $1', [ctx.userId])).rows[0];
    if (!(await verifyPassword(current, u?.password_hash))) throw badRequest('Mevcut parola hatalı.', 'BAD_PASSWORD');
    validatePassword(next);
    const hash = await hashPassword(next);
    await this.db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [ctx.userId, hash]);
    await this.revokeOtherSessions(ctx.userId, ctx.sessionId, 'PASSWORD_CHANGED');
    await audit(this.db, { actorUserId: ctx.userId, actorType: ctx.isStaff ? 'ADMIN' : 'USER', action: 'user.password_change', targetType: 'user', targetId: ctx.userId });
    await this.deps.notifications.notifyUser({ userId: ctx.userId, eventType: 'SECURITY_SETTING_CHANGED', severity: 'WARNING', title: 'Parolanız değiştirildi', body: 'Parolanız değiştirildi ve diğer oturumlar sonlandırıldı.' });
  }

  /** Yönetici daveti kabulü: parola belirlenir. MFA kaydı ilk girişte zorunludur. */
  async acceptInvite(token: string, password: string) {
    validatePassword(password);
    const hash = await hashPassword(password);
    await withTransaction(this.db, async (c) => {
      const userId = await consumeToken(c, token, 'ADMIN_INVITE');
      // Davet bağlantısı yalnızca hesabın e-posta adresine gönderildiği için e-posta sahipliği doğrulanmış olur
      await c.query(
        `UPDATE users SET password_hash = $2, status = 'ACTIVE', email_verified_at = COALESCE(email_verified_at, now()), must_enroll_mfa = true, updated_at = now() WHERE id = $1`,
        [userId, hash],
      );
      await this.revokeOtherSessions(userId, null, 'INVITE_ACCEPTED', c);
      await audit(c, { actorUserId: userId, actorType: 'ADMIN', action: 'admin.invite_accepted', targetType: 'user', targetId: userId });
    });
  }

  // ---- MFA (TOTP) ----

  async startTotp(ctx: AuthContext) {
    const secret = generateTotpSecret();
    await this.db.query(`DELETE FROM mfa_methods WHERE user_id = $1 AND type = 'TOTP' AND confirmed_at IS NULL`, [ctx.userId]);
    const { rows } = await this.db.query(
      `INSERT INTO mfa_methods (user_id, type, secret_ciphertext, label) VALUES ($1,'TOTP',$2,'Doğrulama uygulaması') RETURNING id`,
      [ctx.userId, encrypt(secret, this.key(), `mfa:${ctx.userId}`)],
    );
    // Sır yalnızca bu yanıtta bir kez gösterilir
    return { methodId: rows[0].id, secret, otpauthUri: otpauthUri(secret, ctx.email, 'Su Ödeme Merkezi') };
  }

  async confirmTotp(ctx: AuthContext, code: string) {
    const m = (await this.db.query(`SELECT * FROM mfa_methods WHERE user_id = $1 AND type = 'TOTP' AND confirmed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [ctx.userId])).rows[0];
    if (!m) throw badRequest('Önce doğrulama uygulaması kurulumunu başlatın.');
    const secret = decrypt(m.secret_ciphertext, this.key(), `mfa:${ctx.userId}`);
    const step = verifyTotp(secret, String(code), this.deps.now().getTime());
    if (step == null) throw badRequest('Doğrulama kodu hatalı.', 'INVALID_MFA_CODE');
    const codes = Array.from({ length: 10 }, () => randomToken(6).replace(/[-_]/g, 'x').slice(0, 10).toUpperCase());
    await withTransaction(this.db, async (c) => {
      await c.query(`UPDATE mfa_methods SET disabled_at = now() WHERE user_id = $1 AND type = 'TOTP' AND confirmed_at IS NOT NULL AND disabled_at IS NULL`, [ctx.userId]);
      await c.query('UPDATE mfa_methods SET confirmed_at = now(), last_used_step = $2 WHERE id = $1', [m.id, step]);
      await c.query('DELETE FROM recovery_codes WHERE user_id = $1', [ctx.userId]);
      for (const rc of codes) await c.query('INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1,$2)', [ctx.userId, sha256Hex(rc)]);
      await c.query('UPDATE users SET must_enroll_mfa = false WHERE id = $1', [ctx.userId]);
      await c.query('UPDATE user_sessions SET mfa_verified_at = now() WHERE id = $1', [ctx.sessionId]);
      await audit(c, { actorUserId: ctx.userId, actorType: ctx.isStaff ? 'ADMIN' : 'USER', action: 'mfa.enrolled', targetType: 'user', targetId: ctx.userId, details: { type: 'TOTP' } });
    });
    await this.deps.notifications.notifyUser({ userId: ctx.userId, eventType: 'SECURITY_SETTING_CHANGED', title: 'İki aşamalı doğrulama etkinleştirildi', body: 'Hesabınız için doğrulama uygulaması (TOTP) etkinleştirildi.' });
    return { recoveryCodes: codes };
  }

  /** Oturum için MFA doğrulaması (giriş sonrası veya hassas işlem öncesi yeniden doğrulama). */
  async verifyMfa(ctx: AuthContext, input: { code?: string; recoveryCode?: string }) {
    const fail = async () => {
      await this.db.query('INSERT INTO login_events (user_id, success, reason) VALUES ($1,false,$2)', [ctx.userId, 'BAD_MFA']);
      const recent = await this.db.query(`SELECT count(*) AS n FROM login_events WHERE user_id = $1 AND reason = 'BAD_MFA' AND created_at > now() - interval '15 minutes'`, [ctx.userId]);
      if (Number(recent.rows[0].n) >= MAX_FAILED) {
        await this.revokeOtherSessions(ctx.userId, null, 'MFA_BRUTE_FORCE');
        await this.deps.notifications.alertAdmins({ eventType: 'SECURITY_EVENT', severity: 'CRITICAL', title: 'Çok sayıda hatalı MFA denemesi', body: `Kullanıcı ${ctx.userId} için oturumlar sonlandırıldı.` });
      }
      throw badRequest('Doğrulama kodu hatalı.', 'INVALID_MFA_CODE');
    };
    if (input.recoveryCode) {
      const r = await this.db.query(`UPDATE recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`, [ctx.userId, sha256Hex(input.recoveryCode.trim().toUpperCase())]);
      if (!r.rowCount) return fail();
      await this.deps.notifications.notifyUser({ userId: ctx.userId, eventType: 'SECURITY_SETTING_CHANGED', severity: 'WARNING', title: 'Kurtarma kodu kullanıldı', body: 'Hesabınıza bir kurtarma kodu ile giriş yapıldı. Yeni kodlar oluşturmanızı öneririz.' });
    } else {
      const m = (await this.db.query(`SELECT * FROM mfa_methods WHERE user_id = $1 AND type = 'TOTP' AND confirmed_at IS NOT NULL AND disabled_at IS NULL LIMIT 1`, [ctx.userId])).rows[0];
      if (!m) throw badRequest('Etkin doğrulama yöntemi yok.', 'MFA_NOT_ENROLLED');
      const secret = decrypt(m.secret_ciphertext, this.key(), `mfa:${ctx.userId}`);
      const step = verifyTotp(secret, String(input.code ?? ''), this.deps.now().getTime(), m.last_used_step);
      if (step == null) return fail();
      const upd = await this.db.query('UPDATE mfa_methods SET last_used_step = $2 WHERE id = $1 AND (last_used_step IS NULL OR last_used_step < $2)', [m.id, step]);
      if (!upd.rowCount) return fail();
    }
    await this.db.query('UPDATE user_sessions SET mfa_verified_at = now() WHERE id = $1', [ctx.sessionId]);
  }

  async disableMfa(ctx: AuthContext, password: string) {
    if (ctx.isStaff) throw forbidden('Personel hesaplarında iki aşamalı doğrulama kapatılamaz.', 'MFA_REQUIRED_FOR_STAFF');
    const u = (await this.db.query('SELECT password_hash FROM users WHERE id = $1', [ctx.userId])).rows[0];
    if (!(await verifyPassword(password, u?.password_hash))) throw badRequest('Parola hatalı.', 'BAD_PASSWORD');
    await this.db.query(`UPDATE mfa_methods SET disabled_at = now() WHERE user_id = $1 AND disabled_at IS NULL`, [ctx.userId]);
    await audit(this.db, { actorUserId: ctx.userId, actorType: 'USER', action: 'mfa.disabled', targetType: 'user', targetId: ctx.userId });
    await this.deps.notifications.notifyUser({ userId: ctx.userId, eventType: 'SECURITY_SETTING_CHANGED', severity: 'WARNING', title: 'İki aşamalı doğrulama kapatıldı', body: 'Bu işlemi siz yapmadıysanız hemen parolanızı değiştirin.' });
  }

  async createInvite(db: DbClient, userId: string) {
    return createToken(db, userId, 'ADMIN_INVITE', 24 * 60);
  }
}

