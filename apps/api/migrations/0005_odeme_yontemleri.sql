-- Ödeme yöntemleri: kart (sağlayıcının güvenli ödeme sayfası), QR ve temassız (NFC).
-- Bir yöntem kullanıcıya ancak (1) etkin sağlayıcının adaptörü destekliyorsa ve (2) yönetici o ortam için açtıysa sunulur.
-- Mevcut kayıtlar kart yöntemiyle devam eder.
ALTER TABLE payment_provider_configs
  ADD COLUMN enabled_payment_methods text[] NOT NULL DEFAULT ARRAY['HOSTED_CARD']::text[]
    CHECK (enabled_payment_methods <@ ARRAY['HOSTED_CARD','QR','NFC']::text[]);

ALTER TABLE payment_transactions
  ADD COLUMN payment_method text NOT NULL DEFAULT 'HOSTED_CARD' CHECK (payment_method IN ('HOSTED_CARD','QR','NFC')),
  ADD COLUMN qr_payload text,
  ADD COLUMN qr_expires_at timestamptz;
