import type { FastifyReply, FastifyRequest } from 'fastify';
import { sha256Hex, safeEqualHex } from '../lib/crypto.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import type { Actor } from '../context.js';
import type { AuthContext, AuthService } from './service.js';

export const SESSION_COOKIE = 'su_session';
export const CSRF_COOKIE = 'su_csrf';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface GuardOptions {
  /** MFA'sı olan kullanıcının henüz MFA doğrulamadığı oturumda izin verilsin mi (yalnızca MFA doğrulama/çıkış uçları) */
  allowMfaPending?: boolean;
}

export function makeGuards(auth: AuthService, getMfaMaxAgeMinutes: () => Promise<number>) {
  async function resolve(req: FastifyRequest): Promise<{ ctx: AuthContext; viaCookie: boolean } | null> {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const ctx = await auth.authenticate(header.slice(7).trim());
      return ctx ? { ctx, viaCookie: false } : null;
    }
    const cookie = req.cookies?.[SESSION_COOKIE];
    if (cookie) {
      const ctx = await auth.authenticate(cookie);
      return ctx ? { ctx, viaCookie: true } : null;
    }
    return null;
  }

  function requireAuth(opts: GuardOptions = {}) {
    return async (req: FastifyRequest, _reply: FastifyReply) => {
      const r = await resolve(req);
      if (!r) throw unauthorized();
      // Çerez tabanlı oturumlarda durum değiştiren isteklerde CSRF (double-submit + oturuma bağlı özet)
      if (r.viaCookie && !SAFE_METHODS.has(req.method)) {
        const token = req.headers['x-csrf-token'];
        if (typeof token !== 'string' || !r.ctx.csrfHash || !safeEqualHex(sha256Hex(token), r.ctx.csrfHash)) {
          throw forbidden('CSRF doğrulaması başarısız.', 'CSRF_FAILED');
        }
      }
      if (r.ctx.hasMfa && !r.ctx.mfaVerifiedAt && !opts.allowMfaPending) {
        throw new AppError(401, 'MFA_REQUIRED', 'İki aşamalı doğrulama kodu gerekli.');
      }
      req.auth = r.ctx;
    };
  }

  /**
   * Yetki kontrolü sunucu tarafında, veritabanındaki rol/yetki ile yapılır.
   * Tüm yönetim yetkileri MFA gerektirir; `fresh` hassas işlemler için son N dakikada MFA doğrulaması ister.
   */
  function requirePermission(permission: string, opts: { fresh?: boolean } = {}) {
    const base = requireAuth();
    return async (req: FastifyRequest, reply: FastifyReply) => {
      await base(req, reply);
      const ctx = req.auth!;
      if (!ctx.permissions.has(permission)) throw forbidden();
      if (!ctx.hasMfa) throw forbidden('Yönetim işlemleri için iki aşamalı doğrulamayı etkinleştirmelisiniz.', 'MFA_ENROLLMENT_REQUIRED');
      if (!ctx.mfaVerifiedAt) throw new AppError(401, 'MFA_REQUIRED', 'İki aşamalı doğrulama kodu gerekli.');
      if (opts.fresh) {
        const maxAge = await getMfaMaxAgeMinutes();
        if (Date.now() - new Date(ctx.mfaVerifiedAt).getTime() > maxAge * 60_000) {
          throw new AppError(401, 'MFA_STEP_UP_REQUIRED', 'Bu hassas işlem için iki aşamalı doğrulama kodunu yeniden girin.');
        }
      }
    };
  }

  return { requireAuth, requirePermission };
}

export function actorOf(req: FastifyRequest): Actor {
  return { userId: req.auth!.userId, ip: req.ip, userAgent: req.headers['user-agent'] ?? null };
}
