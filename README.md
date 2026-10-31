# Su Ödeme Merkezi

Su kartı bakiye yükleme ve su faturası sorgulama/ödeme platformu: web, Android/iOS (Expo) istemcileri, API, yönetim panelleri (Süper yönetici, Güvenli Ödeme Hizmeti, Su İdaresi Entegrasyonu), mutabakat, bildirim, denetim kaydı ve KVKK hazırlığı.

> **Durum: Test modu / Kurulum bekleniyor.** Bu depoda gerçek bir su idaresi veya ödeme kuruluşu bağlantısı **yoktur**. Gerçek entegrasyonlar, kurumların resmî teknik dokümanı, sözleşme ve yazılı izin geldikten sonra eklenecektir. Geliştirme simülatörleri yalnızca üretim dışı ortamlarda çalışır ve gerçek para hareketi oluşturmaz. Canlı mod, yayın öncesi kontrol listesi tamamlanmadan sistem tarafından engellenir.

## Şu an depoda olanlar (KolaySu NFC + su yükleme çekirdeği)

```
mevcut-site/            Canlı kolaysu.online deposuna işaret (dokunulmaz)
apps/android/           NfcCardReader.kt, CardCompatibility.kt, NfcWriteService.kt, MainActivity.kt
services/water-topup/   subscriptions, pricing, payments, topup-orders, card-operations, buski-adapter
database/migrations/    0001_water_topup.sql (yalnızca yeni "water_topup" şeması)
tests/                  nfc-simulator, payment-sandbox, topup-workflow
docs/                   buski-integration.md, security-plan.md
```

```bash
npm install
npm run typecheck
npm test
```

Gerçek ödeme, gerçek BUSKİ yüklemesi ve gerçek karta yazma kapalıdır; açılması için bkz. [docs/security-plan.md](docs/security-plan.md) ve [docs/buski-integration.md](docs/buski-integration.md).
Aşağıdaki bölümler planlanan tam platformu anlatır; o dosyalar henüz bu depoda değildir.

## Hızlı başlangıç

```bash
npm ci
docker compose up -d db
cp .env.example .env      # değerleri doldurun (bkz. docs/KURULUM.md)
npm run migrate
npm run seed:dev -w apps/api
npm run dev:api           # ayrı terminalde: npm run dev:web
```

Süper yönetici: `.env` içinde `SUPER_ADMIN_EMAIL` tanımlayıp `npm run bootstrap-super-admin` çalıştırın. Varsayılan parola yoktur; davet bağlantısı + zorunlu TOTP ile kurulur.

## Belgeler

| Belge | İçerik |
|---|---|
| [docs/ANALIZ_RAPORU.md](docs/ANALIZ_RAPORU.md) | Kapsam, eksik bilgiler, riskler |
| [docs/MIMARI.md](docs/MIMARI.md) | Mimari, durum makineleri, dosya yapısı |
| [docs/KURULUM.md](docs/KURULUM.md) | Kurulum, süper yönetici, sağlayıcı yapılandırması, dağıtım, yedekleme, geri alma, sorun giderme |
| [docs/GUVENLIK.md](docs/GUVENLIK.md) | Güvenlik tasarımı ve bilinen sınırlamalar |
| [docs/YAYIN_ONCESI_KONTROL.md](docs/YAYIN_ONCESI_KONTROL.md) | Canlıya geçiş kontrol listesi |
| [docs/KVKK_HAZIRLIK.md](docs/KVKK_HAZIRLIK.md) | KVKK teknik hazırlığı (uyum iddiası değildir) |
| [docs/ENTEGRASYON_REHBERI.md](docs/ENTEGRASYON_REHBERI.md) | Gerçek ödeme/su idaresi adaptörü ekleme |
| [docs/TEST_RAPORU.md](docs/TEST_RAPORU.md) | Test sonuçları ve denenmemiş kısımlar |

## Yapı

```
apps/api      Fastify + PostgreSQL API, işçi, CLI komutları, testler
apps/web      React web uygulaması (kullanıcı + yönetim)
apps/mobile   Expo (React Native) mobil uygulama iskeleti
docs/         Belgeler
scripts/      Yedekleme ve geri yükleme testi
```

## Komutlar

| Komut | Açıklama |
|---|---|
| `npm test` | API kabul ve güvenlik testleri (PostgreSQL gerekir) |
| `npm run typecheck` | API ve web tip denetimi |
| `npm run build` | API ve web derlemesi |
| `npm run audit:deps` | Üretim bağımlılık güvenlik denetimi |
| `npm run worker -w apps/api` | Yükleme/tahsilat işçisi |
| `npm run configure-email -w apps/api` | SMTP kanalını sunucudan yapılandırma |
