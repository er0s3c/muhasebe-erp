# Ada Muhasebe geliştirme programı

Güncelleme: 6 Ekim 2026. Kullanıcı kapsamı: önerilen geliştirmelerin tamamını planlamak ve uygulamak. Pilot katılımcısı ve resmî e-Fatura test erişimi henüz yok; kullanıcı geliştirme ve yerel testlerle ilerlenmesini istedi.

## Uygulanan kapsam

| Aşama | Kullanılabilir özellik                                                                                                                          | Durum                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1     | Bugünkü işlerim: sorumlu, termin, tamamlama/yeniden açma, kişisel görev izolasyonu; vade/onay/belge/saha uyarıları, okundu ve erteleme          | Uygulandı, yerel test geçti                        |
| 2     | Belge arşivi: kaynak kayıt bağlantısı, PDF/JPEG/PNG yükleme ve indirme, değişmez sürümler; ayarlarda 1–100 MB belge sınırı                              | Uygulandı, API ve tarayıcı testi geçti             |
| 3     | Ctrl+K kayıt araması: cari, fatura, proje, sözleşme ve desteklenen operasyon kayıtları; yetki/modül filtreleri                                  | Uygulandı, API ve tarayıcı testi geçti             |
| 4     | İlk kullanım rehberi: gerçek şirket verisinden kurulum adımları ve ilgili ekran bağlantıları                                                    | Uygulandı, API testi geçti                         |
| 5     | Tahsilat takibi: cari, görüşme notu, ödeme sözü, para birimi, sorumlu ve takip tarihi                                                           | Uygulandı; gerçek kullanıcı pilotu bekliyor        |
| 6     | Mobil şantiye: günlük rapor, çalışan sayısı, yapılan işler/sorunlar; puantaj, mal kabul ve talep ekranlarına bağlantılar; cihazda taslak        | Uygulandı, 390 px tarayıcı testi geçti             |
| 7     | İş programı: proje/WBS, tarihler, ilerleme, bağımlılık ve döngü kontrolü, gecikme tahmini                                                       | Uygulandı, API ve hesaplama testi geçti            |
| 8     | Ekipman/araç: proje envanteri, çalışma, yakıt, bakım/kira tutarı ve fatura bağlantısı                                                           | Uygulandı, proje izolasyonu testi geçti            |
| 9     | Teslim/kusur: birim, konum, sorumlu/taşeron, termin, fotoğraf ekleri, çözümle kapatma, yazdırılabilir tutanak                                   | Uygulandı, API testi geçti                         |
| 10    | Müşteri/taşeron portalı: cariye özel süreli bağlantı + parola, açık kalemler/sözleşme özetleri, açıkça seçilmiş belgeler, iptal ve erişim kaydı | Uygulandı, API ve tarayıcı testi geçti             |
| 11    | Nakit senaryoları: tahsilat gecikmesi ve çıkış artışı, temel tahminle karşılaştırma, dönem dışına kayan tutarlar, saklanan varsayımlar          | Uygulandı, hesaplama ve tarayıcı testi geçti       |
| 12    | Sayfalama/çıktı sınırları, tekrar gönderim koruması, yük senaryoları ve bu kullanım/test belgesi                                                | Yerel doğrulama yapıldı; büyük veri yük testi ayrı |
| 13    | Muhasebeci, şantiye sorumlusu ve yöneticiyle gerçek kullanıcı pilotu                                                                            | Katılımcı bekliyor                                 |
| 14    | Resmî e-Fatura uçtan uca doğrulaması ve mevzuat teyidi                                                                                          | Resmî test erişimi ve uzman doğrulaması bekliyor   |

## Kullanım

Sol menüde çalışma alanı ekranlarını açın. Önce cari/proje/birim gibi ana kayıtları mevcut ERP ekranlarında oluşturun. İş kaydında sorumlu ve tarihleri seçin; listeden düzenleyin veya tamamlayın. İş programında tamamlanan işin ilerlemesi otomatik %100 olur. Bağımlılığı olan iş, bağlantılar kaldırılmadan iptal edilemez.

Belge arşivinde ilgili kaydı arayın; dosyayı yükleyin veya mevcut belgeden “Yeni sürüm” seçin. Belgeye erişim her istekte bağlı kaydın güncel izniyle denetlenir. Kusur ve saha raporuna kendi ekleri bağlanır. Teslim/kusur ekranında birim seçerek kontrol tutanağını açın; “Yazdır / PDF” tarayıcı yazdırma penceresini kullanır.

