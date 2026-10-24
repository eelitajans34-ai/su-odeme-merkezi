# Mimari ve dosya yapısı

## Genel görünüm

```
 [Web (React/Vite)]   [Android/iOS (Expo)]
          │  çerez + CSRF        │  Bearer (Keychain/Keystore)
          └──────────┬───────────┘
                     ▼
            [API — Fastify (Node 22)]  ──► [PostgreSQL]
             │   │        ▲                    ▲
             │   │        │ webhook (HMAC)     │
             │   ▼        │                    │
             │ [Ödeme adaptörü]──► Ödeme kuruluşu (Kurulum bekleniyor)
             ▼
        [Su idaresi adaptörü]──► Su idaresi (Kurulum bekleniyor)
                     ▲
            [Worker] — yükleme/tahsilat, belirsiz durum sorgusu, oturum temizliği
```

- **API** tek doğruluk kaynağıdır. İstemciler durum, tutar, ücret veya rol göndermez; zod şemaları `.strict()` olduğundan fazladan alanlar reddedilir.
- **Worker** (`npm run worker -w apps/api`) ödeme onaylanan işlemleri su idaresine iletir, belirsiz (UNKNOWN) işlemlerin durumunu sorar, gerekirse REQUIRES_REVIEW'e alıp yöneticiyi uyarır.
- **Adaptörler**: `PaymentProviderAdapter` ve `WaterUtilityAdapter`. Kayıtlı olanlar: `NONE` (Kurulum bekleniyor) ve `SANDBOX` (yalnızca üretim dışı, bellek içi simülatör).
- **Gizli bilgiler**: `secret_values` tablosunda AES-256-GCM ile (AAD = referans) veya harici secret manager referansı olarak. API yalnızca meta döner (tanımlı mı, parmak izi, `••••son4`).

## İşlem durumları

Kart yükleme: `CREATED → AWAITING_PAYMENT → PAYMENT_PENDING → PAYMENT_CONFIRMED → TOPUP_PENDING → COMPLETED`
Yan dallar: `UNKNOWN` (belirsiz), `REFUND_PENDING → REFUNDED` (para alındı ama yükleme yapılamadı), `REQUIRES_REVIEW` (insan incelemesi), `FAILED` (yalnızca para alınmadıysa).

Fatura: `CREATED → BILL_QUERY_PENDING → BILL_FOUND → AWAITING_PAYMENT → … → PAYMENT_CONFIRMED → COLLECTION_PENDING → COMPLETED`
"Fatura ödendi" yalnızca `COMPLETED` (su idaresinin resmi teyidi) durumunda gösterilir.

Geçişler `apps/api/src/services/state-machine.ts` içinde tanımlıdır; her geçiş `transaction_status_history` tablosuna yazılır ve iyimser durum eşleşmesiyle (beklenen eski durum) yapılır.

## Yetkilendirme

Roller: `USER`, `SUPPORT`, `FINANCE`, `SUPER_ADMIN`. İzinler her istekte veritabanından okunur. Tüm yönetici izinleri MFA ister; hassas işlemler (anahtar girme, canlı moda geçiş, iade onayı, rol verme) son 15 dakikada MFA doğrulaması ister.

## Dosya yapısı

```
.
├── .env.example                 Örnek ortam değişkenleri (gerçek gizli bilgi yok)
├── docker-compose.yml           Yerel PostgreSQL
├── .github/workflows/ci.yml     Tip denetimi, testler, web derlemesi, bağımlılık denetimi
├── scripts/                     backup.sh, restore-test.sh
├── docs/                        Bu belgeler
└── apps/
    ├── api/
    │   ├── migrations/          0001 kimlik/yetki · 0002 abonelik/entegrasyon · 0003 ödeme/işlemler · 0004 operasyon/uyum/denetim
    │   ├── src/
    │   │   ├── app.ts, server.ts, config.ts, db.ts, migrator.ts, context.ts
    │   │   ├── auth/            service.ts (kayıt, giriş, MFA, oturum, davet), guards.ts
    │   │   ├── integrations/    payment/, utility/ (types, not-configured, sandbox), registry.ts
    │   │   ├── services/        topups, bills, payments, payment-events, fulfillment, refunds,
    │   │   │                    reconciliation, receipts, notifications, audit, secrets, fees, integrations, state-machine …
    │   │   ├── routes/          auth, user, webhooks, sandbox (üretim dışı), admin/ (payment-service, utility, users-ops)
    │   │   ├── cli/             migrate, bootstrap-super-admin, worker, seed-dev, record-backup
    │   │   └── lib/             crypto, totp, mask, redact, errors, validate
    │   └── test/                acceptance.test.ts (13.1–13.15), security.test.ts
    ├── web/src/                 pages/public, pages/user, pages/admin (AdminPages, PaymentService A–H, Utility)
    └── mobile/                  Expo: App.tsx, src/api.ts, src/ui.tsx, src/screens/*
```

## Teknoloji seçimleri

| Bileşen | Seçim | Gerekçe |
|---|---|---|
| API | Node 22 + Fastify 5 + TypeScript | Şema doğrulama, düşük ek yük, güvenlik eklentileri (helmet, rate-limit) |
| Veritabanı | PostgreSQL | İşlem bütünlüğü, kısıtlar, tetikleyiciyle eklemeli denetim kaydı, danışma kilitleri |
| Para | `bigint` kuruş | Kayan nokta hatası yok |
| Web | React 19 + Vite | |
| Mobil | Expo (React Native) | Tek kod tabanıyla Android ve iOS |
| Test | Vitest + gerçek PostgreSQL | Durum makinesi ve kilitler gerçek veritabanında denenir |
