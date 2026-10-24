-- 0003: Ödeme sağlayıcıları, ücretler, işlemler, iadeler, makbuzlar, webhook olayları

CREATE TABLE payment_providers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,      -- iç kod; gerçek sağlayıcı adı sözleşme sonrası girilir
  display_name  text NOT NULL,
  adapter_code  text NOT NULL DEFAULT 'NONE',   -- NONE | SANDBOX | <sağlayıcı dokümanına göre yazılacak adaptör>
  is_active     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_provider_configs (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id                uuid NOT NULL REFERENCES payment_providers(id) ON DELETE RESTRICT,
  environment                text NOT NULL CHECK (environment IN ('TEST','LIVE')),
  api_base_url               text,
  merchant_id                text,
  api_key_secret_ref         text REFERENCES secret_values(ref),
  webhook_secret_ref         text REFERENCES secret_values(ref),
  webhook_url                text,
  webhook_signature_required boolean NOT NULL DEFAULT true,
  webhook_tolerance_seconds  integer NOT NULL DEFAULT 300 CHECK (webhook_tolerance_seconds BETWEEN 30 AND 900),
  currency                   char(3) NOT NULL DEFAULT 'TRY',
  min_amount_minor           bigint NOT NULL DEFAULT 100,
  max_amount_minor           bigint NOT NULL DEFAULT 500000,
  daily_user_limit_minor     bigint NOT NULL DEFAULT 1000000,
  allowed_ips                text[] NOT NULL DEFAULT '{}',
  supports_refund            boolean NOT NULL DEFAULT false,
  last_connection_test_at    timestamptz,
  last_connection_test_ok    boolean,
  last_connection_error      text,
  last_success_at            timestamptz,
  certificate_expires_at     timestamptz,
  updated_by                 uuid REFERENCES users(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, environment),
  CHECK (min_amount_minor > 0 AND max_amount_minor >= min_amount_minor)
);