Saha formundaki “Taslağı cihazda sakla” aynı tarayıcıda şirket ve kullanıcıya özel saklar. “Taslağı yükle” geri getirir; gönderim kullanıcı tarafından yapılır. Aynı taslak kimliğiyle tekrar gönderim kayıt çoğaltmaz; farklı içerikle tekrar gönderim çakışma verir. Bu, tüm uygulamayı çevrimdışı açan bir PWA veya otomatik eşitleme değildir. Paylaşılan cihazdaki taslağı işi bitirince temizleyin.

Portal erişimini yönetici oluşturur: cariyi, izin verilen belgeleri, 12 karakter veya daha uzun parolayı ve 1–30 günlük süreyi seçer. Üretilen bağlantı bir kez gösterilir. Dış kullanıcı personel hesabıyla oturum açmaz; bağlantı ve parola ile erişir. Erişim iptal edilebilir; bağlantıyı oluşturan kişinin üyelik/yetkileri her istekte yeniden doğrulanır. Otomatik davet/e-posta gönderimi yapılmaz. Yeni belge sürümleri kendiliğinden paylaşılmaz; paylaşım seçilen belge kimlikleriyle sınırlıdır.

## Sınırlar ve işletim

- Şirket RLS politikaları ile modül ve kullanıcıya özel etkin izinler birlikte uygulanır. Görevler sorumlu/oluşturan/yönetici kapsamındadır; operasyon kayıtları ilgili modül iznini izler.
- Tahsilat sözü ve ekipman gideri muhasebeleştirilmez. Gerçek para/stok/muhasebe işlemi mevcut ERP akışından yapılır; bağlantı aynı maliyeti ikinci kez yazmaz.
- Nakit senaryosu temel tahminin anlık verisine uygulanır. Saklanan şey varsayımlardır; geçmiş tahminin değişmez kopyası değildir. Çıkış artışı tüm nakit çıkışlarına uygulanır.
- İş programı gün bazlı bitiş-başlangıç bağımlılığı ve kalan iş yüzdesiyle basit tahmin yapar; vardiya, tatil takvimi veya kaynak dengelemesi içermez. Tamamlanmış işin planlanan bitişi kullanılır; fiilî bitiş tarihi ayrı tutulmaz.
- Belgeler veritabanında base64 içerik olarak saklanır; yedek boyutu buna göre artar. Virüs taraması veya OCR yoktur.
- Operasyon listeleri 100 kayıt/sayfa, birim seçimi ve tutanak 1000 kayıtla sınırlıdır; tutanak kesilirse ekranda belirtilir.
- Şema ve RLS değişiklikleri: 0087_product_expansion.sql ve 0088_product_expansion_rules.sql. Kilitli geçişler değiştirilmedi. Test şeması doğrulandı; müşteri/canlı veritabanına dağıtım yapılmadı.

## Doğrulama ve yeniden çalıştırma

Yerel ortamda Node, PostgreSQL ve bağımlılıklar hazır olmalıdır. API testleri geçici erp_test veritabanını sıfırlayabilir; müşteri veritabanı adresi kullanmayın. Tarayıcı testinden önce API testini çalıştırarak test şemasını hazırlayın. API testiyle tarayıcı testini aynı anda çalıştırmayın.

```sh
npm run typecheck
npm run lint
npm run build
npm test -w @erp/api -- test/workspace.test.ts test/security.test.ts test/migration-lock.test.ts test/module-access.test.ts
npm test -w @erp/shared -- src/operations.test.ts
npx playwright test --config playwright.workspace.config.ts
```

Tarayıcı testleri 3187 API ve 5187 web portlarında yalnızca yerel test sunucusu açar. Gerekirse PW_CHROMIUM_PATH ortam değişkenini kurulu Edge/Chromium yürütülebilir dosyasına ayarlayın. Windows sandbox içinde tsx kullanıcı bilgisi hatası çıkarsa komutun sandbox dışında çalıştırılması gerekebilir.

