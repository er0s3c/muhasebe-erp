# İnşaat Proje 360 — kullanım ve kabul notları

6 Ekim 2026. Konut geliştirme ve taahhüt projeleri aynı proje, WBS, sözleşme, hakediş, stok ve muhasebe kaynaklarına bağlanır. Menüde **Proje 360** açılır; proje seçildikten sonra **Özet, Planlar, Saha, Program, Ticari, Müşteri** sekmeleri kullanılır. Var olan görev, belge arşivi ve operasyon ekranları korunur.

## 30 özelliğin ilk sürümü

| #   | Özellik                | Kullanım ve sınır                                                                                                                                                                                                                                   |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Proje kokpiti          | Özet: maliyet, bütçe, ilerleme, termin, açık iş ve kaynak bağlantıları. Haftalık karşılaştırma için tarihli özet kaydedilir; geçmiş başlangıç verisi yoksa değişim hesaplanmaz.                                                                     |
| 2   | Risk radarı            | Kritik/geciken işler, RFI, kalite, güvenlik, hazırlık, izin, numune, bakım ve malzeme eksikliği. Neden, sorumlu, işlem ve kaynak gösterilir; kural tabanlıdır.                                                                                      |
| 3   | Maliyet tahmin defteri | Ticari: tarihli kalan maliyet tahmini ve gerekçesi. EAC = gerçekleşen maliyet + kullanıcının kalan maliyet tahmini; taahhüt ayrıca tekrar eklenmez. Onaylı tahmin mühürlenir.                                                                       |
| 4   | Gantt ve kritik yol    | Program: çalışma günleri, tatiller, bağımlılıklar, sıfır günlük kilometre taşı, kritik yol, başlangıç planı ve tarih etkisi. Kaynak dengeleme algoritması yoktur.                                                                                   |
| 5   | Üç haftalık hazırlık   | Program: çizim, malzeme, ekip, onay hazırlığı; engel ve sorumlusu. Programdaki yaklaşan işlere bağlanır.                                                                                                                                            |
| 6   | Çalışma izinleri       | Saha: sıcak iş, yüksekte çalışma, kazı; liste, yetkili onayı, süre ve kapanış. Eksik kontrol veya geçmiş geçerlilikle onay engellenir. İç yönetim kaydıdır.                                                                                         |
| 7   | Çizim/revizyon         | Planlar: özel depoya PDF yükleme, disiplin/revizyon, taslak–onaylı–kullanım dışı. Önceki revizyonla üst üste karşılaştırma; kod başına tek geçerli onaylı çizim.                                                                                    |
| 8   | Plan üzerinde sorun    | Planlar: sayfa ve normalleştirilmiş nokta; mevcut kayıt veya yeni RFI, isteğe bağlı fotoğraf ve ortak konum. Operasyon detayından çizimdeki konuma dönülür.                                                                                         |
| 9   | Dijital metraj         | Planlar: iki noktayla ölçek, uzunluk/alan/adet, WBS ve birim; onaylı ölçüleri gerçek XLSX'e aktarım. Otomatik çizim tanıma yoktur.                                                                                                                  |
| 10  | Üretim → hakediş       | Saha: fotoğraf, konum, WBS ve taşeron pozuna bağlı üretim; kontrol/onay, kısmi hakediş taslağı. Aynı miktar yeniden tahsis edilemez; iptal edilmiş taslağın tahsisi yeniden kullanılabilir. Muhasebe mevcut hakediş akışındadır.                    |
| 11  | Ekip verimliliği       | Saha: onaylı üretim ve proje/WBS puantajı; birim/saat ve plan/gerçekleşen. Puantaj ekip adına ayrışmıyorsa proje kapsamı belirtilir; eksik saat sonucu boş bırakılır.                                                                               |
| 12  | Çevrimdışı saha        | Planlar: seçilen çizim ve proje paketini indir. `/field-offline` ekranında cihaz koduyla aç, RFI/rapor ve fotoğraf kaydet; yeniden açılışta kuyruk korunur, çevrimiçi tek tek eşitlenir. Ayrıntılar aşağıda.                                        |
| 13  | İhale/teklif           | Ticari: fırsat, keşif satırları, fiyat, revizyon ve karar gerekçesi. Kazanan tekliften mevcut proje ve bütçe taslağı; kaybedilen teklifin nedeni geçmişte saklanır.                                                                                 |
| 14  | Birim fiyat analizi    | Ticari: tarih, para birimi, kaynak; malzeme/işçilik/ekipman bileşenleri. Teklifte fiyat görüntüsü saklanır; onaylı analiz sonradan değiştirilmez.                                                                                                   |
| 15  | Malzeme ihtiyaçları    | Ticari: program işi, metraj, dönüşüm katsayısı, ihtiyaç tarihi ve tedarik süresi. Stok/diğer rezervasyon/açık sipariş hesabı, eksik miktardan satın alma talebi taslağı. Onay anındaki hesap saklanır; aktarırken güncel stok tekrar hesaplanır.    |
| 16  | Beton ve numune        | Saha: ortak konum, tedarikçi, parti/teslim belgesi, miktar, numune ve laboratuvar sonucu. Sonuçlar gerekçeli ek geçmiş olarak girilir; numune kimliği/termini/kabul sınırı değişmez. Uygunsuz veya geciken sonuç tek kalite aksiyonuna bağlanır.    |
| 17  | Malzeme onayı          | Saha: marka, revizyon, özel depodaki teknik belge ve sipariş bağlantısı; sunum, ret, düzeltme, onay geçmişi.                                                                                                                                        |
| 18  | Firma performansı      | Ticari: tedarikçinin teslim/termin/kalite, taşeronun birim bazında üretim/kalite ve düzeltme süresi; veri sayısı ve eksik ölçütler. Düzeltme süresi oluşturma–son güncelleme aralığıdır; ölçüm kapsamı gösterilir.                                  |
| 19  | Saha değişikliği       | Ticari: RFI/talimat, maliyet, gelir, gün etkisi ve kanıt; onaydan mevcut değişiklik emri taslağına aktarım. Paralel sözleşme veya doğrudan yevmiye oluşturulmaz.                                                                                    |
| 20  | Süre uzatımı           | Ticari: olay kronolojisi, belgeler, etkilenen program işleri ve istenen süre; dosya/ekran baskısı. Hukuki hak otomatik belirlenmez.                                                                                                                 |
| 21  | Ekipman/bakım          | Program: şirket çapında ekipman rezervasyonu, proje ve tarih; çakışan rezervasyon ve onaylı kullanılamama engeli. Tarih/saat esaslı bakım, parçalar, arıza tarihleri ve kullanılamama süresi.                                                       |
| 22  | Fizibilite             | Müşteri: arsa maliyeti/pay, satılabilir alan, satış/inşaat fiyat varsayımları ve etapların tahsilat/ödeme dağılımı. Kâr ve en yüksek finansman ihtiyacı. Kullanıcı varsayımlarıyla senaryo dosyaları karşılaştırılır.                               |
| 23  | Satış CRM              | Müşteri: aday, görüşme, ziyaret, teklif, süreli rezervasyon ve mevcut sözleşme bağlantısı. Birim kilidiyle çifte rezervasyon engellenir; süre dolumu ve sözleşme iptali geçmişe yazılır. Kaynak/temsilci/dönüşüm tablosu mevcut aşamaları gösterir. |
| 24  | Alıcı seçenekleri      | Müşteri: daire/sözleşme, kategori, seçim, fiyat, son tarih ve kabul. Onaylı kabulden mevcut satın alma talebi ve bağlı saha görevi taslağı.                                                                                                         |
| 25  | Garanti/servis         | Yetkili alıcı portalında teslim edilmiş sözleşmeye fotoğraflı talep. İç ekip garanti/randevu/taşeron/çözüm kaydeder; alıcı portalda teyit verir. Çözüm ve teyit olmadan kapanamaz.                                                                  |
| 26  | Daire pasaportu        | Müşteri: cihaz/seri no, belge, garanti, bakım. QR şirket içi yetkili proje ekranını açar; alıcı kendi sözleşmesinin pasaport belgelerini parola ve süreyle korunan portalından indirir. QR anonim erişim sağlamaz.                                  |
| 27  | Fotoğraf zaman çizgisi | Saha: aynı konumun tarihli fotoğrafları yan yana; üretim/saha kaydı bağlantısı. Equirectangular 360° görsel küre görünümü.                                                                                                                          |
| 28  | IFC görünümü           | Planlar: IFC yükle, kalıcı işlem kuyruğu, gerçek IfcOpenShell geometrisi. Kat/eleman seçimi, GUID–WBS–operasyon bağlantıları, maliyet raporuna geçiş ve tarihe göre program renklendirmesi. Çakışma analizi yoktur.                                 |
| 29  | OCR yardımcı           | Planlar: PDF/JPEG/PNG; PDF metni veya yerel Türkçe/İngilizce OCR. Belge ve öneri yan yana; insan doğrulamasıyla mevcut fatura/irsaliye/saha raporu taslağı. Tekrarlı aktarım ve doğrudan muhasebeleştirme engellenir.                               |
| 30  | Kaynaklı asistan       | Özet: yerel kayıt/belge/OCR metni arama ve kaynaklı yanıt. Sayılar ERP hesaplarından gelir. İsteğe bağlı dış AI yalnızca açık seçim ve yapılandırmayla, erişilebilir kaynaklardan açıklama üretir; işlem yapamaz.                                   |

