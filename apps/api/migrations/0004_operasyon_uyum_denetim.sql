-- 0004: Mutabakat, bildirimler, destek, denetim, sistem ayarları, hukuki metinler, yayın kontrolü

CREATE TABLE reconciliation_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start     timestamptz NOT NULL,
  period_end       timestamptz NOT NULL,
  environment      text NOT NULL CHECK (environment IN ('TEST','LIVE')),
  status           text NOT NULL CHECK (status IN ('RUNNING','COMPLETED','COMPLETED_WITH_ISSUES','FAILED','SKIPPED_NOT_CONFIGURED')),
  provider_source  text NOT NULL,      -- PROVIDER_API | NOT_CONFIGURED
  utility_source   text NOT NULL,      -- UTILITY_API | NOT_CONFIGURED
  matched_count    integer NOT NULL DEFAULT 0,
  issue_count      integer NOT NULL DEFAULT 0,
  notes            text,
  started_by       uuid REFERENCES users(id),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  CHECK (period_end > period_start)
);

CREATE TABLE reconciliation_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  issue_type       text NOT NULL CHECK (issue_type IN ('MATCHED','AMOUNT_MISMATCH','STATUS_MISMATCH','MISSING_AT_PROVIDER','MISSING_AT_UTILITY','MISSING_LOCALLY','DUPLICATE_SUSPECT','MISSING_RECEIPT')),
  source_type      text CHECK (source_type IN ('TOPUP','BILL_PAYMENT')),
  source_id        uuid,
  local_amount_minor bigint,
  provider_amount_minor bigint,
  utility_amount_minor bigint,
  local_status     text,
  provider_status  text,
  utility_status   text,
  provider_ref     text,
  utility_ref      text,
  review_status    text NOT NULL DEFAULT 'OPEN' CHECK (review_status IN ('OPEN','RESOLVED','NOT_AN_ISSUE','NA')),
  reviewed_by      uuid REFERENCES users(id),
  reviewed_at      timestamptz,
  review_note      text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reconciliation_items_open_idx ON reconciliation_items(review_status) WHERE review_status = 'OPEN';

CREATE TABLE notification_channels (
  channel          text PRIMARY KEY CHECK (channel IN ('EMAIL','SMS','PUSH','IN_APP')),
  provider_name    text,
  secret_ref       text REFERENCES secret_values(ref),
  status           text NOT NULL DEFAULT 'NOT_CONFIGURED' CHECK (status IN ('NOT_CONFIGURED','TEST','ACTIVE','DISABLED')),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO notification_channels (channel, status) VALUES
  ('EMAIL','NOT_CONFIGURED'), ('SMS','NOT_CONFIGURED'), ('PUSH','NOT_CONFIGURED'), ('IN_APP','ACTIVE');

CREATE TABLE notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  audience         text NOT NULL DEFAULT 'USER' CHECK (audience IN ('USER','ADMIN')),
  event_type       text NOT NULL,
  severity         text NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  title            text NOT NULL,
  body             text NOT NULL,
  data             jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at          timestamptz,
  acknowledged_by  uuid REFERENCES users(id),
  acknowledged_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX notifications_admin_idx ON notifications(audience, acknowledged_at) WHERE audience = 'ADMIN';

-- Her kanal için gönderim denemesi; sağlayıcı yoksa NOT_SENT_PROVIDER_NOT_CONFIGURED yazılır, sahte "gönderildi" yazılmaz
CREATE TABLE notification_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id  uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel          text NOT NULL CHECK (channel IN ('EMAIL','SMS','PUSH','IN_APP')),
  status           text NOT NULL CHECK (status IN ('DELIVERED_IN_APP','QUEUED','SENT','FAILED','NOT_SENT_PROVIDER_NOT_CONFIGURED','DEV_OUTBOX_ONLY')),
  provider_message_ref text,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE push_devices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform         text NOT NULL CHECK (platform IN ('ANDROID','IOS')),
  push_token       text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz
);

CREATE TABLE support_tickets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_no        text NOT NULL UNIQUE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category         text NOT NULL CHECK (category IN ('REFUND','TRANSACTION','ACCOUNT','KVKK_REQUEST','OTHER')),
  subject          text NOT NULL,
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','WAITING_USER','RESOLVED','CLOSED')),
  related_type     text CHECK (related_type IN ('TOPUP','BILL_PAYMENT')),
  related_id       uuid,
  assigned_to      uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE support_ticket_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id        uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id        uuid REFERENCES users(id),
  author_role      text NOT NULL CHECK (author_role IN ('USER','STAFF','SYSTEM')),
  body             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Denetim kaydı: yalnızca ekleme. Parola/OTP/anahtar/kart bilgisi uygulama katmanında ayıklanır.