API/yetki/geçiş kontrolleri: 70 test geçti. Ortak modül testlerinin tamamı: 611 test geçti. Tür kontrolü ve lint geçti; web ve API derlemesi başarılı. Web derlemesi ana paket boyutu (500 kB) ve Tailwind kaynak haritası uyarıları veriyor.

Son tam tarayıcı paketi: 5 test geçti (24 saniye, yerel Edge/Chromium). İlk 5 Ekim ölçümünde 120 saha kaydı, 4 eşzamanlı istemci ve uç başına 32 istekte hata görülmedi. Görev/aramanın/uyarıların/saha listesinin p95 süreleri sırasıyla 21/27/25/22 ms; en büyük saha liste yanıtı 44.816 bayt. Görev ölçümü boş görev listesi üzerindedir. Sonuçlar bu makine ve küçük test verisiyle sınırlıdır.

Tarayıcı paketi görev, arama, belge sürümü/indirme, portal girişi, mobil taslak geri yükleme, iş programı ve nakit senaryosunu kapsar. Ek yerel ölçüm 120 saha kaydıyla dört eşzamanlı istemci, uç başına 32 okuma yapar ve performance.json üretir. Bu kısa ölçüm üretim kapasitesi veya büyük veri performansı garantisi değildir. Süreli yük için scripts/loadtest.ts içindeki workspace-tasks, workspace-search, workspace-alerts ve workspace-site-reports senaryoları kullanılabilir; örnek cari ve hesap planı içeren test verisi gerekir.

## Pilot ve dış bağımlılıklar

1. Muhasebeci: geciken alacağı bul, ödeme sözü kaydet, dekontu iliştir, tahsilat ekranından işlemi tamamla.
2. Şantiye sorumlusu: telefonda günlük rapor gir, bağlantı kesilince taslak sakla, bağlantı gelince gönder.
3. Yönetici: bekleyen işleri incele, sorumlu ata, iş programı ve nakit senaryosunu değerlendir.

Her görevde süre, yanlış işlem, yardım ihtiyacı ve kullanıcı yorumu kaydedilir. Gerçek katılımcı testi yerine otomasyon sonucu yazılmaz. Resmî e-Fatura için kurum/sağlayıcı test erişimi, mükellef yetkilendirmesi ve muhasebe uzmanının doğrulaması sağlandıktan sonra ayrı uçtan uca kabul yapılmalıdır.

## 6 Ekim: tasarım uyumu ve inşaat operasyonları

Bugünkü işlerim, belge arşivi, tahsilat/saha operasyonları, portal yönetimi, dış portal, nakit senaryosu ve teslim tutanağı mevcut tasarım sistemine uyarlandı. Ortak kart, gösterge, rozet, tablo ve sağ panel bileşenleri kullanılıyor; sarı vurgu birincil eylem ve aktif duruma ayrıldı. Açık/koyu tema, 390 px telefon görünümü ve tutanak baskısı tarayıcıda denetlendi.

### Yeni kullanım akışları

- **Bugünkü işlerim:** açık/bugün/gecikmiş/tamamlanan özetleri; başlık/not ve vade filtresi; tam görev düzenleme ve bağlı kaydı kaldırma. Uyarılar ilk beş kayıtla başlar, istenirse genişletilir.
- **Belge arşivi:** erişilebilen tüm kaynakların belgeleri; kaynak adı, dosya adı ve kayıt türüyle kapsam seçimi; son sürüm filtresi; görsel/PDF önizleme. PDF görüntüleme tarayıcı desteğine bağlıdır. Dosya ekleme ve sürüm yükleme panelden yapılır.
- **Tahsilat:** görüşme kanalı/sonucu, aynı cariye ait fatura bağlantısı, açık ödeme sözlerinin para birimine göre özeti. “Ödendi olarak bildirildi” bir görüşme sonucudur; gerçek tahsilat ERP'nin kasa/banka akışında kaydedilir.
- **Operasyonlar:** proje, durum, termin ve başlık filtresi; kapsam genelinde sayaçlar. Sayaçlar arama/durum filtresinden bağımsız, seçilen proje/kayıt kapsamını gösterir.
- **Portal yönetimi:** aktif/süresi dolmuş/kapatılmış erişimler, doğru geçerlilik etiketi, bağlantı kopyalama ve oluşturma paneli.
- **Nakit senaryosu:** haftalık mevcut/senaryo nakit çizgisi, standart göstergeler ve karşılaştırma tablosu.

