import type { DbClient } from '../db.js';
import { decrypt, encrypt, sha256Hex } from '../lib/crypto.js';
import { maskSecretHint } from '../lib/mask.js';
import { badRequest } from '../lib/errors.js';

export type SecretEnv = 'TEST' | 'LIVE';

export interface SecretMeta {
  ref: string;
  environment: SecretEnv;
  isSet: boolean;
  fingerprint: string | null;
  hint: string | null;
  storage: 'LOCAL_ENCRYPTED' | 'EXTERNAL_SECRET_MANAGER' | null;
  rotatedAt: string | null;
  expiresAt: string | null;
}

const REF_PATTERN = /^(payment|utility|notification)\/(test|live)\/[a-z0-9-]{2,40}$/;

/**
 * Gizli bilgi kasası.
 * - Değerler veritabanında yalnızca AES-256-GCM ile şifreli tutulur (anahtar ortam değişkeninden/KMS'ten gelir),
 *   ya da yalnızca harici secret manager yolu (external_ref) saklanır.
 * - Dışarıya hiçbir zaman değer döndüren bir API yoktur; yalnızca meta veri (tanımlı mı, parmak izi, maskeli ipucu).
 * - `reveal` yalnızca sunucu tarafındaki adaptörler tarafından çağrılır.
 */
export class SecretStore {
  constructor(private readonly key: Buffer) {}

  static validateRef(ref: string, environment: SecretEnv) {
    if (!REF_PATTERN.test(ref)) throw badRequest('Gizli bilgi referansı biçimi geçersiz (ör. payment/test/api-key).');
    const envPart = ref.split('/')[1];
    if ((environment === 'LIVE') !== (envPart === 'live')) {
      throw badRequest('Test ve üretim anahtarları ayrı tutulmalıdır: referans ortamı ile seçilen ortam uyuşmuyor.');
    }
  }

  async put(
    db: DbClient,
    input: { ref: string; environment: SecretEnv; value?: string; externalRef?: string; expiresAt?: string | null; actorId: string | null },
  ): Promise<SecretMeta> {
    SecretStore.validateRef(input.ref, input.environment);
    if (!input.value && !input.externalRef) throw badRequest('Değer veya harici secret manager referansı gerekli.');
    if (input.value && input.value.length < 8) throw badRequest('Gizli değer çok kısa.');
    const ciphertext = input.value ? encrypt(input.value, this.key, input.ref) : null;
    const fingerprint = sha256Hex(input.value ?? input.externalRef!).slice(0, 8);
    const hint = input.value ? maskSecretHint(input.value) : null;
    await db.query(
      `INSERT INTO secret_values (ref, environment, ciphertext, external_ref, fingerprint, last4_hint, expires_at, rotated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (ref) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, external_ref = EXCLUDED.external_ref,
         fingerprint = EXCLUDED.fingerprint, last4_hint = EXCLUDED.last4_hint, expires_at = EXCLUDED.expires_at,
         rotated_by = EXCLUDED.rotated_by, rotated_at = now()`,
      [input.ref, input.environment, ciphertext, input.externalRef ?? null, fingerprint, hint, input.expiresAt ?? null, input.actorId],
    );
    return (await this.meta(db, input.ref))!;
  }

  async meta(db: DbClient, ref: string | null | undefined): Promise<SecretMeta | null> {
    if (!ref) return null;
    const { rows } = await db.query(
      'SELECT ref, environment, ciphertext IS NOT NULL AS local, external_ref IS NOT NULL AS ext, fingerprint, last4_hint, rotated_at, expires_at FROM secret_values WHERE ref = $1',
      [ref],
    );
    const r = rows[0];
    if (!r) return { ref, environment: ref.includes('/live/') ? 'LIVE' : 'TEST', isSet: false, fingerprint: null, hint: null, storage: null, rotatedAt: null, expiresAt: null };
    return {
      ref: r.ref,
      environment: r.environment,
      isSet: true,
      fingerprint: r.fingerprint,
      hint: r.last4_hint,
      storage: r.local ? 'LOCAL_ENCRYPTED' : 'EXTERNAL_SECRET_MANAGER',
      rotatedAt: r.rotated_at?.toISOString?.() ?? null,
      expiresAt: r.expires_at?.toISOString?.() ?? null,
    };
  }

  /** Yalnızca sunucu tarafı adaptörler içindir. Sonuç asla yanıtlara, günlüklere veya denetim kaydına yazılmamalıdır. */
  async reveal(db: DbClient, ref: string | null | undefined): Promise<string | null> {
    if (!ref) return null;
    const { rows } = await db.query('SELECT ciphertext, external_ref FROM secret_values WHERE ref = $1', [ref]);
    const r = rows[0];
    if (!r) return null;
    if (r.ciphertext) return decrypt(r.ciphertext, this.key, ref);
    // Harici secret manager entegrasyonu dağıtım ortamına göre eklenmelidir (bkz. docs/KURULUM.md).
    return null;
  }
}
