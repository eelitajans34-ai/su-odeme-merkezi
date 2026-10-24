import type { FastifyInstance } from 'fastify';
import type { Deps } from '../context.js';
import { CSRF_COOKIE, SESSION_COOKIE, type makeGuards } from '../auth/guards.js';
import type { AuthService } from '../auth/service.js';
import { parse, z } from '../lib/validate.js';
import { maskEmail } from '../lib/mask.js';

type Guards = ReturnType<typeof makeGuards>;

const email = z.email().max(254);

export async function authRoutes(app: FastifyInstance, { deps, auth, guards }: { deps: Deps; auth: AuthService; guards: Guards }) {
  // Kaba kuvvet koruması: kimlik doğrulama uçlarında IP başına dakikalık sınır
  const strictRate = { config: { rateLimit: { max: deps.config.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } };
  const cookieOpts = { path: '/', sameSite: 'strict' as const, secure: deps.config.isProduction, maxAge: 14 * 24 * 3600 };
  const meta = (req: any) => ({ ip: req.ip, ua: req.headers['user-agent'] });

  // .strict(): "role", "isAdmin" gibi ek alanlar reddedilir — rol istemciden belirlenemez
  app.post('/api/auth/register', strictRate, async (req) => {
    const body = parse(
      z.object({
        email,
        password: z.string(),
        fullName: z.string().trim().min(2).max(120).optional(),
        phone: z.string().regex(/^\+?[0-9 ]{10,16}$/).optional(),
        consentDocumentIds: z.array(z.uuid()).max(10).optional(),
      }).strict(),
      req.body,
    );
    return auth.register(body, meta(req));
  });

  app.post('/api/auth/verify-email', strictRate, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }).strict(), req.body);
    await auth.verifyEmail(token);
    return { ok: true };
  });

  app.post('/api/auth/login', strictRate, async (req, reply) => {
    const body = parse(z.object({ email, password: z.string().max(200), clientType: z.enum(['WEB', 'MOBILE']).default('WEB') }).strict(), req.body);
    const r = await auth.login(body, meta(req));
    if (body.clientType === 'WEB') {
      reply.setCookie(SESSION_COOKIE, r.token, { ...cookieOpts, httpOnly: true });
      reply.setCookie(CSRF_COOKIE, r.csrfToken, { ...cookieOpts, httpOnly: false });
      return { csrfToken: r.csrfToken, mfaRequired: r.mfaRequired, mfaEnrollmentRequired: r.mfaEnrollmentRequired };
    }
    // Mobil: belirteç cihazın güvenli deposunda (Keychain/Keystore) saklanmalıdır
    return { token: r.token, mfaRequired: r.mfaRequired, mfaEnrollmentRequired: r.mfaEnrollmentRequired };
  });

  app.post('/api/auth/logout', { preHandler: guards.requireAuth({ allowMfaPending: true }) }, async (req, reply) => {
    await auth.logout(req.auth!.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: guards.requireAuth({ allowMfaPending: true }) }, async (req) => {
    const a = req.auth!;
    const u = (await deps.db.query('SELECT full_name, phone, email_verified_at, phone_verified_at, is_test_account FROM users WHERE id = $1', [a.userId])).rows[0];
    return {
      id: a.userId,
      email: a.email,
      emailMasked: maskEmail(a.email),
      fullName: u.full_name,
      phone: u.phone,
      emailVerified: !!u.email_verified_at,
      roles: a.roles,
      permissions: [...a.permissions],
      isStaff: a.isStaff,
      mfa: { enrolled: a.hasMfa, verifiedThisSession: !!a.mfaVerifiedAt, enrollmentRequired: (a.mustEnrollMfa || a.isStaff) && !a.hasMfa },
      isTestAccount: u.is_test_account,
    };
  });

  app.post('/api/auth/mfa/verify', { ...strictRate, preHandler: guards.requireAuth({ allowMfaPending: true }) }, async (req) => {
    const body = parse(z.object({ code: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().max(20).optional() }).strict(), req.body);
    await auth.verifyMfa(req.auth!, body);
    return { ok: true };
  });

  app.post('/api/auth/mfa/totp/start', { ...strictRate, preHandler: guards.requireAuth() }, async (req) => auth.startTotp(req.auth!));

  app.post('/api/auth/mfa/totp/confirm', { ...strictRate, preHandler: guards.requireAuth() }, async (req) => {
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/) }).strict(), req.body);
    return auth.confirmTotp(req.auth!, code);
  });

  app.post('/api/auth/mfa/disable', { ...strictRate, preHandler: guards.requireAuth() }, async (req) => {
    const { password } = parse(z.object({ password: z.string().max(200) }).strict(), req.body);
    await auth.disableMfa(req.auth!, password);
    return { ok: true };
  });

  app.post('/api/auth/password/forgot', strictRate, async (req) => {
    const body = parse(z.object({ email }).strict(), req.body);
    return auth.requestPasswordReset(body.email);
  });

  app.post('/api/auth/password/reset', strictRate, async (req) => {
    const body = parse(z.object({ token: z.string().min(10).max(200), password: z.string() }).strict(), req.body);
    await auth.resetPassword(body.token, body.password);
    return { ok: true };
  });

  app.post('/api/auth/password/change', { ...strictRate, preHandler: guards.requireAuth() }, async (req) => {
    const body = parse(z.object({ currentPassword: z.string().max(200), newPassword: z.string() }).strict(), req.body);
    await auth.changePassword(req.auth!, body.currentPassword, body.newPassword);
    return { ok: true };
  });

  app.post('/api/auth/invite/accept', strictRate, async (req) => {
    const body = parse(z.object({ token: z.string().min(10).max(200), password: z.string() }).strict(), req.body);
    await auth.acceptInvite(body.token, body.password);
    return { ok: true, next: 'Giriş yapın ve iki aşamalı doğrulamayı (TOTP) kurun.' };
  });

  app.get('/api/auth/sessions', { preHandler: guards.requireAuth() }, async (req) => auth.listSessions(req.auth!.userId, req.auth!.sessionId));

  app.delete('/api/auth/sessions/:id', { preHandler: guards.requireAuth() }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    await auth.revokeSession(req.auth!.userId, id);
    return { ok: true };
  });

  app.post('/api/auth/sessions/revoke-others', { preHandler: guards.requireAuth() }, async (req) => {
    await auth.revokeOtherSessions(req.auth!.userId, req.auth!.sessionId);
    return { ok: true };
  });
}