## İlk gösterim

1. Proje seçin, blok → kat → mahal konumlarını oluşturun.
2. Planlar'da PDF yükleyin; kod, disiplin ve revizyonu girip kullanım için onaylayın.
3. Plan sayfasına nokta koyun; RFI başlığı, soru, termin, konum ve fotoğrafı kaydedin.
4. Özet'te risk nedeninden aynı RFI'yi açın; RFI detayından plandaki işarete dönün.
5. Cihaz koduyla saha paketini indirin. Çevrimdışı ekranı kapatıp yeniden açın, fotoğraflı saha kaydı girin; çevrimiçi olunca eşitleyin.

Sentetik çizim/model/fatura örnekleri: `apps/api/test/fixtures/construction/`. Müşteri veya lisanslı proje verisi içermezler.

## Kurulum ve özel dosyalar

- Normal veritabanı yükseltmesi: `npm run db:migrate`. Yeni geçişler 0089–0093; eski SQL geçişleri değiştirilmedi.
- Web/API: `npm run build`, geliştirme için `npm run dev`.
- Windows yerel OCR/IFC: `powershell -File scripts/construction-runtime.ps1 -Python <Python-3.12-yolu>`. Linux: `bash scripts/construction-runtime.sh` (Python 3.10–3.12 ve venv).
- Betiğin yazdığı `CONSTRUCTION_PYTHON` ve `CONSTRUCTION_TESSDATA_DIR` yollarını `.env` dosyasına ekleyin. Sanal ortam çalışma makinesine özeldir; dağıtıma kopyalamak yerine hedefte oluşturun. Native hizmet kullanıcısına bu yollar için okuma/çalıştırma erişimi verin.
- `CONSTRUCTION_STORAGE_DIR` API'nin yazabildiği **özel**, kalıcı dosya deposudur. Web köküne koymayın. İçerik SHA-256 ile saklanır; metadata PostgreSQL'dedir. Yükleme sınırı 25 MB; çevrimdışı/portal fotoğrafı 5 MB. İlk sürüm büyük IFC/PDF dosyalarını bölerek yüklemeyi gerektirebilir.
- Docker imajları Python işleyicisini ve hash ile doğrulanan OCR dillerini içerir. Compose deposu `CONSTRUCTION_FILES_DIR` ile bağlanır; Linux kurucusu klasörü imajın UID 1000 kullanıcısına verir.
- İş kuyruğu PostgreSQL'de kalıcıdır. Eksik çalışma zamanı/hatalı dosya anlaşılır hata verir; kullanıcı yeniden deneyebilir. Kesilmiş iş, süreli kiralama bittikten sonra yeniden alınır. İlk sürüm tek API işleyicisiyle sınanmıştır; büyük model/yük testi ayrı çalışmadır.
- `CONSTRUCTION_AI_URL`, `CONSTRUCTION_AI_KEY`, `CONSTRUCTION_AI_MODEL` varsayılan olarak boş. Yerel asistan, OCR ve IFC dış AI gerektirmez. Dil dosyaları ve Python paketleri kurulum sırasında indirilir; kullanımda yerel işlenir.
- Node lisans kontrolüne ek olarak dağıtımda Python paketlerinin lisans bildirimleri korunmalıdır: IfcOpenShell LGPL-3.0-or-later, pypdfium2 Apache-2.0/BSD-3-Clause, Pillow HPND; paketlerin transitif bağımlılıklarının bildirimleri de sanal ortamda bulunur.

