# KVKK ve hukuki uyum hazırlığı

> **Önemli:** Bu belge ve yazılımdaki ilgili özellikler yalnızca **teknik hazırlıktır**. Sistemin 6698 sayılı KVKK, 6493 sayılı Ödeme Hizmetleri Kanunu, 5549 sayılı Kanun ve ilgili mevzuata uygun olduğu **iddia edilmez**. Yayından önce hukuk ve uyum uzmanı incelemesi zorunludur.

## 1. İşlenen kişisel veriler (envanter taslağı)

| Veri | Amaç | Saklama (öneri — hukukça belirlenmeli) |
|---|---|---|
| Ad soyad, e-posta, telefon | Hesap, bildirim | Hesap süresince + yasal süre |
| Abone no, kart seri no (maskeli gösterim) | Hizmet | Hesap süresince + yasal süre |
| İşlem kayıtları, makbuzlar | Hizmet, mali yükümlülük | Mevzuattaki saklama süresi (ör. 10 yıl olabilir) |
| IP, tarayıcı bilgisi, giriş kayıtları | Güvenlik | Öneri: 1–2 yıl |
| Denetim kayıtları | Hesap verebilirlik | Mevzuata göre |
| Rıza ve aydınlatma kayıtları | İspat | İlişki süresince + zamanaşımı |

Kart numarası, CVV vb. ödeme kartı verisi platformda **işlenmez**; ödeme kuruluşunun sayfasında alınır.

## 2. Sistemdeki teknik destekler
- Aydınlatma metni ve kullanım koşulları sürümlü tutulur (`legal_documents`); kullanıcı onayları sürüm, zaman ve IP ile kaydedilir (`consent_records`).
- Veri işleyen (alt yüklenici) envanteri: Yönetim → Hukuki uyum → Veri işleyenler (`data_processors`): barındırma, ödeme kuruluşu, e-posta, SMS sağlayıcısı vb.
- Maskeleme: arayüzde abone/kart numaraları ve e-postalar maskelenir.
- Test verisi etiketlidir; gerçek kullanıcı verisinin test ortamına kopyalanması yasaktır (bkz. KURULUM.md §9).

## 3. Yapılması gerekenler
- [ ] Veri sorumlusu bilgileri, VERBİS kaydı gerekip gerekmediği
- [ ] Aydınlatma metni, açık rıza gereken işlemler, çerez politikası (sistemdeki metinler yer tutucudur)
- [ ] Saklama ve imha politikası; süreler hukukça belirlenmeli, otomatik imha işi yazılmalı
- [ ] Yurt dışına aktarım değerlendirmesi (barındırma, e-posta sağlayıcısı)
- [ ] İlgili kişi başvuru süreci (erişim, düzeltme, silme talepleri) — destek talebi üzerinden manuel süreç tanımlanmalı
- [ ] Veri işleyenlerle sözleşmeler
- [ ] Ödeme hizmeti hukuki modeli (lisanslı kuruluş aracılığı, tahsilat yetkisi)

## 4. Veri ihlali müdahale süreci (taslak)
1. Tespit ve kayıt (zaman, kaynak, etkilenen sistem).
2. Sınırlama: ilgili anahtarları döndür, oturumları sonlandır, gerekirse bakım modu.
3. Etki analizi: hangi veriler, kaç kişi.
4. Bildirim: Kurul'a mevzuattaki süre içinde (KVKK uygulamasında 72 saat esas alınmaktadır — hukukça teyit edilmeli) ve ilgili kişilere.
5. Kök neden analizi ve düzeltici faaliyet; denetim kaydına ekleme.

## 5. Erişim gözden geçirme
- Üç ayda bir: Yönetim → Kullanıcılar ve roller listesinden personel rolleri gözden geçirilir; ayrılanların rolleri alınır. Rol değişiklikleri denetim kaydından izlenir.
- Süper yönetici sayısı en az tutulmalıdır.
