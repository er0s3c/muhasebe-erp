# Hukuki notlar

> Bu belge hukuki görüş değildir. Ticari lansmandan önce bir avukata ve mali müşavire danışın.

## 1. Fikri mülkiyet: yerel yazılımlardan esinlenme

Bu proje KKTC'de kullanılan mevcut muhasebe yazılımlarının sunduğu **işlev kategorilerini** bir kontrol listesi olarak dikkate alır. Kullanıcılar cari, stok, fatura, tahsilat, mizan gibi genel muhasebe işlevlerini bekler; bu işlevler ve terimler serbesttir.

Aşağıdakiler **kopyalanmaz**:

- Herhangi bir üçüncü tarafın adı, logosu, ikonları, renkleri ve marka öğeleri
- Ekran görüntüleri (depoya konmaz; `.gitignore` içinde `reference-materials/` dışlanmıştır)
- Ekran yerleşimleri ve ağaç menü düzeni; rapor başlıklarının birebir listesi
- Dosya/veritabanı biçimleri: tersine mühendislik yapılmaz. Veri aktarımı yalnızca müşterinin kendi dışa aktardığı Excel/CSV dosyalarıyla yapılır.

Görsel dil (renk paleti, tipografi ölçeği, yüzey ve bileşen kuralları) kullanıcının verdiği genel bir stil referansından uyarlanmıştır; yalnızca tasarım ilkeleri (renk, aralık, yarıçap, tek vurgu, tek ağırlık) uygulanır. Referansın adı, logosu, özel yazı tipi (lisanslıdır; yerine açık lisanslı Inter kullanılır), görselleri ve metinleri **kullanılmaz**. Marka işareti ve ürün adı kendi tasarımımızdır (bkz. [DESIGN.md](DESIGN.md)).

Bu projenin bilgi mimarisi ve arayüzü özgündür: görev odaklı menü, genel bakış ekranı, komut paleti, yan panelli formlar, özgün marka işareti.

**Yapılacaklar:** ürün adını seçmeden önce marka/alan adı taraması yapın ve mevcut yazılım adlarına benzerlikten kaçının.

## 2. Üçüncü taraf yazılım lisansları

Yalnızca izinli lisanslar kullanılır (MIT, ISC, BSD, Apache-2.0, 0BSD, BlueOak, CC0, OFL-1.1 yazı tipi). `npm run licenses` CI'da çalışır ve **kurulu tüm ağacı** (geliştirme araçları dahil, yaklaşık 470 paket) tarar; izin listesi dışında bir lisans (GPL/AGPL, lisanssız vb.) görürse hata verir. Inter yazı tipi (`@fontsource-variable/inter`) SIL OFL 1.1 ile lisanslıdır; kendi sunucumuzdan sunulur (harici CDN çağrısı yok).

İzin listesine bilinçli olarak eklenen iki istisna (ikisi de yalnızca derleme/geliştirme aracıdır, ürün paketine girmez):