## Çevrimdışı erişim

Service Worker uygulama kabuğunu ve statik dosyaları önbelleğe alır; API cevaplarını önbelleklemez. Seçilen projenin tek çizim PDF'i, konumları, işaretleri ve bekleyen rapor/RFI/fotoğrafı IndexedDB'de cihaz koduyla AES-GCM şifrelenir. PDF içindeki sayfalar seçilebilir. Paket 24 saat geçerlidir; yeniden indirme aynı kullanıcı/şirket kapsamındaki bekleyen kuyruğu korur.

Çıkış ve şirket değişimi yerel paketi temizler. Bağlantı yokken oturum yenilemenin başarısız olması bekleyen şifreli kaydı silmez. Çevrimiçi eşitleme aynı kullanıcı/şirketi ve güncel sunucu yetkisini gerektirir; 401/403 paket erişimini temizler. Revizyon/sürüm çakışmaları kuyrukta açıklamayla kalır. Yeniden gönderim kimlikleri kayıt/fotoğraf/işaret çoğalmasını önler. Mali kayıt ve onaylar çevrimdışı değildir.

Çevrimdışı cihaz anlık yetki iptalini sunucudan öğrenemez: erişim cihaz kodu ve 24 saatlik süreyle sınırlıdır. Hassas bir saha cihazında çıkmadan veya şirket değiştirmeden önce bekleyenlerin eşitlenmesi gerekir.

