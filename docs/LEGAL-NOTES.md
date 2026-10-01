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

**xlsx yazma/okuma:** `exceljs` kurulumda `npm audit --omit=dev` (uuid) ve lisans denetimini (`buffers@0.1.1`, lisansı belirsiz) geçemediği için kullanılmadı. Bunun yerine MIT lisanslı `fflate` (zip) ve `fast-xml-parser` üstüne kendi küçük yazıcı/okuyucumuz yazıldı (`apps/api/src/files/`); izin listesi genişletilmedi.

**Dağıtımda bildirim yükümlülüğü:** MIT, BSD, ISC ve Apache-2.0 lisansları, yazılımı (imaj olarak) dağıtırken telif bildiriminin ve lisans metninin birlikte verilmesini şart koşar. `npm run licenses:notices` üretim bağımlılık kümesinden (yaklaşık 190 paket; geliştirme araçları hariç) `THIRD-PARTY-NOTICES.md` üretir; dosya Docker imajı derlenirken oluşturulur, imajda `/app/THIRD-PARTY-NOTICES.md` olarak bulunur ve arayüz kökünden `/THIRD-PARTY-NOTICES.md` adresiyle sunulur. **Sekiz paket lisans dosyasını yayımlamaz** (`@nodable/entities`, `@node-rs/argon2-linux-x64-gnu`/`-musl`, `abstract-logging`, `drizzle-orm`, `pg-types`, `pgpass`, `react-remove-scroll-bar`); bu paketler için bildirimde lisans türü ve kaynak adresi yazılıdır, lisans metni yoktur. Apache-2.0 (örn. `drizzle-orm`) lisans metninin bir kopyasının verilmesini ayrıca ister: **ticari dağıtımdan önce** bu eksik metinleri kaynak depolardan tamamlamak ve bildirimi bir avukata göstermek gerekir.

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

Bugünkü teknik durum (hiçbiri hukuken doğrulanmış bir uyum iddiası değildir):

- **Yedek dosyaları** (`scripts/backup.sh`) tüm şirketlerin verisini ve kişisel verileri içerir; şifreli ve ofis dışı saklama, erişim sınırı ve **saklama/imha süresi işletenin sorumluluğudur** (docs/OPERATIONS.md §6). Geri yükleme tatbikatı yedeğin okunabilir olduğunu gösterir; hukuken yeterli bir saklama politikası yerine geçmez.
- **`security_events`** e-posta adresi, IP ve tarayıcı bilgisi; **`audit_log`** kullanıcı ve IP bilgisi tutar. Her ikisi yalnız-ekleme türündedir ve uygulama içinden silinemez; kaç yıl saklanacağı ve silinme/unutulma taleplerinin nasıl karşılanacağı **doğrulanmamıştır**. Mali kayıtların yasal saklama süreleri de doğrulanmamıştır; mali müşavirle teyit etmeden denetim kaydını budamayın (budama tetikleyicinin geçici kapatılmasını gerektirir).
- Kullanıcı ve şirket **silme** özelliği yoktur (yalnızca pasifleştirme); kişisel veri silme/dışa aktarma talebi için tanımlı bir süreç yoktur.
- **Demo verisi** tamamen kurguseldir (örnek şirket, kişi adları ve telefonlar uydurmadır); gerçek kişi verisi içermez ve ayrı bir örnekte çalıştırılır.
- Parola sıfırlama ve e-posta doğrulama e-postaları işletenin SMTP sağlayıcısı üzerinden gider; e-posta içeriği ve sağlayıcının veri işleme koşulları işletenin sorumluluğundadır.

## 6. Merkez Bankası kur verisi

`apps/api/src/modules/settings/kktcmb.ts`, kurumun XML biçimini **gerçek bir örnek dosyaya** (29/09/2026, duyuru 2026/182; `apps/api/test/fixtures/kktcmb-gunluk.xml`) göre ayrıştırır.