### İnşaat kontrol merkezi

Menü: İnşaat → İnşaat kontrol merkezi. Proje kapsamını seçip aşağıdaki operasyonları açın. Merkez; mevcut proje bütçesi/maliyet, taşeron hakedişi, satın alma, gayrimenkul, puantaj ve nakit ekranlarına yetki/modül koşullarıyla bağlanır. Saha günlük raporu, iş programı, ekipman, kusur ve tahsilat kayıtları da merkezden erişilebilir.

| Yeni özellik              | Kaydedilen bilgi                                                | Kapanış koşulu                                                         |
| ------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Teknik bilgi talebi (RFI) | Disiplin, çizim/doküman referansı, soru, sorumlu, termin, yanıt | Teknik yanıt girilmiş olmalı                                           |
| Saha talimatı             | Konum, uygulanacak talimat, sorumlu, termin                     | Uygulama açıklaması girilmiş olmalı                                    |
| Kalite kontrolü           | Konum, imalat türü, sonuç, bulgular, düzeltici faaliyet         | Sonuç bekliyor olmamalı; uygunsuzluk varsa giderilme açıklaması olmalı |
| İş güvenliği aksiyonu     | Konum, risk seviyesi, kontrol/ramak kala/olay, gözlem, önlem    | Giderilme açıklaması girilmiş olmalı                                   |

Her yeni kayıt aranabilir, göreve bağlanabilir ve kendine ait dosya/fotoğraf ekleri taşıyabilir. İş güvenliği ve kalite akışları iç operasyon takibidir; resmî mevzuat formları veya imzalı uzman değerlendirmesi yerine geçmez. Gönderilen kayıtlar şirkete ve ilgili etkin modül yetkilerine göre denetlenir; farklı şirkete erişim ve eşzamanlı düzenleme testleri korunur.

Yeni migration: **0089_construction_operations.sql**. 0087/0088 snapshot dosyalarındaki UTF-16 kodlama ve birleşmeden kalan şema zinciri onarıldı; daha önce kilitlenmiş SQL geçişleri değişmedi. Test veritabanı yeni geçişle doğrulandı. Geçiş, 6 Ekim tarihinde localhost/erp_dev yerel geliştirme veritabanına da başarıyla uygulandı. Diğer kurulumlar güncellenirken normal sürüm geçişi/migration adımı gerekir.

### Son doğrulama

- 70 API/yetki/migration testi, 611 ortak modül testi ve 5 tarayıcı testi geçti.
- Tür kontrolü, lint, web/API derlemesi başarılı.
- Tarayıcı kapsamı: görev ve panel, belge/sürüm/indirme, genel arşiv/son sürüm/görsel önizleme, portal, mobil taslak, teknik yanıtla kapatma, tahsilat arama, mobil güvenlik, kontrol merkezi, nakit, teslim baskısı ve koyu mobil tema.
- Gerçek pilot, büyük veri kapasite testi ve resmî entegrasyonlar ayrı kabul çalışmalarıdır.

### Proje 360 — 30 özellik

Planın A–E paketlerinin ilk sürümleri eklendi: altı proje sekmesi, PDF/revizyon ve fotoğraflı sorun bağlantısı, gerekçeli riskler, şifreli çevrimdışı saha, takvim/kritik yol, metraj/üretim/hakediş, ihale/malzeme/değişiklik, CRM/servis/pasaport, gerçek yerel IFC ve OCR, kaynaklı asistan. Her özelliğin kapsamı, kullanım adımları ve işletim sınırları [Proje 360 dokümanında](CONSTRUCTION-360.md).

621 ortak hesap testi, 11 web testi ve 7 gerçek tarayıcı kabul testi geçti. API taramasında 869 test başarılı oldu; demo temizleme adımı düzeltildikten sonra ilgili beş dosyadaki 21 test, son sipariş/asistan değişikliklerinden sonra üç dosyadaki 10 test yeniden geçti. Otuz ortam koşullu test atlandı. Tür kontrolü, lint, lisans kontrolü, web/API ve Linux Docker imajı derlemesi başarılı. Linux imajında root olmayan kullanıcıyla özel depoya yazma, gerçek IFC geometri ve taranmış PDF OCR doğrulandı. 0089–0093 geçişleri localhost/erp_dev üzerinde uygulandı.
