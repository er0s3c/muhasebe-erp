# Hukuki notlar

> Bu belge hukuki görüş değildir. Ticari lansmandan önce bir avukata ve mali müşavire danışın.
> Son mevzuat incelemesi: **1 Ekim 2026** (§3). Mevzuat sık değişir; bu tarihten sonraki Resmî Gazete sayıları yeniden kontrol edilmelidir.

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

**xlsx yazma/okuma:** `exceljs` kurulumda `npm audit --omit=dev` (uuid) ve lisans denetimini (`buffers@0.1.1`, lisansı belirsiz) geçemediği için kullanılmadı. Bunun yerine MIT lisanslı `fflate` (zip) ve `fast-xml-parser` üstüne kendi küçük yazıcı/okuyucumuz yazıldı (`apps/api/src/files/`); izin listesi genişletilmedi.

**Dağıtımda bildirim yükümlülüğü:** MIT, BSD, ISC ve Apache-2.0 lisansları, yazılımı (imaj olarak) dağıtırken telif bildiriminin ve lisans metninin birlikte verilmesini şart koşar. `npm run licenses:notices` üretim bağımlılık kümesinden (yaklaşık 190 paket; geliştirme araçları hariç) `THIRD-PARTY-NOTICES.md` üretir; dosya Docker imajı derlenirken oluşturulur, imajda `/app/THIRD-PARTY-NOTICES.md` olarak bulunur ve arayüz kökünden `/THIRD-PARTY-NOTICES.md` adresiyle sunulur. **Sekiz paket lisans dosyasını yayımlamaz** (`@nodable/entities`, `@node-rs/argon2-linux-x64-gnu`/`-musl`, `abstract-logging`, `drizzle-orm`, `pg-types`, `pgpass`, `react-remove-scroll-bar`); bu paketler için bildirimde lisans türü ve kaynak adresi yazılıdır, lisans metni yoktur. Apache-2.0 (örn. `drizzle-orm`) lisans metninin bir kopyasının verilmesini ayrıca ister: **ticari dağıtımdan önce** bu eksik metinleri kaynak depolardan tamamlamak ve bildirimi bir avukata göstermek gerekir.

İzin listesine bilinçli olarak eklenen iki istisna (ikisi de yalnızca derleme/geliştirme aracıdır, ürün paketine girmez):