- Alış = `Doviz_Alis`, Satış = `Doviz_Satis`. Efektif kurlar okunur ama saklanmaz. Kur, `Birim` alanına bölünerek tek birime çevrilir (örn. JPY için Birim = 100).
- Yalnızca sistemin desteklediği GBP, EUR, USD alınır; diğerleri atlanır.
- Sunucu yalnızca sabit resmî adrese bağlanır (kullanıcı girdisinden adres kurulmaz), **TLS sertifika doğrulaması asla kapatılmaz**. Kurumun sitesi bazı güvenlik yazılımlarında (örn. Kaspersky) uyarı verebilir; sunucu sertifika zincirini doğrulayamazsa içe aktarma hata verir ve kullanıcı XML'i dosya olarak yükleyebilir. Zincir eksikse çözüm, eksik CA'yı `NODE_EXTRA_CA_CERTS` ile vermektir, doğrulamayı kapatmak değil.
- XML'de `DOCTYPE`/`ENTITY` bulunması, 500 KB üstü boyut, geçersiz tarih/sayı/birim reddedilir (XXE ve varlık şişirme savunması).
- **Yapılacak:** ticari kullanımdan önce kurumun veri kullanım/yeniden yayın koşullarını yazılı olarak kontrol edin; otomatik zamanlanmış çekim yalnızca bu doğrulamadan ve yayın saati netleştikten sonra eklenmeli.

## 7. Rapor ve defter çıktıları

- **Yevmiye defteri ve kebir baskısı yasal onaylı defter yerine geçmez.** Ekrandan/Excel'den/PDF'e kaydedilen çıktılar iç belgedir; KKTC'de defterlerin tutulma, sayfa numaralama, onay (tasdik) ve saklama biçimi **doğrulanmamıştır**. Ticari kullanımdan önce mali müşavirle teyit edin; gerekirse resmî biçim ayrı bir çıktı olarak eklenir.
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
- **Lisans sunucusuna giden veriler:** kurulum kimliği, kurulum açık anahtarı, sunucu parmak izi (makine kimliği ve veritabanı küme kimliğinin **özeti**), uygulama sürümü, etkinleştirme kodu ve kalp atışında etkin cihaz/şirket **sayısı**; sunucu ayrıca bağlantının **IP adresini** görür ve kaydeder (klon şüphesi için). Muhasebe verisi, kullanıcı ve müşteri bilgisi gönderilmez. IP adresi ve kurulum kimliğinin KKTC'de kişisel veri sayılıp sayılmadığı, dayanak ve saklama süresi **doğrulanmadı**; müşteriye bu veri akışı sözleşmede ve uygulama içinde (Ayarlar > Lisans) açıklanır.
- **Cihaz tanımı ve çerez:** "cihaz", sunucunun verdiği imzalı kimlikle tanınan kayıtlı bir tarayıcı/bilgisayardır (`erp_device` çerezi: HttpOnly, SameSite=Strict, yalnızca oturum uçlarında, 1 yıl). Bu çerez lisans koltuğunu saymak için kesinlikle gereklidir; çerez bildirimi/rıza gereksinimi **doğrulanmadı**. Gerçek donanım kimliği toplanmaz.
- **Salt-okunur mod ve verinin rehin tutulmaması:** lisans bitince ya da doğrulanamayınca yazma kapanır, görüntüleme ve **dışa aktarma açık kalır**; müşteri verisine erişimin kesilmemesi bilinçli bir tasarım kararıdır. Bu yaklaşımın sözleşme ve tüketici/ticaret mevzuatı açısından yeterliliği **doğrulanmadı**.
- **Uzaktan askıya alma / iptal:** satıcı, kalp atışı yoluyla lisansı uzaktan askıya alabilir ya da iptal edebilir (salt-okunura geçiş). Hangi koşullarda bunun meşru olduğu (ödeme gecikmesi, kötüye kullanım) sözleşmede yazılı olmalıdır; tek taraflı kullanım hukuki risktir.
- **Satıcı kayıtları:** lisans sunucusu yönetici işlemlerini ve etkinleştirmeleri (IP dahil) yalnız-ekleme denetim kaydında tutar; saklama süresi ve erişim politikası **doğrulanmadı**.
- **Kırılamazlık iddiası yapılmaz:** müşteri sunucuyu kontrol ediyorsa lisans denetimi yamalanabilir; bunu engelleyen bir güvence verilmez, hukuki koruma sözleşmeye dayanır (yazılımın kopyalanması/değiştirilmesi yasağı dahil).
- **Anahtar ve hesap güvenliği:** satıcı özel anahtarı ve yönetim paneli kritik varlıktır; ele geçirilmesi durumunda müşterilere duyuru ve anahtar değişikliği yükümlülüğü sözleşmede düzenlenmelidir.

## 12. Şantiye projeleri ve inşaat modülü (Faz B)

