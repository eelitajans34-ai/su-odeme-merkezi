-- 0001: Kimlik, roller, yetkiler, oturumlar, MFA
-- Bu dosya yayınlandıktan sonra DEĞİŞTİRİLMEZ. Değişiklikler yeni migration ile yapılır.

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL,
  email_normalized    text NOT NULL UNIQUE,
  email_verified_at   timestamptz,
  phone               text,
  phone_verified_at   timestamptz,
  full_name           text,
  password_hash       text,                -- scrypt; davetle oluşturulan hesapta ilk girişe kadar NULL
  status              text NOT NULL DEFAULT 'PENDING_VERIFICATION'
                      CHECK (status IN ('PENDING_VERIFICATION','ACTIVE','LOCKED','DISABLED','INVITED','DELETED')),
  failed_login_count  integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  must_enroll_mfa     boolean NOT NULL DEFAULT false,
  is_test_account     boolean NOT NULL DEFAULT false,
  last_login_at       timestamptz,
  anonymized_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  is_staff    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  description text NOT NULL,
  requires_mfa boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  granted_by uuid REFERENCES users(id),
  granted_via text NOT NULL CHECK (granted_via IN ('REGISTRATION','BOOTSTRAP_CLI','ADMIN_ACTION')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE user_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       text NOT NULL UNIQUE,        -- SHA-256(oturum belirteci); belirtecin kendisi saklanmaz
  csrf_hash        text,
  client_type      text NOT NULL CHECK (client_type IN ('WEB','MOBILE')),
  ip_address       inet,
  user_agent       text,
  mfa_verified_at  timestamptz,
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoked_reason   text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_sessions_user_idx ON user_sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE mfa_methods (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              text NOT NULL CHECK (type IN ('TOTP','PASSKEY','RECOVERY_CODES')),
  secret_ciphertext text,                      -- AES-256-GCM ile şifreli TOTP sırrı
  label             text,
  confirmed_at      timestamptz,
  last_used_step    bigint,                    -- TOTP tekrar kullanımını engeller
  disabled_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_methods_user_idx ON mfa_methods(user_id);

CREATE TABLE recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- E-posta doğrulama, parola sıfırlama, yönetici daveti için tek kullanımlık belirteçler
CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('EMAIL_VERIFY','PHONE_VERIFY','PASSWORD_RESET','ADMIN_INVITE')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_purpose_idx ON auth_tokens(user_id, purpose);

CREATE TABLE login_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  email_normalized text,
  success     boolean NOT NULL,
  reason      text,
  ip_address  inet,
  user_agent  text,
  suspicious  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_events_user_idx ON login_events(user_id, created_at DESC);

-- Rol ve yetki tanımları (veri; kullanıcı hesabı İÇERMEZ)
INSERT INTO roles (code, name, description, is_staff) VALUES
  ('USER',          'Kullanıcı',          'Platform kullanıcısı', false),
  ('SUPPORT',       'Destek Personeli',   'Destek taleplerini yönetir, maskeli veri görür', true),
  ('FINANCE',       'Finans Personeli',   'İşlem, iade ve mutabakat kayıtlarını yönetir', true),
  ('SUPER_ADMIN',   'Süper Yönetici',     'Tüm yönetim yetkileri; MFA zorunlu', true);

INSERT INTO permissions (code, description, requires_mfa) VALUES
  ('admin.access',                 'Yönetim paneline giriş', true),
  ('users.read',                   'Kullanıcıları görüntüleme', true),
  ('users.manage',                 'Kullanıcı durumunu yönetme', true),
  ('roles.assign',                 'Rol atama/kaldırma', true),
  ('payment_service.read',         'Güvenli ödeme hizmeti ayarlarını görüntüleme', true),
  ('payment_service.manage',       'Güvenli ödeme hizmeti ayarlarını değiştirme', true),
  ('utility_integration.read',     'Su idaresi entegrasyonunu görüntüleme', true),
  ('utility_integration.manage',   'Su idaresi entegrasyonunu değiştirme', true),
  ('secrets.write',                'Gizli anahtar girme/döndürme (yalnızca yazma)', true),
  ('transactions.read',            'İşlem kayıtlarını görüntüleme', true),
  ('refunds.request',              'İade talebi oluşturma', true),
  ('refunds.approve',              'İade onaylama', true),
  ('reconciliation.run',           'Mutabakat çalıştırma ve inceleme', true),
  ('audit.read',                   'Denetim kayıtlarını görüntüleme', true),
  ('alerts.manage',                'Sistem uyarılarını yönetme', true),
  ('fees.manage',                  'Komisyon/ücret/limit ayarları', true),
  ('support.manage',               'Destek taleplerini yönetme', true),
  ('system.read',                  'Sistem sağlığı, yedekleme ve bakım durumu', true),
  ('golive.manage',                'Yayın öncesi kontrol listesini yönetme', true),
  ('legal.manage',                 'Hukuki metinleri yönetme', true);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.code = 'SUPER_ADMIN';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.code IN ('admin.access','users.read','transactions.read','support.manage','refunds.request')
WHERE r.code = 'SUPPORT';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.code IN ('admin.access','transactions.read','refunds.request','reconciliation.run','payment_service.read','utility_integration.read')
WHERE r.code = 'FINANCE';