-- Platformun hangi ortamda çalıştığı (TEST/LIVE) ve hangi sağlayıcının etkin olduğu
CREATE TABLE payment_service_state (
  id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
  active_provider_id    uuid REFERENCES payment_providers(id),
  mode                  text NOT NULL DEFAULT 'TEST' CHECK (mode IN ('TEST','LIVE')),
  live_enabled_at       timestamptz,
  live_enabled_by       uuid REFERENCES users(id),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO payment_service_state (id, mode) VALUES (true, 'TEST');

CREATE TABLE payment_provider_contracts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id           uuid NOT NULL REFERENCES payment_providers(id) ON DELETE RESTRICT UNIQUE,
  legal_name            text,
  contract_number       text,
  contract_date         date,
  service_start_date    date,
  authorized_contact    jsonb NOT NULL DEFAULT '{}'::jsonb,
  support_channel       text,
  contract_document_ref text,
  test_access_status    text NOT NULL DEFAULT 'NONE' CHECK (test_access_status IN ('NONE','REQUESTED','GRANTED')),
  production_access_status text NOT NULL DEFAULT 'NONE' CHECK (production_access_status IN ('NONE','REQUESTED','GRANTED')),
  live_approval_status  text NOT NULL DEFAULT 'NOT_APPROVED' CHECK (live_approval_status IN ('NOT_APPROVED','PENDING','APPROVED')),
  updated_by            uuid REFERENCES users(id),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Ücret tarifeleri: sürümlü, yürürlük tarihli, değişiklik geçmişi korunur (UPDATE yerine yeni satır)
CREATE TABLE fee_schedules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_type     text NOT NULL CHECK (transaction_type IN ('TOPUP','BILL_PAYMENT')),
  fee_type             text NOT NULL CHECK (fee_type IN ('NONE','FIXED','PERCENT','FIXED_PLUS_PERCENT')),
  fixed_fee_minor      bigint NOT NULL DEFAULT 0 CHECK (fixed_fee_minor >= 0),
  percent_bps          integer NOT NULL DEFAULT 0 CHECK (percent_bps BETWEEN 0 AND 10000),
  min_fee_minor        bigint NOT NULL DEFAULT 0,
  max_fee_minor        bigint,
  min_amount_minor     bigint NOT NULL DEFAULT 100,
  max_amount_minor     bigint NOT NULL DEFAULT 500000,
  user_facing_description text NOT NULL,
  is_sample            boolean NOT NULL DEFAULT true,   -- sözleşmeye dayanmayan örnek/test tarife
  effective_from       timestamptz NOT NULL,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fee_schedules_effective_idx ON fee_schedules(transaction_type, effective_from DESC);

-- Ödeme sağlayıcısı tarafındaki tahsilat kaydı (yükleme ve fatura için ortak)
CREATE TABLE payment_transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref            text NOT NULL UNIQUE,          -- sağlayıcıya iletilen sipariş no
  user_id               uuid NOT NULL REFERENCES users(id),
  provider_id           uuid NOT NULL REFERENCES payment_providers(id),
  environment           text NOT NULL CHECK (environment IN ('TEST','LIVE')),
  purpose               text NOT NULL CHECK (purpose IN ('TOPUP','BILL_PAYMENT')),
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  currency              char(3) NOT NULL,
  status                text NOT NULL CHECK (status IN ('INITIATED','PENDING','SUCCEEDED','FAILED','CANCELLED','UNKNOWN','REFUNDED','PARTIALLY_REFUNDED')),
  provider_payment_ref  text,
  provider_token_ref    text,      -- sağlayıcının tokenizasyon referansı; kart verisi SAKLANMAZ
  checkout_url          text,
  failure_code          text,
  failure_message       text,
  confirmed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_transactions_provider_ref ON payment_transactions(provider_id, provider_payment_ref) WHERE provider_payment_ref IS NOT NULL;
CREATE INDEX payment_transactions_status_idx ON payment_transactions(status, created_at);

CREATE TABLE topup_transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref            text NOT NULL UNIQUE,           -- kullanıcıya gösterilen işlem no
  user_id               uuid NOT NULL REFERENCES users(id),
  water_card_id         uuid NOT NULL REFERENCES water_cards(id),
  subscription_id       uuid NOT NULL REFERENCES subscriptions(id),
  utility_id            uuid NOT NULL REFERENCES water_utilities(id),
  environment           text NOT NULL CHECK (environment IN ('TEST','LIVE')),
  idempotency_key       text NOT NULL,
  status                text NOT NULL CHECK (status IN ('CREATED','AWAITING_PAYMENT','PAYMENT_PENDING','PAYMENT_CONFIRMED','TOPUP_PENDING','COMPLETED','FAILED','UNKNOWN','REFUND_PENDING','REFUNDED','REQUIRES_REVIEW')),
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  fee_minor             bigint NOT NULL CHECK (fee_minor >= 0),
  total_minor           bigint NOT NULL CHECK (total_minor = amount_minor + fee_minor),
  currency              char(3) NOT NULL DEFAULT 'TRY',
  fee_schedule_id       uuid REFERENCES fee_schedules(id),
  payment_transaction_id uuid REFERENCES payment_transactions(id),
  utility_request_id    text NOT NULL UNIQUE,           -- su idaresine gönderilen tekil istek no (mükerrer önleme)
  utility_ref           text,
  utility_submit_attempts integer NOT NULL DEFAULT 0,
  status_check_count    integer NOT NULL DEFAULT 0,
  utility_last_checked_at timestamptz,
  next_check_at         timestamptz,
  error_code            text,
  error_message         text,
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX topup_transactions_user_idx ON topup_transactions(user_id, created_at DESC);
CREATE INDEX topup_transactions_status_idx ON topup_transactions(status, next_check_at);

CREATE TABLE bill_payment_transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref            text NOT NULL UNIQUE,
  user_id               uuid NOT NULL REFERENCES users(id),
  subscription_id       uuid NOT NULL REFERENCES subscriptions(id),
  utility_id            uuid NOT NULL REFERENCES water_utilities(id),
  environment           text NOT NULL CHECK (environment IN ('TEST','LIVE')),
  idempotency_key       text NOT NULL,
  status                text NOT NULL CHECK (status IN ('CREATED','BILL_QUERY_PENDING','BILL_FOUND','AWAITING_PAYMENT','PAYMENT_PENDING','PAYMENT_CONFIRMED','COLLECTION_PENDING','COMPLETED','FAILED','UNKNOWN','REFUND_PENDING','REFUNDED','REQUIRES_REVIEW')),
  amount_minor          bigint CHECK (amount_minor IS NULL OR amount_minor > 0),
  fee_minor             bigint CHECK (fee_minor IS NULL OR fee_minor >= 0),
  total_minor           bigint,
  currency              char(3) NOT NULL DEFAULT 'TRY',
  fee_schedule_id       uuid REFERENCES fee_schedules(id),
  payment_transaction_id uuid REFERENCES payment_transactions(id),
  utility_request_id    text NOT NULL UNIQUE,
  utility_ref           text,
  utility_submit_attempts integer NOT NULL DEFAULT 0,
  status_check_count    integer NOT NULL DEFAULT 0,
  utility_last_checked_at timestamptz,
  next_check_at         timestamptz,
  error_code            text,
  error_message         text,
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CHECK (total_minor IS NULL OR total_minor = amount_minor + fee_minor)
);
CREATE INDEX bill_payment_transactions_user_idx ON bill_payment_transactions(user_id, created_at DESC);
CREATE INDEX bill_payment_transactions_status_idx ON bill_payment_transactions(status, next_check_at);

