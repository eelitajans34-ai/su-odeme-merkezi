# mevcut-site — DOKUNULMAYACAK

Canlı KolaySu.online sitesi bu depoda değildir; Lovable'a bağlı ayrı depoda yaşar:
`eelitajans34-ai/pixel-perfect-render-1376` (TanStack Start + Lovable Cloud/Supabase).

Bu klasör yalnızca bir işarettir. Buradaki yeni modüller (`services/`, `apps/android/`, `database/`)
canlı siteyi değiştirmez; siteye taşınmaları ayrı bir PR ve kullanıcı onayıyla yapılır.

Sitede zaten bulunan karşılıklar:

| Bu depo | Canlı sitedeki karşılığı |
|---|---|
| `services/water-topup/topup-orders.ts` | `payment_orders` + `order_*` SQL fonksiyonları (0008) |
| `services/water-topup/payments.ts` | `src/lib/payments/paytr.ts`, `engine.server.ts` |
| `services/water-topup/buski-adapter.ts` | `src/lib/utility/protocol.ts`, `docs/SU-IDARESI-API.md` |
| `services/water-topup/card-operations.ts` | `src/lib/card-credit/` + `nfc_card_credit_ops` (0019) |
| `services/water-topup/subscriptions.ts` | `meters` + `nfc_card_bindings` (0019) |
| `apps/android/` | `native/android-nfc/` (Java, test APK) |