Teknik çalışma için [ARCHITECTURE.md](ARCHITECTURE.md) "Şantiye projeleri". Aşağıdakilerin **hiçbiri doğrulanmamıştır**; ticari kullanımdan önce mali müşavir/avukatla teyit edilmelidir.

- **Proje maliyet/gelir sınıflandırması:** proje raporunda 60, 61 ve 64 ile başlayan hesaplar **gelir**, projeye etiketlenen diğer gelir/gider/maliyet hesapları **maliyet** sayılır (Tekdüzen sınıf 6 hem gelir hem gider hesabı içerdiği için kod önekiyle ayrılır). Bu yalnızca yönetim raporu varsayılanıdır; KKTC'de inşaat maliyetinin hangi hesaplarda izlendiği (ör. 7xx üretim maliyeti, yarım kalmış inşaat hesapları) ve gelir tanıma yöntemi **doğrulanmamıştır**. Proje raporu yasal maliyet/kâr hesabı değildir.
- **Yalnızca defter para birimi:** proje bütçesi ve gerçekleşen maliyet defter para biriminde (TL) gösterilir; raporlama para birimi (GBP) karşılığı sonraki aşamadadır.
- **Faz B2–B4 parametreleri (henüz kodda yok, girilirken tarihli ve kaynak notlu veri olarak girilecek):** taşeron hakedişinde stopaj oranı, teminat kesintisi, KDV tevkifatı, damga/pul harcı; avans ve malzeme mahsubu kuralları; gayrimenkul satışında gelir tanıma yöntemi (tesliminde / tamamlanma oranına göre), 39/2024 yabancı alıcı kotası ve süreleri, altyapı fonları ve tapu harçları. Bunların hiçbiri resmî kaynaktan doğrulanmadı; §3 tablosundaki ilgili satırlarla birlikte değerlendirilmelidir.
- **Faz B2 (taşeron hakedişi) — uygulanmıştır ama hiçbiri doğrulanmamıştır:** (1) teminat, stopaj ve avans mahsup yüzdeleri `construction_params` tablosunda tarihli, kaynak notlu ve doğrulama alanlıdır; sözleşme açılırken değer sözleşmeye kopyalanır. Kodda sabit oran yoktur; "doğrulandı" işareti verilmeyen değer ekranda rozetle uyarılır. (2) Yüzdelerin **tabanı** brüt hakediş (KDV hariç) alınmıştır; KDV hariç/dahil tabanın, stopajın ve teminatın KKTC'de nasıl hesaplandığı, KDV tevkifatı ve damga/pul harcı **doğrulanmamıştır** (tevkifat ve harç B2'de yoktur). (3) Hakediş yevmiyesinin hesapları (`subcontract_cost` 740, `retention_payable` 326, `withholding_payable` 360, `subcontract_advance` 159, cari 320, KDV 191) genel Tekdüzen yapıya dayanan **doğrulanmamış varsayılanlardır**; Ayarlar > Hesap eşlemesinden değiştirilir. (4) Diğer kesinti (ceza, malzeme mahsubu) maliyet satırından orantılı düşülür; bu muhasebe işleyişi mali müşavirle teyit edilmelidir. (5) Hakediş çıktıları iç belgedir; yasal hakediş belgesi yerine geçmez.
- **Faz B2e (işveren hakedişi) — doğrulanmamıştır:** alınan hakedişin muhasebesi (`claim_revenue` 600, `retention_receivable` 126, `advance_received` 340, `withholding_receivable` 193, cari 120, KDV 391) genel Tekdüzen yapıya dayanan varsayılandır; Ayarlar > Hesap eşlemesinden değiştirilir. Hakediş gelirinin **tanınma zamanı ve yöntemi** (hakediş onayında, teslimde ya da tamamlanma oranına göre), işverenin kestiği stopajın peşin vergi olarak izlenmesi ve teminatın alacak olarak gösterilmesi KKTC'de doğrulanmamıştır; gelir tanıma yöntemi B3 ile birlikte netleşecektir. Çıktılar iç belgedir, yasal hakediş/fatura yerine geçmez.
- **Yetki:** proje bazında kullanıcı kısıtı yoktur (rol yeterlidir). Şantiye sorumlusu rolü bütün projelerin bütçe ve maliyetini görür; proje bazlı gizlilik gerekiyorsa sözleşmede ve kurulum kontrol listesinde belirtilmelidir.