CREATE TABLE audit_logs (
  id               bigserial PRIMARY KEY,
  actor_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type       text NOT NULL CHECK (actor_type IN ('USER','ADMIN','SYSTEM','CLI')),
  action           text NOT NULL,
  target_type      text,
  target_id        text,
  ip_address       inet,
  user_agent       text,
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs(created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs(actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs yalnızca ekleme yapılabilir bir tablodur';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

CREATE TABLE system_settings (
  key              text PRIMARY KEY,
  value            jsonb NOT NULL,
  description      text,
  updated_by       uuid REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_settings (key, value, description) VALUES
  ('maintenance_mode', 'false'::jsonb, 'Bakım modu açıkken yeni ödeme başlatılmaz'),
  ('pending_alert_minutes', '30'::jsonb, 'Bu süreden uzun bekleyen işlemler için yönetici uyarısı'),
  ('utility_status_max_checks', '12'::jsonb, 'Belirsiz işlem için en fazla durum sorgusu; sonra REQUIRES_REVIEW'),
  ('admin_mfa_max_age_minutes', '15'::jsonb, 'Hassas yönetici işlemleri için MFA doğrulamasının geçerlilik süresi'),
  ('retention_policy', '{"transactions_years":10,"audit_logs_years":2,"login_events_days":365,"support_tickets_years":3}'::jsonb,
     'Saklama süreleri ÖRNEKTİR; hukuk danışmanı ile doğrulanmalıdır');

CREATE TABLE legal_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type         text NOT NULL CHECK (doc_type IN ('KVKK_NOTICE','PRIVACY_POLICY','TERMS_OF_USE','COOKIE_POLICY','RETENTION_POLICY','EXPLICIT_CONSENT')),
  version          text NOT NULL,
  title            text NOT NULL,
  body_markdown    text NOT NULL,
  is_draft         boolean NOT NULL DEFAULT true,     -- hukuk onayı olmadan yayımlanmış sayılmaz
  legal_reviewed_by text,
  published_at     timestamptz,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_type, version)
);

CREATE TABLE consent_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id      uuid NOT NULL REFERENCES legal_documents(id),
  action           text NOT NULL CHECK (action IN ('ACKNOWLEDGED','GRANTED','WITHDRAWN')),
  ip_address       inet,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_records_user_idx ON consent_records(user_id);

-- Yayın öncesi zorunlu kontrol listesi (bölüm 15). Kanıt referansı olmadan madde "doğrulandı" olamaz.
CREATE TABLE golive_checklist_items (
  code             text PRIMARY KEY,
  title            text NOT NULL,
  is_automated     boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','VERIFIED','REJECTED')),
  evidence_ref     text,
  verified_by      uuid REFERENCES users(id),
  verified_at      timestamptz,
  note             text,
  sort_order       integer NOT NULL,
  CHECK (status <> 'VERIFIED' OR (evidence_ref IS NOT NULL AND verified_by IS NOT NULL))
);
INSERT INTO golive_checklist_items (code, title, is_automated, sort_order) VALUES
  ('UTILITY_WRITTEN_APPROVAL', 'Su idaresinin yazılı onayı ve gerekli teknik erişim mevcut', false, 1),
  ('PAYMENT_CONTRACT_LEGAL',   'Ödeme hizmeti için uygun sözleşme ve hukuki model doğrulandı', false, 2),
  ('KEYS_SEPARATED',           'Test ve üretim anahtarları ayrıldı', true, 3),
  ('REAL_INTEGRATION_TESTS',   'Gerçek entegrasyon testleri başarıyla tamamlandı', false, 4),
  ('SUPER_ADMIN_MFA',          'Süper yönetici güvenli biçimde oluşturuldu ve MFA etkin', true, 5),
  ('SECURITY_TESTS',           'Güvenlik testleri (sızma testi dahil) yapıldı', false, 6),
  ('BACKUP_RESTORE_VERIFIED',  'Yedekleme ve geri yükleme doğrulandı', false, 7),
  ('REFUND_RECON_TESTED',      'Hata, iade ve mutabakat süreçleri test edildi', false, 8),
  ('USER_DOCS_DATA_PROTECTION','Kullanıcı belgeleri ve veri koruma süreçleri gözden geçirildi', false, 9),
  ('MONITORING_SUPPORT',       'İzleme ve destek prosedürü hazır', false, 10);

CREATE TABLE connection_tests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target           text NOT NULL CHECK (target IN ('PAYMENT_PROVIDER','WATER_UTILITY')),
  target_id        uuid NOT NULL,
  environment      text NOT NULL CHECK (environment IN ('TEST','LIVE')),
  ok               boolean NOT NULL,
  result_code      text NOT NULL,
  message          text,
  latency_ms       integer,
  performed_by     uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE backup_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('BACKUP','RESTORE_TEST')),
  status           text NOT NULL CHECK (status IN ('SUCCEEDED','FAILED')),
  storage_ref      text,
  details          text,
  recorded_by      text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Veri işleyen / hizmet sağlayıcı envanteri (KVKK hazırlığı)
CREATE TABLE data_processors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  role             text NOT NULL,            -- ör. Ödeme kuruluşu, e-posta sağlayıcısı, barındırma
  data_categories  text[] NOT NULL DEFAULT '{}',
  transfer_abroad  boolean,
  contract_ref     text,
  status           text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','UNDER_REVIEW','CONTRACTED','TERMINATED')),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