- **MPL-2.0:** `lightningcss` (Tailwind/Vite'ın CSS derleyicisi). Dosya düzeyinde zayıf copyleft; değiştirilmemiş ikili olarak derleme sırasında kullanıldığı için kendi kodumuza yükümlülük getirmez. Bu paket değiştirilirse veya dağıtılan ürüne dahil edilirse yeniden değerlendirin.
- **CC-BY-3.0:** `spdx-exceptions`, `spdx-ranges` (`license-checker`'ın kendi bağımlılıkları; yalnızca geliştirme).

> Not: Denetimin ilk sürümü kök `package.json`'da üretim bağımlılığı bulunmadığı için hiçbir paketi taramıyordu (her zaman başarılı görünüyordu). Negatif kontrolle fark edilip düzeltildi; izin listesini değiştirirken de "yalnızca ISC izinli" gibi bir negatif kontrolün hata verdiğini doğrulayın.

## 3. Yasal parametreler: doğrulama durumu

Kapsam belgesi yapay zekâ (Gemini) çıktısıdır. Maddeleri **1 Ekim 2026** itibarıyla resmî kurum kaynaklarına karşı yeniden inceledik (bkz. aşağıdaki “İnceleme kaydı”). İnceleme hukuki görüş değildir. Bir maddenin “kaynak bulundu” olarak işaretlenmesi onu **uygulamada etkinleştirmeye yetmez**. Mevzuat motoru üretime alınmadan önce KKTC'de çalışan bir avukat ve bir mali müşavir son kontrolü yapmalıdır.

### Durum etiketleri

| Etiket | Anlamı | Uygulamada |
|---|---|---|
| 🟢 **Kaynak bulundu** | Resmî kaynak gösterildi: Resmî Gazete, bakanlık/daire duyurusu ya da resmî teknik doküman. Uzman teyidi bekleniyor | Tarihli ve kaynaklı parametre olarak girilebilir. Uzman onayına kadar “doğrulanmamış” rozeti taşır |
| 🟡 **Varsayılan** | Sistem varsayılanı ya da yaygın muhasebe pratiğidir; yasal zorunluluk iddiası yoktur | Ekranda “önerilen” olarak gösterilir, mali müşavir değiştirebilir |
| 🟠 **Güncellendi** | Eski iddia eksik ya da artık yürürlükte değil; yeni kaynağa göre yeniden modellenmeli | Eski değer kodda ve veride kullanılmaz |
| 🔴 **Doğrulanmadı** | Güvenilir resmî kaynak bulunamadı | Kodda sabit yoktur, parametre olarak da girilmez |

### Madde madde durum

| Konu | Eski iddia (kapsam belgesi) | Durum (1 Ekim 2026) |
|---|---|---|
| e-Fatura | `test-efatura.maliye.gov.ct.tr` REST API v1.2.3, Bearer token, UUIDv7 | 🟢 **Kaynak bulundu.** Maliye Bakanlığı'nın e-Fatura sistemi 2021'den beri çalışıyor. Portal ve Web Servis/Doğrudan Entegrasyon yolları var; UBL tabanlı teknik dokümanlar `efatura.vergi.gov.ct.tr` adresinde. 2026 incelemesi resmî REST API dokümanını **v1.2.3** olarak bildirdi: üretim `https://efatura.maliye.gov.ct.tr/api`, test `https://test-efatura.maliye.gov.ct.tr/api`; Bearer token (Keycloak), UBL-Invoice 2.1 / UBL-CreditNote 2.1 ve KKTC Schematron kontrolleri, zorunlu UUIDv7, VKN; fatura, iptal ve alacak dekontu işlemleri. **API dokümanını bu ortamdan açamadık** (ağ politikası). Sürüm ve uç adresleri entegrasyon başlarken dokümandan yeniden okunmalı. Üretime almak için mükellef yetkilendirmesi, API erişim bilgileri ve başvuru/onay süreci ayrıca gerekir. Entegrasyon gerçek iş olarak Faz C'de planlanır; iç fatura ile ayrı modellenir (§7) |
| KDV oranları | %5 / %10 / %16 (+ 300 m² üzeri konut kuralı) | 🟠 **Güncellendi.** 2025 KDV Oranları Tüzüğü cetvellerine göre oran kümesi **%0 / %5 / %10 / %16 / %20**. Tüzük 2026'da defalarca değişti; incelemede 16, 23 ve 30 Eylül 2026 değişiklikleri bildirildi. Oran ürüne değil, **vergi kategorisine** (cetvel sırasına) bağlanmalıdır. “300 m² üzeri konut” gibi kurallar ayrı bir oran değil, kategori koşuludur. Uygulama yeni şirkete beş oranı **doğrulanmamış** olarak tohumlar (KDV-20 eklendi). Mevcut şirketler %20'yi Ayarlar > KDV oranları'ndan ekler. Kategori modeli henüz yok (aşağıda “Hedef model”) |
| Yabancılara taşınmaz edinimi | 39/2024 ve 42/2025: %50 uyruk sınırı, %20 yerel rezerv, kişi başı 6/3/3/2 birim sınırı | 🟠 **Güncellendi; eski kota modeli kullanılmaz.** 7 Mayıs 2026 tarihli 63/2026 sayılı Yasa Gücünde Kararname'nin yerine, haberlere göre **89/2026 sayılı YGK** geldi (Resmî Gazete 7 Ağustos 2026, yayımı tarihinde yürürlükte). Haberlere yansıyan hükümler (yabancı gerçek ve tüzel kişiler, Bakanlar Kurulu izniyle): yapı iznine uygun en fazla **1.338 m²** arazi ve üzerinde **1 konut**; ya da **3 apartman dairesi**; toplu konut ve site projelerinde en fazla 2 adet iki katlı villa. KKTC'yi tanıyan ve KKTC yurttaşlarına aynı hakkı tanıyan ülkelerin vatandaşlarına **6 daire / 3 villa**. Belirli sektörlerdeki yatırımlarda en az 10 milyon € koşulu. Haberlerde konut projelerine yabancılara satış oranı sınırı (%80) da geçiyor. **Kaynak haber düzeyindedir, Resmî Gazete metni okunmadı.** YGK'nin yasalaşması ya da değişmesi takip edilmelidir. 2026 incelemesinin esas aldığı 63/2026 **artık yürürlükte değildir** |
| Arazi sınırı ve dönüm | 1 dönüm = 1.338 m² | 🟢 **Yasal sınır olarak kaynak bulundu** (89/2026, önceden 63/2026). Kodda genel bir “dönüm → m²” çevrim sabiti olarak **kullanılmaz**. Yabancının edinebileceği azami arazi ayrı ve tarihli bir yasal parametredir (ör. `foreign_property.max_land_m2 = 1338`, kaynak: 89/2026). Birim çevrimi ile yasal sınır farklı kavramlardır |
| Pul vergisi, tapu harcı ve süreler | 21 gün / 6 ay eşikleri; binde 5 / %1 / %1,5; 75 iş günü harç süresi | 🟠 **Ayrıştırıldı.** Eski satır dört farklı kural ailesini karıştırıyordu. (a) **Pul vergisi** oranları ve sözleşme damgalama süreleri: incelemede 2026'da Pul Vergileri değişiklik emirnameleri yayımlandığı bildirildi; oran ve süreler 🔴 doğrulanmadı. (b) **Tapu devir harçları**: 🔴 doğrulanmadı. (c) **Yabancı alım izni süreleri** (haberlere göre 89/2026): tapu devir harçları, Bakanlar Kurulu izin kararının yayımından itibaren **75 iş günü** içinde ödenir, ödenmezse izin geçersiz olur. İzin sonrası devir için 1 yıl tanınır. YGK'den önce alınıp tamamlanmış ve teslim edilmiş konutlara 36 ay, eski sözleşmelere 6 ay süre verilir. (d) **Sözleşme kayıt süreleri**: 🔴 doğrulanmadı. 75 iş günü bir pul ödeme süresi **değildir**. Dört aile ayrı parametre tablolarıyla modellenecek: `stamp_duty_rules`, `land_transfer_fee_rules`, `contract_registration_deadlines`, `property_purchase_permit_deadlines`. Tek bir “harç motoru”nda toplanmayacak |
| KIB-TEK trafo katkı payı | daire başı £1.200–£2.500 | 🔴 **Doğrulanmadı.** Genel bir daire başı kural için resmî kaynak bulunamadı. Kodda değer yok, parametre olarak da girilmez |
| Yabancı işçi teminatı | kişi başı 250 € | 🟢 **Kaynak bulundu.** Çalışma ve Sosyal Güvenlik Bakanlığı duyurusu: 24 Şubat 2025'ten itibaren her üçüncü ülke vatandaşının çalışma izni başvurusunda işverenden **250 €** teminat istenir. Buna, işçinin ülkesine dönüş masraflarını kapsayan bir taahhütname eşlik eder. Dayanak 63/2006 sayılı Yabancıların Çalışma İzinleri Yasası altındaki tüzüktür. Sabit olarak değil, tarihli parametre olarak tutulur (`amount = 250`, `currency = EUR`, `valid_from = 2025-02-24`) |
| Sosyal güvenlik | D1/D3 bordro tipleri, %100/%80 prim teşviki | 🟠 **Güncellendi.** **D3** için kaynak bulundu. Sosyal Sigortalar Dairesi duyurusuna göre Şubat 2026 primlerinden itibaren D3 (H2 ve E2 ile birlikte), çalışma izinli üçüncü ülke vatandaşı sigortalılar içindir. İşsizlik dışındaki tüm kollar uygulanır. Oranlar: sigortalı **%13**, işveren **%9,75** + iş kazası/meslek hastalığı, devlet **%1,25**; toplam %22,75 + iş kazası/meslek hastalığı. “%100/%80 teşvik” **genel kural değildir**: prim destekleri dönemsel kararlara bağlıdır (ör. 2025'te çalışma izinli sigortalılar için işveren hissesinin %80'i desteği). Model: bordro tipi + tarihli temel oranlar + ayrı ve tarihli destek kuralı. D1'in ayrıntısı doğrulanmadı |
| Çalışma süresi, fazla mesai, izin hakları, resmî tatiller (puantaj, D2) | Günlük/haftalık normal çalışma süresi ve fazla mesai sınırı ve ücreti, yıllık/hastalık izin hakkı ve süreleri, ücretsiz izin, resmî tatil ve hafta tatili günleri, tatilde çalışma ücreti | 🔴 **Doğrulanmadı.** KKTC çalışma mevzuatındaki değerler (sınırlar, çarpanlar, izin gün sayıları, resmî tatil takvimi) resmî kaynaktan okunmadı. Uygulama **hiçbirini kodda tutmaz**: puantaj yalnızca günü sınıflandırır (çalıştı, devamsız, yıllık/hastalık/ücretsiz izin, resmî tatil, hafta tatili) ve saatleri kaydeder; izin bakiyesi, fazla mesai sınırı/çarpanı ve tatil takvimi yoktur, hangi günün resmî tatil ya da hafta tatili olduğunu kullanıcı girer. Tek sayısal sınır, bir günün 24 saat olmasıdır (veri girişi hatası denetimi, yasal sınır değil). Fazla mesai ücreti ve izin hakları bordro (D3) aşamasında tarihli, doğrulama alanlı parametrelerle ele alınacak ve kaynak doğrulanmadan etkinleştirilmeyecek |
| Bordro parametreleri (D3): prim oranları, gelir vergisi, asgari ücret, fazla mesai çarpanı, gün/saat böleni, izin ödeme yüzdeleri | İşçi/işveren primi, vergi, asgari ücret, çarpanlar | 🔴 **Doğrulanmadı.** Hiçbiri kodda ya da varsayılan veride yoktur; yalnızca kullanıcının girdiği, tarihli, kaynak notlu ve **varsayılan kapalı** `payroll_params` satırlarıdır. Doğrulanmamış parametreyle hesaplanan bordro/pusula ⚠ taşır; bordro resmî belge değil iç belgedir (bkz. §13) |
| Kur kaynağı | KKTC Merkez Bankası gösterge kurları her iş günü 15:30 | 🟢 **XML adresleri ve biçim doğrulandı:** güncel `https://www.mb.gov.ct.tr/kur/gunluk.xml`, tarihli `https://www.mb.gov.ct.tr/kur/tarih/YYYYMMDD` (XML 09/04/2011'den itibaren). Döviz alış/satış ve efektif alış/satış yayımlanır; birimler farklı olabilir (ör. 100 JPY), bu yüzden kur birime bölünür. 🔴 **“15:30” kullanılmaz.** KKTC Merkez Bankası için bu saati gösteren kaynak yok; büyük olasılıkla TCMB'nin gösterge kur saatiyle karıştırıldı. Uygulama yayın saati varsaymaz ve saklamaz. Örnek XML'de saat alanı yok; ileride eklenirse okunur, yoksa yayın zamanı boş kalır (`published_at = null`). Yeniden dağıtım ve kullanım şartı okunmadı (§6) |
| Stok değerleme yöntemi | Hareketli ağırlıklı ortalama maliyet | 🟡 **Varsayılan.** Uygulamanın varsayılan yöntemidir (`DEFAULT_STOCK_VALUATION_METHOD`), yasal zorunluluk değildir. Bu ikisi ayrı kavramlardır. KKTC vergi mevzuatında kabul edilen yöntemler ve dönem sonu envanter kuralları doğrulanmadı; mali müşavirle teyit edin |
| Fatura biçimi ve numaralama | KKTC'de yasal faturanın zorunlu içeriği, basım/onay ve sıra numarası kuralları | 🟡 **İç belge.** Uygulama boşluksuz iç numara ve yazdırılabilir bir iç belge üretir; bu çıktı yasal fatura yerine geçmez. Resmî e-Fatura gönderimi ayrı bir süreçtir (§7) |
| İrsaliye biçimi ve muhasebe zamanı | KKTC'de sevk irsaliyesinin zorunlu içeriği (plaka, şoför, düzenleme saati vb.), zorunluluk eşikleri, irsaliyenin muhasebeye girdiği an | 🔴 **Doğrulanmadı.** Uygulama irsaliye için boşluksuz iç numara ve iç belge çıktısı üretir; yasal irsaliye yerine geçmez. İrsaliye yevmiye yazmaz: stok defterini etkiler, muhasebe kaydı fatura kesilince oluşur. Bu tercih mali müşavirle teyit edilmelidir |
| Hesap eşlemesi varsayılanları | 120/320 cari, 600/610 gelir, 621 maliyet, 150/153 stok, 391/191 KDV, 632 gider, 649/659 stok fazlası/zararı, 710 sarf, 500 devir karşı hesabı | 🟡 **Varsayılan.** Genel Tekdüzen yapıya dayanan **önerilen hesap eşlemesidir**; KKTC'de “yasal doğru hesap” iddiası yoktur. Ayarlar > Hesap eşlemesi'nden şirkete göre değiştirilir; ekran her açılışta mali müşavir onayı gerektiğini hatırlatır |
| KDV hesabı | Satır başına yuvarlama; KDV dahil fiyatta net = brüt ÷ (1 + oran) | 🟡 **Varsayılan.** Yuvarlama ve beyan kuralları KKTC mevzuatına göre doğrulanmadı. KDV özeti beyanname yerine geçmez |
| Kambiyo (kur farkı) hesapları | Gerçekleşen kur farkı kârı 646, zararı 656 | 🟡 **Varsayılan.** Genel Tekdüzen eşlemesidir; KKTC'de bu hesapların zorunlu olduğu iddia edilmez. Hesap eşlemesinden (`fx_gain`/`fx_loss`) değiştirilir |
| Kasa eksi bakiye | Kasa (100) eksiye düşemez, banka düşebilir (kredili mevduat) | 🟡 **Uygulama kuralı.** KKTC mevzuatındaki denetim ve ceza yaklaşımı doğrulanmadı. Denetim yalnızca uygulamadadır, veritabanı kuralı değildir |
| Kur değerlemesi ve kur seçimi | Tahsilat/ödemede kayıtlı **alış** kuru; döviz satışında hesabın ortalama maliyeti; dönem sonu değerleme henüz yapılmaz | 🟡 kur seçimi varsayılan; 🔴 **dönem sonu değerleme yöntemi doğrulanmadı.** Hangi kurun (alış/satış/gösterge) ve hangi değerleme yönteminin (ortalama, FIFO, dönem sonu kuru) kabul edildiği bilinmiyor. Değerleme, yasal kural netleşince M7b'de eklenecek |
| Kurumlar | MŞ32 raporu, İnşaat Encümeni sınıf karneleri ve m² kapasiteleri | 🔴 **Doğrulanmadı.** “Sınıf karnesi” mevzuatta geçen bir kavramdır; incelemeye göre yabancıların yap-sat ortaklığına ilişkin düzenleme müteahhitlik sınıf karnesine atıf yapıyor. MŞ32 ve kapasite hesabı için resmî bir algoritma kaynağı yok; otomatik hukuki hesap yazılmaz |

### İnceleme kaydı (1 Ekim 2026)

- **Kaynak:** Kullanıcının resmî kurum kaynaklarına karşı yaptığı madde madde inceleme, ayrıca bu depoda yapılan web aramaları. Bu ortamın ağ politikası kurum sitelerini doğrudan açmaya izin vermedi. Aşağıdaki sayfalar arama sonuçlarıyla eşleştirildi; **içerikleri tam metin olarak okunmadı**:
  - e-Fatura: [vergi.gov.ct.tr: E-Fatura sistemi tanıtıldı](https://www.vergi.gov.ct.tr/?q=content/e-fatura-sistemi-tan%C4%B1t%C4%B1ld%C4%B1), [KKTC e-Fatura başvuru teknik dokümanı](http://efatura.vergi.gov.ct.tr/sites/default/files/efatura_file/teknik_dokumanlar/kktc_efatura_basvuru_v1.pdf). REST API v1.2.3 dokümanı (`efatura.maliye.gov.ct.tr`) bu ortamdan açılamadı
  - KDV: [2025 KDV Oranları Tüzüğü (Vergi Dairesi)](http://www.vergi.gov.ct.tr/sites/default/files/2025%20Katma%20De%C4%9Fer%20Vergisi%20Oranlar%C4%B1%20T%C3%BCz%C3%BC%C4%9F%C3%BC.pdf), [mevzuat.gov.ct.tr işlenmiş metin, 29.04.2026](https://mevzuat.gov.ct.tr/Portals/48/2025%20Yl%20Katma%20Deger%20Vergisi%20Oranlar%20Tuzugu%2029_04_2026.pdf). Eylül 2026 değişiklikleri bu metinlerde yoktur
  - Taşınmaz: [Kıbrıs Gazetesi: 89/2026](https://kibrisgazetesi.com/yabancilarin-kktcde-tasinmaz-mal-edinimine-iliskin-kurallar-yeniden-duzenlendi/), [Bugün Kıbrıs: süreler](https://bugunkibris.com/yabancilarin-tasinmaz-islemlerinde-sureler-yeniden-basladi-eski-sozlesmelere-6-teslim-edilen-konutlara-36-ay/), [KTTO duyurusu](https://www.ktto.net/tasinmaz-mal-edinme-ve-uzun-vadeli-kiralama-yabancilar-degisiklik-yasasi-ve-ilgili-diger-yasalar-hakkinda/). Hepsi haber/oda kaynağıdır; Resmî Gazete metni gerekir
  - Yabancı işçi teminatı: [Kıbrıs Türk: 250 Euro teminat](https://www.kibristurk.com/calisma-izinlerinde-yeni-duzenleme-3-dunya-ulke-vatandaslari-icin-250-euro-teminat). Bakanlık duyurusunun kendisi okunmadı
  - D3 bordro: [Sosyal Sigortalar Dairesi, 2026 haberleri](https://ssd.gov.ct.tr/haber/2026)
  - Kişisel veri aktarımı: [Kıbrıs Postası: Transfer Ruhsatı](https://www.kibrispostasi.com/c35-KIBRIS_HABERLERI/n529796-kktcde-kisisel-veri-aktariminda-yeni-donem-transfer-ruhsati-ve-kisi-onayi-sarti)
- **İncelemenin kendisinde düzeltilen nokta:** İnceleme yabancı taşınmaz için 63/2026'yı esas almayı önerdi. Haberlere göre 63/2026, 7 Ağustos 2026'da 89/2026 ile değiştirildi; bu yüzden 89/2026 esas alındı.
- **Sonraki inceleme:** Her yasal parametre girilmeden önce ve en geç üç ayda bir (bkz. “Mevzuat takibi”).

### Tasarım ilkesi

Yasal parametreler kod sabiti değil **veridir**: tarih aralıklıdır, kaynak notu ve “doğrulayan kişi/zaman” alanları vardır. Bugün bu desen yalnızca `tax_rates` tablosunda uygulanıyor (`valid_from/valid_to`, `source_note`, `verified_by`, `verified_at`). Arayüz doğrulanmamış oranları rozet ve uyarıyla gösterir, dashboard kontrol listesi doğrulamayı hatırlatır. Sonraki yasal modüller (kota motoru, harç hesapları, bordro) aynı desenle eklenecek ve ilgili resmî kaynak doğrulanmadan etkinleştirilmeyecek.

İki ayrım her zaman korunur:

- **Varsayılan ≠ yasal kural.** `DEFAULT_*` adlı bir değer (ör. stok değerleme yöntemi, açılış karşı hesabı, proje gelir/maliyet sınıflandırması) sistem önerisidir ve mali müşavir değiştirebilir. Yasal kurallar ayrı parametre ailesidir ve kaynak taşır.
- **Birim/çevrim ≠ yasal sınır.** Örnek: 1.338 m² bir yasal arazi sınırıdır, genel bir dönüm çevrimi değildir.

### Hedef model (henüz uygulanmadı)

Faz B2, C ve D'den önce `tax_rates` deseni genel bir yasal parametre tablosuna genişletilecek:

```
legal_parameters
  id, jurisdiction, parameter_key, value, unit,
  category_code,                       -- ör. KDV cetvel sırası, bordro tipi
  valid_from, valid_to,
  source_type, source_number, source_date, source_url,
  verification_status,                 -- UNVERIFIED | VERIFIED | EXPIRED | SUPERSEDED | DISABLED
  verified_by, verified_at,
  supersedes_id, notes
```

- KDV oranı ürüne değil **vergi kategorisine** bağlanacak: `tax_rates` alanlarına `category_code`, `source_url` ve `status` eklenecek ya da kategori tablosu ayrılacak. Ürün kartı yalnızca kategoriyi seçecek.
- Resmî Gazete'de değişiklik çıktığında kod değişmez. Eski kaydın `valid_to` alanı doldurulur, yeni kayıt `valid_from` ve `supersedes_id` ile eklenir; geçmiş belgeler eski oranla kalır.
- Pul, tapu harcı, alım izni süreleri ve sözleşme kayıt süreleri **ayrı** parametre aileleri olur (yukarıdaki tablo). Bordro temel oranları ile dönemsel prim destekleri de ayrı tutulur.

### Mevzuat takibi

“Bir kez doğruladık, bitti” modeli bu proje için yeterli değildir. KDV tüzüğü yalnızca Eylül 2026'da birden çok kez değişti. Ticari kullanımdan önce şunlar sözleşmede ve işletim sürecinde tanımlanmalıdır:

- Resmî Gazete'yi kimin ve hangi sıklıkla izleyeceği (öneri: haftalık)
- Yeni değerin kim tarafından parametre olarak gireceği ve kimin onaylayacağı (`verified_by`)
- Satıcının müşterilere “parametre güncellemesi” yayımlayıp yayımlamayacağı ve bunun sorumluluk sınırı

## 4. Hesap planı şablonu

Yeni şirkete yüklenen hesap planı genel Tekdüzen Hesap Planı yapısına dayanır (sınıf > grup > hesap) ve KKTC'de resmi olarak doğrulanmamıştır. Şirket kurulumundan sonra düzenlenebilir. Mali müşavirle gözden geçirilmelidir.

## 5. Kişisel veriler

KKTC'de **89/2007 sayılı Kişisel Verilerin Korunması Yasası** yürürlüktedir ve Kişisel Verileri Koruma Kurulu faaliyettedir. Yurt dışına veri aktarımı için iki koşul aranır: alıcı ülke yeterli koruma sağlamalı ve Kurul ücret karşılığında bir **Transfer Ruhsatı** vermelidir. Kurul 2024'ten itibaren aktarım ve veri birleştirme ruhsatı başvurusu aldığını açıkladı. Aktarılan veri ayrıca Yasa'nın işleme koşullarını sağlamalıdır (m. 11 → m. 6/7). Uyum, ürünün **çekirdeğinde** tasarlanmalıdır (privacy-by-design); üretimden hemen önce yapılan bir hukuki kontrol yeterli değildir. Aşağıdakilerin hiçbiri hukuken doğrulanmış bir uyum iddiası değildir.

**Sistemin işlediği kişisel veriler:**

- **Bugün:** kullanıcı adı ve e-postası; cari kartlardaki kişi adı, telefon, e-posta ve adres; IP adresi ve tarayıcı bilgisi (`security_events`, `audit_log`); cihaz çerezi (`erp_device`); lisans kurulum kimliği ve lisans sunucusunun gördüğü IP (§11).
- **Personel kartı (D1):** ad soyad, uyruk, kimlik/pasaport no, doğum tarihi, IBAN, telefon, e-posta, adres. Kimlik no, doğum tarihi ve IBAN uygulama düzeyinde AES-256-GCM ile şifreli saklanır (anahtar `JWT_SECRET`'tan türetilir; **anahtar değişirse bu alanlar okunamaz**, bkz. OPERATIONS). Listede ve kartta yalnızca son 4 hane görünür; açık okuma `hr.sensitive` izni ve zorunlu gerekçe ister ve `personal_data_access_log` tablosuna (yalnız-ekleme) yazılır.
- **Puantaj (D2):** personel başına günlük kayıt: tarih, gün türü (devamsız, yıllık/hastalık/ücretsiz izin dahil), normal ve fazla mesai saati, isteğe bağlı proje/iş kalemi/maliyet kodu etiketi ve not. **Hastalık izni günü sağlık verisi sayılabilir**; envanterde ayrı satırla (`attendance.leave_type`, hassas) ve dayanağı **doğrulanmadı** olarak tutulur. Kişi verisi dışa aktarma talebi puantaj kayıtlarını da içerir. Kapalı ay değiştirilemez; yeniden açma gerekçe ister ve denetim izine yazılır. Puantaj kayıtlarının saklama süresi belirlenmemiştir (envanterde “doğrulanmadı”).
- **Bordro (D3):** personel ücret şartı (aylık/günlük/saatlik ücret), aylık bordro satırı (brüt, kesintiler, net, işveren yükü, devam özeti). **Ücret verisi `hr.payroll` izniyle sınırlıdır ve okunması erişim günlüğüne yazılır** (`payroll` alanı); bordro çıktılarında IBAN maskelidir; tüm-veri dışa aktarma personel bazında ücreti içermez. Envanterde `payroll.pay_terms` ve `payroll.lines` (hassas) olarak tutulur; dayanak ve saklama süresi **doğrulanmadı** (bordro ve ücret kayıtları için yasal saklama süresi teyit edilmedi; silme talebi yalnız kayıt altına alınır).
- **İleride:** yabancı işçi belgeleri, yabancı alıcı bilgileri (Faz B3, C, D).

**Yurt dışına aktarım değerlendirmesi:** Aşağıdaki servislerden biri kullanılırsa veri KKTC dışına çıkabilir. Her biri için aktarım ruhsatı ve işleyen sözleşmesi değerlendirilmelidir:

- SMTP sağlayıcısı, yedek depolama, lisans sunucusunun barındırıldığı VPS
- Cloudflare Tunnel ya da benzeri bir proxy (LICENSING.md'de bir dağıtım varyantıdır)
- İleride eklenirse: hata izleme (Sentry vb.), e-posta API'si (Resend vb.), analitik, yapay zekâ API'si, bulut veritabanı (Supabase, AWS vb.)

**Veri koruma modülü (D1, Veri koruma sayfası):** (1) *Envanter*: tablo/alan, kategori, amaç, hukuki dayanak, saklama süresi, yurt dışı aktarım; başlangıç kayıtları kod tarafından tohumlanır ve **tüm dayanak/süre metinleri "doğrulanmadı" rozetlidir**; düzenleme doğrulamayı sıfırlar, doğrulamayı hukuk danışmanıyla yapan kullanıcı işaretler. (2) *Talepler*: erişim/dışa aktarma/düzeltme/silme talepleri kayıt altına alınır; **silme talebi yalnızca kaydedilir**, yasal saklama yükümlülükleri nedeniyle otomatik silme yoktur. (3) *Personel verisi dışa aktarma*: `privacy.manage` + `hr.sensitive` ile, gerekçeli ve erişim günlüğüne yazılır. (4) *Erişim günlüğü*. Düzeltme geçmişi `audit_log`'dadır. Bunlar hukuki uyum iddiası değil, uyumu **destekleyen** araçlardır.

**Ürüne eklenmesi gerekenler (kısmen D1'de karşılandı; kalanlar henüz yok):**

| Kayıt / süreç | İçerik |
|---|---|
| Veri işleme envanteri | Hangi tablo hangi kişisel veriyi, hangi amaçla ve hangi dayanakla tutuyor |
| Saklama ve imha politikası | Tablo bazlı süre. Mali kayıtların yasal saklama süresiyle çatışma mali müşavirle çözülür |
| Veri dışa aktarma | İlgili kişinin talebiyle o kişiye ait verinin dışa aktarılması |
| Düzeltme | Kişisel verinin düzeltilmesi, denetim izinde iz bırakarak |
| Silme / anonimleştirme | Mali kaydı bozmadan kişisel alanların anonimleştirilmesi |
| Veri aktarım kaydı | Hangi verinin hangi ülkeye ve hangi ruhsatla aktarıldığı |
| Üçüncü taraf işleyenler | Kullanılan servisler, sözleşmeleri ve konumları |
| Güvenlik ihlali prosedürü | Tespit, Kurul'a ve ilgili kişiye bildirim, kayıt |

**Bugünkü teknik durum:**

- **Yedek dosyaları** (`scripts/backup.sh`) tüm şirketlerin verisini ve kişisel verileri içerir. Şifreli ve ofis dışı saklama, erişim sınırı ve **saklama/imha süresi işletenin sorumluluğudur** (docs/OPERATIONS.md §6). Geri yükleme tatbikatı yedeğin okunabilir olduğunu gösterir; hukuken yeterli bir saklama politikası yerine geçmez.
- **`security_events`** e-posta adresi, IP ve tarayıcı bilgisi; **`audit_log`** kullanıcı ve IP bilgisi tutar. İkisi de yalnız-ekleme türündedir ve uygulama içinden silinemez. Kaç yıl saklanacakları ve silinme/unutulma taleplerinin nasıl karşılanacağı **doğrulanmamıştır**. Mali kayıtların yasal saklama süreleri de doğrulanmamıştır. Mali müşavirle teyit etmeden denetim kaydını budamayın; budama, tetikleyicinin geçici olarak kapatılmasını gerektirir.
- Kullanıcı ve şirket **silme** özelliği yoktur (yalnızca pasifleştirme). Kişisel veri silme/dışa aktarma talebi için tanımlı bir süreç yoktur.
- **Demo verisi** tamamen kurgusaldır (örnek şirket, kişi adları ve telefonlar uydurmadır). Gerçek kişi verisi içermez ve ayrı bir örnekte çalıştırılır.
- Parola sıfırlama ve e-posta doğrulama e-postaları işletenin SMTP sağlayıcısı üzerinden gider. E-posta içeriği ve sağlayıcının veri işleme koşulları işletenin sorumluluğundadır.

## 6. Merkez Bankası kur verisi

`apps/api/src/modules/settings/kktcmb.ts`, kurumun XML biçimini **gerçek bir örnek dosyaya** (29/09/2026, duyuru 2026/182; `apps/api/test/fixtures/kktcmb-gunluk.xml`) göre ayrıştırır.

- Alış = `Doviz_Alis`, Satış = `Doviz_Satis`. Efektif kurlar okunur ama saklanmaz. Kur, `Birim` alanına bölünerek tek birime çevrilir (örn. JPY için Birim = 100).
- Yalnızca sistemin desteklediği GBP, EUR, USD alınır; diğerleri atlanır.
- Sunucu yalnızca sabit resmî adrese bağlanır (kullanıcı girdisinden adres kurulmaz), **TLS sertifika doğrulaması asla kapatılmaz**. Kurumun sitesi bazı güvenlik yazılımlarında (örn. Kaspersky) uyarı verebilir; sunucu sertifika zincirini doğrulayamazsa içe aktarma hata verir ve kullanıcı XML'i dosya olarak yükleyebilir. Zincir eksikse çözüm, eksik CA'yı `NODE_EXTRA_CA_CERTS` ile vermektir, doğrulamayı kapatmak değil.
- XML'de `DOCTYPE`/`ENTITY` bulunması, 500 KB üstü boyut, geçersiz tarih/sayı/birim reddedilir (XXE ve varlık şişirme savunması).
- **Yayın saati:** KKTC Merkez Bankası için “her iş günü 15:30” iddiasını doğrulayan bir kaynak yok (bu saat TCMB'nin gösterge kurlarına aittir). Uygulama yayın saati varsaymaz. XML'de saat alanı yoktur; ileride eklenirse okunur, yoksa yayın zamanı boş kalır.
- **Yapılacak:** ticari kullanımdan önce kurumun veri kullanım ve yeniden yayın koşullarını yazılı olarak kontrol edin. Otomatik zamanlanmış çekim ancak bu kontrolden sonra eklenebilir. Çekim zamanı kurumdan teyit edilmeli ya da “gün içinde tekrar dene” mantığıyla kurulmalıdır, sabit bir saate bağlanmamalıdır.

## 7. Rapor ve defter çıktıları

- **Yevmiye defteri ve kebir baskısı yasal onaylı defter yerine geçmez.** Ekrandan/Excel'den/PDF'e kaydedilen çıktılar iç belgedir; KKTC'de defterlerin tutulma, sayfa numaralama, onay (tasdik) ve saklama biçimi **doğrulanmamıştır**. Ticari kullanımdan önce mali müşavirle teyit edin; gerekirse resmî biçim ayrı bir çıktı olarak eklenir.
- **İç fatura ve KKTC e-Fatura ayrı şeylerdir.** Uygulamanın ürettiği fatura (ekran, baskı, PDF, XLSX) bir iç belgedir. Maliye'nin e-Fatura sistemine gönderilen resmî e-fatura ayrı bir süreçtir (§3). Faz C'de e-Fatura, iç fatura durumundan bağımsız bir gönderim durumu olarak modellenecek: `DRAFT → INTERNAL_ISSUED → SUBMITTED → ACCEPTED | REJECTED`, iptal için `CANCEL_REQUESTED → CANCELLED`. Bir faturanın resmî olarak kesildiği ancak `ACCEPTED` durumunda gösterilebilir.
- Bilanço ve gelir tablosunun KKTC'deki yasal biçimi doğrulanmadığı için bu sürümde üretilmez (mizan ve hesap bazlı raporlar vardır).
- **Kambiyo raporu** yalnızca gerçekleşmiş kur farklarını (646/656 varsayılan hesapları) gösterir; hesap eşlemesi mali müşavirce doğrulanmamıştır, dönem sonu değerleme yoktur (M7b).
- **Tam veri dışa aktarma** cari, tutar ve banka bilgisi içerir; yalnızca `data.export` izniyle (sahip, yönetici, muhasebeci) alınır ve indirilen dosyanın saklanması kullanıcı sorumluluğundadır. Kişisel veri politikası için §5'e bakın.
- **CSV/Excel formül enjeksiyonu:** metin hücreleri `= + - @` ile başlıyorsa CSV'de `'` ile etkisizleştirilir; XLSX'te formül olarak yazılmaz. İçe aktarılan metinler (M8b) olduğu gibi saklanır ve ekranda düz metin görünür; onları dışa aktaran her çıktı aynı korumadan geçer.

## 8. Açılış bakiyesi içe aktarma

- **Açılış yevmiyesinin karşı hesabı** varsayılan olarak `opening_offset` eşlemesidir (varsayılan 500 Sermaye); KKTC uygulamasında açılış farkının hangi hesaba yazılacağı ve açılışın yıl sonu kapanış/devir kaydıyla nasıl ilişkilendirileceği **doğrulanmamıştır**. Mali müşavirle teyit edilmeden gerçek şirket açılışı yapmayın; karşı hesap içe aktarma sırasında değiştirilebilir.
- **Cari açılışı** müşteri bakiyesini 120, tedarikçi bakiyesini 320 hesabına yazar (“her ikisi” türünde borç → 120, alacak → 320); bu eşleme ve avans yönü mali müşavirce doğrulanmamıştır.
- **Mizan açılışı** cari kontrol (120/320…) ve stok (150–157) hesaplarını bilerek reddeder; bu hesapların bakiyesi cari ve stok açılışından girilmelidir (alt defter ↔ hesap ayrışmasın). Yıl sonu kapanış/devir akışı henüz yoktur; **M9 kapsamına alınmadı**, KKTC uygulaması mali müşavirle teyit edilmeden yazılmayacaktır (aşağıdaki §10).
- Açılış yevmiyeleri kaynaksızdır ve normal ters kayıtla geri alınabilir; aynı dosyanın iki kez yüklenmesi engellenmez.
- **Dosya biçimi:** eski Windows CSV'leri (windows-1254) okunur; bankaya/muhasebe programına özgü biçimler doğrulanmamıştır, sütunlar kullanıcı tarafından eşlenir.

## 9. Banka ekstresi

- Banka ekstresi biçimleri (sütun adları, borç/alacak yönü, bakiye sütunu) bankadan bankaya değişir ve **bankaya özgü olarak doğrulanmamıştır**; sütunlar kullanıcı tarafından eşlenir. Ekstrede Borç = çıkan, Alacak = giren varsayılır (banka defteri görünümü); bankanız tersini kullanıyorsa Tutar + Yön ya da işaretli tutar sütununu kullanın.
- Eşleştirme önerileri (tutar birebir, tarih ±3 gün) yalnızca yardımcıdır; “kesin” öneriler dahil hiçbir eşleşme yasal mutabakat belgesi yerine geçmez. Mali müşavirinizle banka mutabakat sürecini ve saklama biçimini teyit edin.
- Ekstre dosyası sunucuda saklanmaz; yalnızca satırları (tarih, tutar, açıklama, referans) veritabanına yazılır ve eşleşmiş satırlar denetim izinde tutulur.

## 10. Ticari dağıtım ve işletim

- **Yıl sonu kapanış ve devir** (gelir/gider hesaplarının kapanışı, bilanço hesaplarının devri, açılış kaydı) ile **dönem sonu kur değerlemesi ve sonradan avans mahsubu** (M7b) bu sürümde yoktur. İkisi de KKTC'deki kabul edilen yöntem ve hesap akışı doğrulanmadan yazılmayacaktır; müşteriye bu sürümün yıl sonu işlemini yapmadığı, bu işlemlerin elle yevmiye ve mali müşavir kontrolüyle yürütülmesi gerektiği açıkça söylenmelidir.
- **İç belgeler:** fatura, irsaliye ve defter çıktıları iç belgedir; yasal fatura/irsaliye/defter yerine geçmez (§3, §7). Bu, ticari sözleşmede ve müşteri kurulum kontrol listesinde yazılı olmalıdır.
- **Ürün adı ve marka:** ticari lansmandan önce marka/alan adı taraması ve mevcut yazılım adlarına benzerlik kontrolü yapılmalıdır (§1). Bu depo adı bir çalışma adıdır.
- **Sözleşme ve sorumluluk:** hizmet seviyesi, yedekleme sorumluluğu, veri işleme (işleten/işlenen) rolleri, sorumluluk sınırı ve destek kapsamı bir avukata hazırlatılmalıdır; bu belge ve yazılım bunların yerine geçmez.
- **Yedekleme sorumluluğu:** yedeğin alınması, ofis dışına taşınması, şifrelenmesi ve geri yükleme denemesinin yapılması işletenin işidir; yazılım yalnızca araçları ve bir doğrulama tatbikatı sağlar (docs/OPERATIONS.md).
- **Üçüncü taraf bildirimi** dağıtımla birlikte verilmelidir (§2).

## 11. Lisanslama (kurulum lisansı, cihaz koltuğu, lisans sunucusu)

Teknik çalışma için [LICENSING.md](LICENSING.md). Aşağıdakilerin **hiçbiri hukuken doğrulanmamıştır**; ticari satıştan önce bir avukata gösterilmelidir.

- **Lisans sözleşmesi / EULA:** lisansın kapsamı (sektör, cihaz kotası, şirket sınırı, süre), izinli kullanım, yenileme, iptal/askı koşulları, fesih ve sorumluluk sınırı bir **sözleşme metniyle** tanımlanmalıdır. Bu depo ve yazılım o metnin yerine geçmez; ilgili metni avukat hazırlar. Yazılımın "salt-okunur moda düşme" davranışı sözleşmede **açıkça** yazılı olmalıdır.
- **Lisans sunucusuna giden veriler:** kurulum kimliği, kurulum açık anahtarı, sunucu parmak izi (makine kimliği ve veritabanı küme kimliğinin **özeti**), uygulama sürümü, etkinleştirme kodu ve kalp atışında etkin cihaz/şirket **sayısı**; sunucu ayrıca bağlantının **IP adresini** görür ve kaydeder (klon şüphesi için). Muhasebe verisi, kullanıcı ve müşteri bilgisi gönderilmez. IP adresi ve kurulum kimliği, aksi teyit edilene kadar **kişisel veri sayılır**; işleme dayanağı ve saklama süresi **doğrulanmadı**. Lisans sunucusu KKTC dışında barındırılıyorsa ya da Cloudflare Tunnel gibi bir proxy üzerinden yayınlanıyorsa bu bir yurt dışı aktarımdır (§5). Müşteriye bu veri akışı sözleşmede ve uygulama içinde (Ayarlar > Lisans) açıklanır.
- **Cihaz tanımı ve çerez:** "cihaz", sunucunun verdiği imzalı kimlikle tanınan kayıtlı bir tarayıcı/bilgisayardır (`erp_device` çerezi: HttpOnly, SameSite=Strict, yalnızca oturum uçlarında, 1 yıl). Bu çerez lisans koltuğunu saymak için kesinlikle gereklidir; çerez bildirimi/rıza gereksinimi **doğrulanmadı**. Gerçek donanım kimliği toplanmaz.
- **Salt-okunur mod ve verinin rehin tutulmaması:** lisans bitince ya da doğrulanamayınca yazma kapanır, görüntüleme ve **dışa aktarma açık kalır**; müşteri verisine erişimin kesilmemesi bilinçli bir tasarım kararıdır (veri müşterinindir: yazma kapalı, okuma ve dışa aktarma açık). Sözleşme bunu açıkça yazmalıdır. Bu yaklaşımın sözleşme ve tüketici/ticaret mevzuatı açısından yeterliliği **doğrulanmadı**.
- **Uzaktan askıya alma / iptal:** satıcı, kalp atışı yoluyla lisansı uzaktan askıya alabilir ya da iptal edebilir (salt-okunura geçiş). Hangi koşullarda bunun meşru olduğu (ödeme gecikmesi, kötüye kullanım) sözleşmede yazılı olmalıdır; tek taraflı kullanım hukuki risktir.
- **Satıcı kayıtları:** lisans sunucusu yönetici işlemlerini ve etkinleştirmeleri (IP dahil) yalnız-ekleme denetim kaydında tutar; saklama süresi ve erişim politikası **doğrulanmadı**.
- **Kırılamazlık iddiası yapılmaz:** müşteri sunucuyu kontrol ediyorsa lisans denetimi yamalanabilir; bunu engelleyen bir güvence verilmez, hukuki koruma sözleşmeye dayanır (yazılımın kopyalanması/değiştirilmesi yasağı dahil).
- **Anahtar ve hesap güvenliği:** satıcı özel anahtarı ve yönetim paneli kritik varlıktır; ele geçirilmesi durumunda müşterilere duyuru ve anahtar değişikliği yükümlülüğü sözleşmede düzenlenmelidir.

## 12. Şantiye projeleri ve inşaat modülü (Faz B)

Teknik çalışma için [ARCHITECTURE.md](ARCHITECTURE.md) "Şantiye projeleri". Aşağıdakilerin **hiçbiri doğrulanmamıştır**; ticari kullanımdan önce mali müşavir/avukatla teyit edilmelidir.

- **Proje maliyet/gelir sınıflandırması:** proje raporunda 60, 61 ve 64 ile başlayan hesaplar **gelir**, projeye etiketlenen diğer gelir/gider/maliyet hesapları **maliyet** sayılır (Tekdüzen sınıf 6 hem gelir hem gider hesabı içerdiği için kod önekiyle ayrılır). Bu yalnızca bir **yönetim raporu sınıflandırmasıdır** (`PROJECT_REPORTING_CLASSIFICATION`), yasal inşaat muhasebesi kuralı değildir; KKTC'de inşaat maliyetinin hangi hesaplarda izlendiği (ör. 7xx üretim maliyeti, yarım kalmış inşaat hesapları) ve gelir tanıma yöntemi **doğrulanmamıştır**. Proje raporu yasal maliyet/kâr hesabı değildir.
- **Yalnızca defter para birimi:** proje bütçesi ve gerçekleşen maliyet defter para biriminde (TL) gösterilir; raporlama para birimi (GBP) karşılığı sonraki aşamadadır.
- **Faz B parametre aileleri (hedef model §3):** B2–B4'te uygulananlar tarihli, kaynak notlu ve doğrulama alanlı ayrı tablolardadır (`construction_params`: teminat/stopaj/avans; `fee_schedules`: altyapı fonu/harç; `tax_rates`: KDV). **Henüz kodda olmayanlar**, girilirken yine ayrı, tarihli ve kaynak notlu parametre ailesi olacaktır (tek bir genel "inşaat kuralı" tablosunda toplanmaz):
  - pul vergisi (damga) — Faz B kapanışında **yapılmadı**; KDV tevkifatı ve malzeme mahsubu aşağıdaki "Faz B kapanışı" maddesindeki sınırlarla uygulandı
  - gayrimenkul satışında gelir tanıma yönteminin seçeneği (teslimde uygulanmıştır; tamamlanma oranına göre yok)
  - yabancı alıcı sınırları ve alım izni süreleri: eski 39/2024–42/2025 kota modeli **kullanılmaz**; yürürlükteki 89/2026 YGK ve sonraki değişiklikler esas alınır (§3); Faz C
  - tapu devir harçları (B4 fon/harç tarifeleri bunu alıcıdan tahsil edilen kalem olarak taşıyabilir, oranı doğrulanmamıştır)

  Yabancı alıcı sınırları için haber düzeyinde kaynak var (§3). Diğerlerinin hiçbiri resmî kaynaktan doğrulanmadı.
- **Faz B2 (taşeron hakedişi) — uygulanmıştır ama hiçbiri doğrulanmamıştır:** (1) teminat, stopaj ve avans mahsup yüzdeleri `construction_params` tablosunda tarihli, kaynak notlu ve doğrulama alanlıdır; sözleşme açılırken değer sözleşmeye kopyalanır. Kodda sabit oran yoktur; "doğrulandı" işareti verilmeyen değer ekranda rozetle uyarılır. (2) Yüzdelerin **tabanı** brüt hakediş (KDV hariç) alınmıştır; KDV hariç/dahil tabanın, stopajın ve teminatın KKTC'de nasıl hesaplandığı, KDV tevkifatı ve damga/pul harcı **doğrulanmamıştır** (tevkifat ve harç B2'de yoktur). (3) Hakediş yevmiyesinin hesapları (`subcontract_cost` 740, `retention_payable` 326, `withholding_payable` 360, `subcontract_advance` 159, cari 320, KDV 191) genel Tekdüzen yapıya dayanan **doğrulanmamış varsayılanlardır**; Ayarlar > Hesap eşlemesinden değiştirilir. (4) Diğer kesinti (ceza, malzeme mahsubu) maliyet satırından orantılı düşülür; bu muhasebe işleyişi mali müşavirle teyit edilmelidir. (5) Hakediş çıktıları iç belgedir; yasal hakediş belgesi yerine geçmez.
- **Faz B kapanışı (KDV tevkifatı, malzeme mahsubu) — doğrulanmamıştır:** (1) **KDV tevkifatı:** KKTC'de inşaat/taşeron hizmetinde KDV'nin bir kısmının alıcı tarafından tevkif edilip edilmediği, oranı, kapsamı, tevkif edilen KDV'nin beyanı ve indirimi **teyit edilmemiştir**; `vat_withholding_pct` parametresi varsayılan 0 (kapalı), tarihli ve kaynak notludur. Hesap eşlemeleri (`vat_withholding_payable` 360, `vat_withholding_receivable` 136) genel Tekdüzen yapıya dayanan varsayılandır; Ayarlar > Hesap eşlemesinden değiştirilir. İşveren tarafındaki tevkif edilen KDV'nin alacak olarak izlenmesi ve mahsubu doğrulanmamıştır. (2) **Malzeme mahsubu:** taşerona verilen malzemenin bedelinin (stok çıkış maliyeti, KDV hariç) hakedişten kesilmesi bir **ticari/sözleşme düzenlemesidir**; KDV ve vergisel sonucunun (malzemenin satış mı, iş için teslim mi sayılacağı, fatura/irsaliye gereği) mali müşavirce teyit edilmesi gerekir. Mahsup edilene kadar proje maliyeti fazla görünür (ARCHITECTURE "KDV tevkifatı ve malzeme mahsubu"). (3) **Damga/pul vergisi** modellenmemiştir.
- **Faz B4 (fonlar, kârlılık, nakit) — doğrulanmamıştır:** (1) **Altyapı fonu/harç tutarları ve oranları** (elektrik, su, kanalizasyon, belediye, tapu vb.) KKTC mevzuatından teyit edilmemiştir; tarifeler şirket tarafından girilir, kaynak notu ve "doğrulandı" işareti taşır, kodda sabit değer yoktur. (2) Alıcıdan tahsil edilen fon, hesaba `fee_payable` (varsayılan 329) yükümlülüğü olarak yazılır; fonun işletme için gelir mi, geçici hesap mı, KDV'ye tabi mi olduğu ve idareye ödeme zamanı doğrulanmamıştır. Fesihte tahsil edilen fonun kesintisiz iadesi varsayımdır. (3) **Proje kârlılığı** iç yönetim raporudur: sözleşmeli gelir − EAC; yasal kâr/zarar hesabı veya vergi matrahı değildir; gelir tanıma B3 notlarına tabidir. Yönetim para birimi karşılıkları bilgi amaçlıdır. (4) **Nakit projeksiyonu** vade tarihlerinden türetilen bir tahmindir; tahsilat gecikmeleri ve vadesi belirsiz taahhütleri içermez.
- **Faz B3 (gayrimenkul satışı) — doğrulanmamıştır:** (1) **Gelir tanıma:** gelir teslimde tanınır (ertelenmiş gelir 380 → taşınmaz satış geliri 600); KKTC'de taşınmaz satışında gelirin sözleşmede mi, tapu devrinde mi, teslimde mi ya da tamamlanma oranına göre mi tanınacağı ve vergi dönemine etkisi teyit edilmemiştir (`recognition` sözleşmede veri olarak saklanır, yöntem eklenebilir). (2) **Hesap kodları:** `deferred_revenue` 380, `property_revenue` 600, `termination_income` 679 genel Tekdüzen yapıya dayanan varsayılandır; Ayarlar > Hesap eşlemesinden değiştirilir. Ertelenmiş gelirin uzun vadeli kısmının 480'e ayrılması yapılmaz. (3) **KDV, tapu harcı, damga ve satış masrafları** modellenmemiştir; tutarlar KDV'siz sözleşme bedelidir. (4) **Fesih:** kesintinin (ceza şartı) hukuki sınırı, kesintinin gelir/KDV/stopaj niteliği ve iade süreleri teyit edilmemiştir; kesinti 679'a yazılır. Teslimden sonra fesih desteklenmez. (5) **Yabancılara satış:** kota, izin ve süre kuralları Faz C kapsamındadır; bu fazda denetlenmez. (6) Dövizli taksit alacağı etkinleşme günü kuruyla yazılır; tahsilatta oluşan kur farkı mevcut kambiyo kuralıyla (646/656) işlenir, dönem sonu değerleme (M7b) yoktur. Sözleşme ve ödeme planı çıktıları iç belgedir, yasal satış sözleşmesi yerine geçmez.
- **Faz B2p (satın alma zinciri):** yeni hesap eşlemesi veya yasal parametre eklenmedi. Sipariş KDV oranı `tax_rates` kaydından (kodu şirket seçer) sipariş verildiği gün donar; kaydın doğrulanmamış olması burada da geçerlidir. Mal kabulün muhasebesi mevcut alış irsaliyesi akışına aittir (§ irsaliye notları); sipariş ve teklifler iç belgedir, yasal sözleşme veya fatura yerine geçmez. Teklif karşılaştırmasındaki kur dönüşümü bilgi amaçlıdır, kayda geçmez.
- **Faz B2e (işveren hakedişi) — doğrulanmamıştır:** alınan hakedişin muhasebesi (`claim_revenue` 600, `retention_receivable` 126, `advance_received` 340, `withholding_receivable` 193, cari 120, KDV 391) genel Tekdüzen yapıya dayanan varsayılandır; Ayarlar > Hesap eşlemesinden değiştirilir. Hakediş gelirinin **tanınma zamanı ve yöntemi** (hakediş onayında, teslimde ya da tamamlanma oranına göre), işverenin kestiği stopajın peşin vergi olarak izlenmesi ve teminatın alacak olarak gösterilmesi KKTC'de doğrulanmamıştır; gelir tanıma yöntemi B3 ile birlikte netleşecektir. Çıktılar iç belgedir, yasal hakediş/fatura yerine geçmez.
- **Yetki:** proje bazında kullanıcı kısıtı yoktur (rol yeterlidir). Şantiye sorumlusu rolü bütün projelerin bütçe ve maliyetini görür; proje bazlı gizlilik gerekiyorsa sözleşmede ve kurulum kontrol listesinde belirtilmelidir.

## 13. Bordro (Faz D3)

- **Tüm bordro parametreleri 🔴 doğrulanmamıştır ve varsayılan KAPALIDIR.** Sosyal güvenlik primi (işçi/işveren), gelir vergisi, asgari ücret, fazla mesai çarpanı, aylık gün/günlük saat böleni, hastalık/yıllık izin ödeme yüzdesi ve prim esası tavanı KKTC mevzuatından bu sistemde **okunmadı/teyit edilmedi**. Uygulama bunların **hiçbirini kodda ya da varsayılan veride tutmaz**: yalnızca `payroll_params` tablosunda, kullanıcının girdiği **tarihli, kaynak notlu, doğrulama alanlı** satırlar olarak yaşar ve satır **açılmadıkça** hiçbir yasal hesap yapılmaz. Açık ama doğrulanmamış parametreyle hesaplanan her bordro, pusula, dışa aktarma ve rapor **⚠ "oranlar doğrulanmadı"** uyarısı taşır; bordro kaydı oranları kopyalar (sonradan parametre değişse de belge değişmez). §3'teki D3 bordro tipi notu (Sosyal Sigortalar Dairesi duyurusu) bilgi amaçlıdır; oranlar koda ya da tohum veriye **alınmadı** — işleten kendi sorumluluğunda parametre olarak girer ve doğrular. Doğrulama kaydı kullanıcıya ve zamana bağlanır; kaynak notu değişirse doğrulama sıfırlanır.
- **Bordro bir iç belgedir, resmî bordro/maaş bordrosu değildir.** Ekranlarda, pusulada, basılı çıktıda ve dışa aktarmada "taslak / iç belge — resmî bordro değildir" yazar. Resmî bordro, SGK/Sosyal Sigortalar Dairesi bildirimi ve vergi beyanı için gereken biçim ve içerik **doğrulanmamıştır** (D4'te ele alınacaktır); çıktılar yetkili mali müşavirce kontrol edilmeden resmî amaçla kullanılmamalıdır.
- **Gelir vergisi** yalnız **düz yüzde** olarak modellenir (dilimli/kümülatif vergi, vergi indirimleri, asgari geçim indirimi gibi mekanizmalar **yoktur**); gerekirse elle kesinti kalemi kullanılır. Vergi esasından işçi priminin düşülüp düşülmeyeceği bir parametre bayrağıdır (`tax_base_deducts_social`), varsayılanı yoktur. "Prime/vergiye esas ek ödeme" bayrakları kullanıcının kalem tanımında verdiği bilgidir.
- **Muhasebeleştirme:** bordro yevmiyesinin hesap eşlemeleri (`payroll_labor_cost` 720, `payroll_employer_cost` 720, `payroll_payable` 335, `payroll_social_payable` 361, `payroll_tax_payable` 360, `payroll_other_payable` 336) genel Tekdüzen yapıya dayanan **doğrulanmamış varsayılanlardır**; işçilik giderinin 720 (direkt işçilik) / 730 / 770 arasındaki sınıflandırması, işveren yükünün gider hesabı ve ödenecek yükümlülüklerin hesapları mali müşavirce teyit edilmelidir (Ayarlar > Hesap eşlemesi). Gider proje/iş kalemi/maliyet koduna **puantaj saatlerine göre** etiketlenir; bu dağılım yönetim muhasebesi yaklaşımıdır, yasal bir dağıtım kuralı değildir.
- **Ay ve ücret kuralları (yasal değil, tasarım):** ücret şartı ve parametreler **ayın son günündeki** geçerli durumla tüm aya uygulanır; ay ortasında işe giriş/çıkış ya da ücret değişikliği otomatik orantılanmaz (uyarı verilir, elle kesinti girilir). Bu, KKTC'deki gün/ay hesabı kurallarını (30 gün esası vb.) **varsaymaz**: gün böleni `days_per_month` parametresidir.
- **Çalışma süresi ve izin** yorumları §3'teki puantaj satırı gibi **doğrulanmadı**: hastalık/yıllık izin gününün ücreti, tatilde çalışma ücreti ve fazla mesai çarpanları yalnız kullanıcı parametreleriyle hesaplanır; resmî tatil/hafta tatili çalışması için ayrı çarpan yoktur.