- **MPL-2.0:** `lightningcss` (Tailwind/Vite'ın CSS derleyicisi). Dosya düzeyinde zayıf copyleft; değiştirilmemiş ikili olarak derleme sırasında kullanıldığı için kendi kodumuza yükümlülük getirmez. Bu paket değiştirilirse veya dağıtılan ürüne dahil edilirse yeniden değerlendirin.
- **CC-BY-3.0:** `spdx-exceptions`, `spdx-ranges` (`license-checker`'ın kendi bağımlılıkları; yalnızca geliştirme).

> Not: Denetimin ilk sürümü kök `package.json`'da üretim bağımlılığı bulunmadığı için hiçbir paketi taramıyordu (her zaman başarılı görünüyordu). Negatif kontrolle fark edilip düzeltildi; izin listesini değiştirirken de "yalnızca ISC izinli" gibi bir negatif kontrolün hata verdiğini doğrulayın.

## 3. Doğrulanmamış içerik: kapsam belgesi

Kapsam belgesi yapay zekâ (Gemini) çıktısıdır. Aşağıdaki maddeleri bağımsız olarak doğrulayamadık; bu yüzden **kodda sabit yazılmadılar** ve şimdilik uygulamada kullanılmıyorlar (KDV hariç, o da "doğrulanmamış" işaretiyle gelir).

| Konu | Belgedeki iddia | Durum |
|---|---|---|
| e-Fatura | `test-efatura.maliye.gov.ct.tr` REST API v1.2.3, Bearer token, UUIDv7 | Doğrulanmadı. Resmi dokümantasyon ve test erişimi alınmadan entegrasyon yazılmayacak |
| Yabancılara satış kotaları | 39/2024 ve 42/2025: %50 uyruk sınırı, %20 yerel rezerv, kişi başı 6/3/3/2 birim sınırı | Doğrulanmadı |
| Pul harcı ve süreler | 21 gün / 6 ay eşikleri, binde 5 / %1 / %1,5; 75 iş günü harç süresi | Doğrulanmadı |
| Alan çevrimi | 1 dönüm = 1.338 m² | Doğrulanmadı |
| KDV oranları | %5 / %10 / %16 (+ %300 m² üzeri konut kuralı) | Doğrulanmadı. Şirket kurulunca **doğrulanmamış** olarak tohumlanır |
| KIB-TEK trafo katkı payı | daire başı £1.200–£2.500 | Doğrulanmadı |
| Yabancı işçi teminatı | kişi başı 250 € | Doğrulanmadı |
| Sosyal güvenlik teşviği | D1/D3 bordro tipleri, %100/%80 prim teşviki | Doğrulanmadı |
| Kur kaynağı | KKTC Merkez Bankası gösterge kurları her iş günü 15:30 | **Kısmen doğrulandı:** kurumun "Döviz kurlarına erişim" sayfası (kullanıcının yapıştırdığı metin) XML adreslerini doğruluyor: güncel `https://www.mb.gov.ct.tr/kur/gunluk.xml`, tarihli `https://www.mb.gov.ct.tr/kur/tarih/YYYYMMDD` (XML: 09/04/2011'den itibaren). Örnek dosyada yalnızca tarih ve duyuru no var, **yayın saati yok** (15:30 iddiası doğrulanmadı). Yeniden dağıtım/kullanım şartı okunmadı |
| Stok değerleme yöntemi | Hareketli ağırlıklı ortalama maliyet varsayılan yöntem olarak uygulanır | KKTC vergi mevzuatında kabul edilen stok değerleme yöntemleri ve dönem sonu envanter kuralları **doğrulanmadı**; mali müşavirle teyit edin |
| Fatura biçimi ve numaralama | KKTC'de yasal faturanın zorunlu içeriği, basım/onay ve sıra numarası kuralları | **Doğrulanmadı.** Uygulama boşluksuz iç numara ve yazdırılabilir bir **iç belge** üretir; bu çıktı yasal fatura yerine geçmez. Mali müşavirle ve Maliye mevzuatıyla teyit edilmeden yasal fatura olarak kullanılmamalı |
| İrsaliye biçimi ve muhasebe zamanı | KKTC'de sevk irsaliyesinin zorunlu içeriği (plaka, şoför, düzenleme saati vb.), zorunluluk eşikleri ve irsaliyenin hangi anda muhasebeye girdiği | **Doğrulanmadı.** Uygulama irsaliye için boşluksuz iç numara ve iç belge çıktısı üretir; yasal irsaliye yerine geçmez. İrsaliye yevmiye yazmaz (stok defterini etkiler, muhasebe fatura kesilince oluşur); bu tercih mali müşavirle teyit edilmelidir |
| Hesap eşlemesi varsayılanları | 120/320 cari, 600/610 gelir, 621 maliyet, 150/153 stok, 391/191 KDV, 632 gider, 649/659 stok fazlası/zararı, 710 sarf, 500 devir karşı hesabı | Genel Tekdüzen yapıya dayanır, **doğrulanmadı.** Ayarlar > Hesap eşlemesi'nden şirkete göre değiştirilir; ekran her açılışta uyarı gösterir |
| KDV hesabı | Satır başına yuvarlama; KDV dahil fiyatta net = brüt ÷ (1 + oran) | Yuvarlama ve beyan kuralları KKTC mevzuatına göre **doğrulanmadı**; KDV özeti beyanname yerine geçmez |
| Kambiyo (kur farkı) hesapları | Gerçekleşen kur farkı kârı 646, zararı 656 hesabına yazılır | Genel Tekdüzen yapıya dayanır, **doğrulanmadı.** Hesap eşlemesinden (`fx_gain`/`fx_loss`) değiştirilir; mali müşavirle teyit edin |
| Kasa eksi bakiye | Kasa (100) hesabı eksiye düşemez, banka hesabı düşebilir (kredili mevduat) | Uygulama kuralıdır, KKTC mevzuatındaki denetim/ceza yaklaşımı **doğrulanmadı.** Denetim yalnızca uygulamadadır (veritabanı kuralı değil) |
| Kur değerlemesi ve kur seçimi | Tahsilat/ödemede kayıtlı **alış** kuru, döviz satışında hesabın ortalama maliyeti kullanılır; dönem sonu değerleme (gerçekleşmemiş kur farkı) henüz yapılmaz | Hangi kurun (alış/satış/gösterge) ve hangi değerleme yönteminin (ortalama, FIFO, dönem sonu kuru) KKTC'de kabul edildiği **doğrulanmadı**; değerleme M7b'de yasal kural netleşince eklenecek |
| Kurumlar | MŞ32 raporu, İnşaat Encümeni sınıf karneleri ve m² kapasiteleri | Doğrulanmadı |

### Tasarım ilkesi

Yasal parametreler kod sabiti değil **veridir**: tarih aralıklı, kaynak notu ve "doğrulayan kişi/zaman" alanlı. Şu an bu desen `tax_rates` tablosunda uygulanır (`valid_from/valid_to`, `source_note`, `verified_by`, `verified_at`); arayüz doğrulanmamış oranları rozet ve uyarıyla gösterir, dashboard kontrol listesi doğrulamayı hatırlatır. Sonraki yasal modüller (kota motoru, harç hesapları, bordro) aynı desenle eklenecek ve ilgili resmî kaynak doğrulanmadan etkinleştirilmeyecek.

## 4. Hesap planı şablonu

Yeni şirkete yüklenen hesap planı genel Tekdüzen Hesap Planı yapısına dayanır (sınıf > grup > hesap) ve KKTC'de resmi olarak doğrulanmamıştır. Şirket kurulumundan sonra düzenlenebilir. Mali müşavirle gözden geçirilmelidir.

## 5. Kişisel veriler

Sistem kişi adı, e-posta, ileride kimlik/pasaport ve bordro verisi işleyecektir. Üretime almadan önce KKTC'nin kişisel verilerin korunmasına ilişkin mevzuatı için hukuki değerlendirme yapılmalı; yedekleme, saklama süresi ve veri dışa aktarma politikaları yazılı hâle getirilmelidir.

## 6. Merkez Bankası kur verisi

`apps/api/src/modules/settings/kktcmb.ts`, kurumun XML biçimini **gerçek bir örnek dosyaya** (29/09/2026, duyuru 2026/182; `apps/api/test/fixtures/kktcmb-gunluk.xml`) göre ayrıştırır.

- Alış = `Doviz_Alis`, Satış = `Doviz_Satis`. Efektif kurlar okunur ama saklanmaz. Kur, `Birim` alanına bölünerek tek birime çevrilir (örn. JPY için Birim = 100).
- Yalnızca sistemin desteklediği GBP, EUR, USD alınır; diğerleri atlanır.
- Sunucu yalnızca sabit resmî adrese bağlanır (kullanıcı girdisinden adres kurulmaz), **TLS sertifika doğrulaması asla kapatılmaz**. Kurumun sitesi bazı güvenlik yazılımlarında (örn. Kaspersky) uyarı verebilir; sunucu sertifika zincirini doğrulayamazsa içe aktarma hata verir ve kullanıcı XML'i dosya olarak yükleyebilir. Zincir eksikse çözüm, eksik CA'yı `NODE_EXTRA_CA_CERTS` ile vermektir, doğrulamayı kapatmak değil.
- XML'de `DOCTYPE`/`ENTITY` bulunması, 500 KB üstü boyut, geçersiz tarih/sayı/birim reddedilir (XXE ve varlık şişirme savunması).
- **Yapılacak:** ticari kullanımdan önce kurumun veri kullanım/yeniden yayın koşullarını yazılı olarak kontrol edin; otomatik zamanlanmış çekim yalnızca bu doğrulamadan ve yayın saati netleştikten sonra eklenmeli.