CREATE TABLE bill_inquiries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_payment_transaction_id uuid NOT NULL REFERENCES bill_payment_transactions(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users(id),
  subscription_id       uuid NOT NULL REFERENCES subscriptions(id),
  status                text NOT NULL CHECK (status IN ('PENDING','FOUND','NO_DEBT','FAILED','INTEGRATION_NOT_CONFIGURED')),
  bills                 jsonb NOT NULL DEFAULT '[]'::jsonb,   -- su idaresinden dönen fatura listesi (anlık görüntü)
  total_debt_minor      bigint,
  selected_bill_ids     text[] NOT NULL DEFAULT '{}',
  queried_at            timestamptz,
  expires_at            timestamptz,
  error_message         text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_transaction_id uuid NOT NULL REFERENCES payment_transactions(id),
  source_type           text NOT NULL CHECK (source_type IN ('TOPUP','BILL_PAYMENT')),
  source_id             uuid NOT NULL,
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  reason                text NOT NULL,
  status                text NOT NULL CHECK (status IN ('PENDING_APPROVAL','APPROVED','SUBMITTED','COMPLETED','REJECTED','FAILED','MANUAL_ACTION_REQUIRED')),
  requested_by          uuid REFERENCES users(id),
  requested_via         text NOT NULL CHECK (requested_via IN ('SYSTEM','USER','ADMIN')),
  approved_by           uuid REFERENCES users(id),
  approved_at           timestamptz,
  provider_refund_ref   text,
  verified_at           timestamptz,
  verification_method   text CHECK (verification_method IN ('PROVIDER_WEBHOOK','PROVIDER_STATUS_QUERY','MANUAL_EVIDENCE')),
  evidence_ref          text,
  failure_message       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX refunds_one_open_per_payment ON refunds(payment_transaction_id)
  WHERE status IN ('PENDING_APPROVAL','APPROVED','SUBMITTED','MANUAL_ACTION_REQUIRED');

CREATE TABLE receipts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no            text NOT NULL UNIQUE,
  user_id               uuid NOT NULL REFERENCES users(id),
  source_type           text NOT NULL CHECK (source_type IN ('TOPUP','BILL_PAYMENT')),
  source_id             uuid NOT NULL,
  environment           text NOT NULL CHECK (environment IN ('TEST','LIVE')),
  content               jsonb NOT NULL,          -- maskeli veriler; kart/abone numarası tam hâliyle yazılmaz
  issued_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)
);

CREATE TABLE webhook_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source                text NOT NULL CHECK (source IN ('PAYMENT_PROVIDER','WATER_UTILITY')),
  provider_id           uuid,
  event_id              text,
  event_type            text,
  signature_valid       boolean NOT NULL,
  rejection_reason      text,
  received_at           timestamptz NOT NULL DEFAULT now(),
  event_timestamp       timestamptz,
  payload               jsonb,                   -- hassas alanlar ayıklanmış hâli
  processed_at          timestamptz,
  processing_error      text
);
CREATE UNIQUE INDEX webhook_events_unique ON webhook_events(source, provider_id, event_id) WHERE event_id IS NOT NULL AND signature_valid;

-- Geçerli durum geçişlerinin izi (state machine geçmişi)
CREATE TABLE transaction_status_history (
  id            bigserial PRIMARY KEY,
  source_type   text NOT NULL CHECK (source_type IN ('TOPUP','BILL_PAYMENT')),
  source_id     uuid NOT NULL,
  from_status   text,
  to_status     text NOT NULL,
  reason        text,
  actor         text NOT NULL,          -- SYSTEM | WEBHOOK | WORKER | ADMIN:<id> | USER:<id>
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transaction_status_history_src_idx ON transaction_status_history(source_type, source_id);
