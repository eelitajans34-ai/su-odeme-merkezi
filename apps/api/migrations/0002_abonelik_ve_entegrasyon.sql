-- 0002: Su idareleri, entegrasyon ayarları, abonelikler, su kartları, gizli bilgi kasası

-- Gizli bilgiler: yalnızca şifreli metin (AES-256-GCM) veya harici secret manager referansı.
-- Düz metin anahtar bu tabloda ASLA tutulmaz.
CREATE TABLE secret_values (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref              text NOT NULL UNIQUE,      -- ör. "db:payment/test/api-key"
  environment      text NOT NULL CHECK (environment IN ('TEST','LIVE')),
  ciphertext       text,                      -- yerel şifreli kasa kullanılıyorsa
  external_ref     text,                      -- bulut secret manager yolu kullanılıyorsa
  fingerprint      text NOT NULL,             -- SHA-256 ilk 8 hane; değeri ifşa etmez
  last4_hint       text,                      -- maskelenmiş ipucu ("••••ab12"), isteğe bağlı
  expires_at       timestamptz,
  rotated_at       timestamptz NOT NULL DEFAULT now(),
  rotated_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ciphertext IS NOT NULL OR external_ref IS NOT NULL)
);

CREATE TABLE water_utilities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE,
  full_name         text NOT NULL,
  city              text,
  is_active         boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE utility_integrations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id             uuid NOT NULL REFERENCES water_utilities(id) ON DELETE RESTRICT,
  environment            text NOT NULL CHECK (environment IN ('TEST','LIVE')),
  adapter_code           text NOT NULL DEFAULT 'NONE',  -- NONE | SANDBOX | <kurum dokümanına göre yazılacak adaptör>
  integration_code       text,
  technical_contact      jsonb NOT NULL DEFAULT '{}'::jsonb,
  agreement_status       text NOT NULL DEFAULT 'NOT_STARTED'
                         CHECK (agreement_status IN ('NOT_STARTED','IN_NEGOTIATION','SIGNED','REVOKED')),
  authorization_status   text NOT NULL DEFAULT 'AWAITING'
                         CHECK (authorization_status IN ('AWAITING','TEST_ACCESS','PRODUCTION_ACCESS','REVOKED')),
  api_base_url           text,
  auth_method            text CHECK (auth_method IN ('API_KEY','OAUTH2_CLIENT_CREDENTIALS','MUTUAL_TLS','OTHER')),
  credential_secret_ref  text REFERENCES secret_values(ref),
  certificate_secret_ref text REFERENCES secret_values(ref),
  supports_account_query boolean NOT NULL DEFAULT false,
  supports_card_topup    boolean NOT NULL DEFAULT false,
  supports_bill_query    boolean NOT NULL DEFAULT false,
  supports_bill_payment  boolean NOT NULL DEFAULT false,
  supports_status_query  boolean NOT NULL DEFAULT false,
  supports_reconciliation boolean NOT NULL DEFAULT false,
  last_connection_test_at timestamptz,
  last_connection_test_ok boolean,
  last_success_at        timestamptz,
  last_error_at          timestamptz,
  last_error             text,
  documentation_ref      text,
  agreement_document_ref text,
  updated_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (utility_id, environment)
);

CREATE TABLE subscriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  utility_id       uuid NOT NULL REFERENCES water_utilities(id) ON DELETE RESTRICT,
  subscriber_no    text NOT NULL,             -- yalnızca entegrasyon için; ekranlarda maskelenir
  nickname         text,
  verification_status text NOT NULL DEFAULT 'UNVERIFIED'
                   CHECK (verification_status IN ('UNVERIFIED','VERIFIED','REJECTED','INTEGRATION_PENDING')),
  verified_at      timestamptz,
  holder_name_masked text,                    -- su idaresinden dönen maskeli ad (varsa)
  source           text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','QR')),
  is_test_data     boolean NOT NULL DEFAULT false,
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscriptions_unique_active ON subscriptions(user_id, utility_id, subscriber_no) WHERE deleted_at IS NULL;
CREATE INDEX subscriptions_user_idx ON subscriptions(user_id) WHERE deleted_at IS NULL;

CREATE TABLE water_cards (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id  uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  card_serial      text NOT NULL,              -- ekranlarda maskelenir
  meter_type       text,
  topup_method     text NOT NULL DEFAULT 'UNKNOWN'
                   CHECK (topup_method IN ('UNKNOWN','REMOTE_CREDIT','CARD_WRITE_AT_TERMINAL','NOT_SUPPORTED')),
  nickname         text,
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX water_cards_unique_active ON water_cards(subscription_id, card_serial) WHERE deleted_at IS NULL;
CREATE INDEX water_cards_user_idx ON water_cards(user_id) WHERE deleted_at IS NULL;