## Yedek ve geri yükleme

Veritabanı yedeğinin yanında `.dump.files.gz` ve SHA-256 dosyası tutulur. Yedek/geri yükleme betikleri çizim, fotoğraf, IFC ve OCR iş çıktısını da kapsar. Geçici işlem klasörleri dahil edilmez. Dosya arşivi açılmadan tüm hash'ler doğrulanır; farklı içerikli mevcut dosya ezilmez ve yol dışına yazılamaz. Eski yalnızca DB içeren yedek için dosya deposunun ayrıca bulunması gerektiği gösterilir.

Docker kurucusu başka kit klasörüne geçerken mevcut özel deponun mutlak yolunu yeni ayara yazar; dosyalar yerinde kalır ve yeni kurulum/yedekler aynı depoyu kullanır. Kurucu depo yolunu açıkça bildirir: eski kit klasörünü temizlerken bu depoyu silmeyin. Şirket/metadata kaydı olan dosyalar olmadan yalnızca veritabanı geri yüklemek yeterli değildir.

## Kabul kapsamı

Yerel sonuçlar: 621 ortak hesap, 11 web ve 7 tarayıcı testi başarılı. API taramasında 869 test geçti; test veritabanı temizliği ve son değişen dosyalar ayrıca başarıyla yeniden koşuldu (30 ortam koşullu test atlandı). Tür kontrolü, lint, lisans kontrolü, web/API derlemesi ve Linux Docker imajı derlemesi başarılı. Linux imajında root olmayan kullanıcıyla özel depoya yazma, gerçek IFC ve taranmış PDF OCR çalıştırıldı. 0089–0093 geçişleri localhost/erp_dev üzerinde uygulandı.

Otomatik kontroller: tenant/yetki, migration kilidi ve audit; çizim revizyonu, fotoğraf/işaret yeniden gönderimi; tipli süreçler, onay ve mühürleme, ekipman çakışması, numune kalite aksiyonu, gerçek hakediş/satın alma/değişiklik taslakları, CRM/portal/servis; gerçek iki elemanlı IFC, görüntü ve taranmış PDF OCR; dosya yedeği/tekrar geri yükleme/bozulma/yol güvenliği. Ortak hesap ve mevcut ERP regresyon testleri ayrıca çalıştırılır.

Gerçek tarayıcı kabulü üretim web derlemesinde: PDF yükleme/onay, fotoğraflı RFI, kaynaktan risk, altı sekme 390 px taşma kontrolü, açık/koyu görünüm; bağlantıyı kesip sekmeyi kapatma/açma, kuyruk ve çizimin korunması, tek eşitleme ve şirket değişiminde paket temizleme. Mevcut görev/arşiv/portal/tahsilat ekranlarının tarayıcı regresyonları da korunur.

Tekrar çalıştırma (testler kendi `erp_test` şemasını sıfırlar; test veritabanı üretimden ayrı olmalıdır):

```sh
npm run typecheck
npm run lint
npm run licenses
npm test -w @erp/shared
npm test -w @erp/web
npm test -w @erp/api
npm run build
# API testleri bittikten sonra; aynı anda çalıştırmayın.
# Windows PowerShell: $env:E2E_CONSTRUCTION_PRODUCTION='1'
npx playwright test --config playwright.workspace.config.ts
```

Gerçek firma pilotu, resmî e-Fatura test erişimi, dış AI bağlantısı, native hizmetin temiz makine kurulumu, Docker üretim dağıtımı ve büyük IFC/çok kullanıcı yük kabulü bu yerel çalışmada doğrulanmış sayılmaz. Çalışma izni, fizibilite ve süre uzatımı iç yönetim araçlarıdır. Evrensel tarayıcı/cihaz uyumu veya hukuki/mevzuat karar otomasyonu iddiası yoktur.
