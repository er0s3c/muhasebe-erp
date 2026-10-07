# Ada Muhasebe

İnşaat projeleri için [Proje 360 kullanım, 30 özellik ve kurulum notları](docs/CONSTRUCTION-360.md).

Üretim, toptan ticaret ve deri için [ortak üretim motoru, demo şirketi ve görev kullanıcıları](docs/MANUFACTURING-WHOLESALE.md). Mevcut demo hesabına ayrı şirket eklemek için `npm run demo:manufacturing`; mevcut inşaat verilerini sıfırlamak gerekmez.

KKTC işletmeleri için sade ve güçlü, web tabanlı muhasebe/ERP. İlk hedef sektör inşaat ve taahhüt; market ve ticaret modülleri aynı çekirdeğin üstüne eklenecek şekilde tasarlandı.

**Durum:** Çekirdek ERP, inşaat/taşeron/gayrimenkul akışları, lisanslama ve dağıtım araçları mevcut. Görev, belge arşivi, mobil saha, iş programı, ekipman, teslim/kusur, dış portal ve nakit senaryosu ekranları eklendi; yerel test kapsamı ve sınırlar [geliştirme programında](docs/PRODUCT-EXPANSION.md). Gerçek kullanıcı pilotu ve resmî e-Fatura doğrulaması dış erişimleri bekliyor. Muhasebe/mevzuat varsayımları uzman teyidi gerektirir. Genel yol haritası: [docs/ROADMAP.md](docs/ROADMAP.md).

## Neler var?

- **Çalışma alanı:** görev ve uyarı takibi, kayda bağlı sürümlü PDF/görsel arşivi, genel kayıt araması, kurulum rehberi, tahsilat sözü, mobil saha taslağı, bağımlı iş programı, ekipman kayıtları, teslim/kusur tutanağı, süreli müşteri/taşeron portalı ve nakit senaryoları. [Kullanım, testler ve sınırlar](docs/PRODUCT-EXPANSION.md).

- **Çok şirketli, yalıtılmış veri:** her satır bir şirkete aittir; PostgreSQL satır düzeyi güvenlik (RLS) uygulama hatası olsa bile başka şirketin verisini göstermez.
- **Değiştirilemez defter:** kaydedilen yevmiye değiştirilemez ve silinemez; düzeltme ters kayıtla yapılır. Borç=alacak, dönem kilidi ve hesap kuralları veritabanında da denetlenir.
- **Çoklu para birimi:** ₺, £, €, $ (TRY, GBP, EUR, USD). Dövizli satırlar işlem tarihindeki kurdan çevrilir; yönetim raporlaması için ikinci bir para birimi tutulabilir. Tutarlar simgeyle (`₺1.234,56`) gösterilir, Excel çıktısında hücre biçimi simgelidir.
- **Cari hesaplar:** müşteri/tedarikçi kartı, ekstre, vadeye göre yaşlandırma, açık kalemler; cari kontrol hesabına (120/320) cari olmadan kayıt atılamaz.
- **Stok:** stok kartı, çoklu depo, giriş/çıkış/fire/transfer/devir, sayım, hareketli ağırlıklı ortalama maliyet, kritik seviye uyarısı, tarih anı stok değeri. Alış maliyeti EUR/GBP/TL girilebilir, hareket günü kuruyla çevrilir. Stok defteri değiştirilemez (düzeltme ters belgeyle); negatif stok şirket ayarıyla açılır.
- **Fatura:** satış, alış, gider, satış iadesi, alış iadesi. Kayıt; stok hareketini, cari alacak/borcu ve yevmiyeyi **tek işlemde** yazar; numara boşluksuzdur, kaydedilmiş fatura değiştirilemez (iptal = ters kayıt). KDV hariç/dahil fiyat, iskonto, dövizli fatura, orijinale bağlı iade, KDV özeti. **Hesap eşlemesi** ile elle girilen stok belgeleri de otomatik yevmiye üretir; stok değeri ile 150–157 hesapları baştan mutabıktır. Varsayılan hesaplar ve KDV oranları mali müşavirce doğrulanmamıştır.
- **İrsaliye:** satış (sevk) ve alış (mal kabul) irsaliyesi stoğu hemen hareket ettirir, yevmiyeyi fatura kesilince yazar. Fatura irsaliyeye bağlanır (kısmi/çoklu faturalama, stok tekrar hareket etmez); alışta fiyat farkı elde kalan miktar payı stoğa, satılan payı satılan mal maliyetine gider. Faturalanmamış irsaliyeler stok mutabakatında açıklanan fark olarak görünür. Yasal irsaliye biçimi doğrulanmamıştır.
- **Kasa ve banka:** kasa/banka hesapları (her biri bir muhasebe hesabına bağlı, çoklu para birimi), tahsilat ve ödeme (cari açık kalemleriyle elle eşleştirilir: kısmi, çoklu kalem, farklı para birimi, avans), **gerçekleşen kur farkı otomatik yazılır**, virman, döviz alım-satım (ortalama maliyetle), banka masrafı/faiz, iptal (ters kayıt), kasa eksi bakiye denetimi. Kur değerlemesi ve avans mahsubu sonraki adımdır; kambiyo hesapları ve kasa kuralı doğrulanmamıştır.
- **Raporlar ve dışa aktarma:** yevmiye defteri, kebir, satış/alış raporu, stok kârlılığı, kambiyo raporu; tüm raporlar **Excel (.xlsx), CSV ve yazdır/PDF** olarak alınabilir, tam veri dışa aktarma tek Excel dosyasıdır. Excel çıktıları renkli başlıklı, bantlı ve yazdırmaya hazırdır; PDF, tarayıcının yazdır penceresinden “PDF olarak kaydet”tir ve tüm sayfalar kurumsal antet, koyu başlıklı tablolar, sayfa numarası ve (belgelerde) imza blokları ile basılır; yevmiye defteri/kebir çıktıları yasal onaylı defter yerine geçmez.
- **İçe aktarma:** cari ve stok kartları ile cari/stok/mizan açılış bakiyeleri Excel ya da CSV dosyasından aktarılır (sütun eşleme, satır satır ön izleme, hata varsa hiçbir kayıt yazılmaz). Açılış kaydının karşı hesabı ve mizan açılışı akışı mali müşavirce doğrulanmamıştır.
- **Banka mutabakatı:** banka ekstresi (Excel/CSV) içe aktarılır ve defter kayıtlarıyla eşleştirilir (tutar birebir, ±3 gün; kesin/olası öneri, elle ve otomatik); eşleşmeyen ekstre satırından tek tıkla hareket oluşturulur; ekstre kapanış bakiyesi ile defter bakiyesi farkı ekranda açıklanır. Eşleşmiş hareket/fiş iptal edilemez. Bankaya özgü ekstre biçimleri doğrulanmamıştır.
- **Şantiye projeleri (inşaat):** kendi projeniz ya da işverene yapılan iş için proje kartı, iş kırılımı ağacı (WBS), **revizyonlu değişmez bütçe** ve tarihli ilerleme. Gerçekleşen maliyet ayrı girilmez: yevmiye, alış/gider faturası kalemi, stoktan sarf ve kasa/banka ödemesi satırında proje + iş kalemi seçilir, maliyet defterden türer (mizanla aynı kaynak). Tamamlanma %, tahmini toplam maliyet (EAC), sapma ve maliyet performansı (CPI), projeye dağıtılmamış maliyet ve defter mutabakatı, Excel/CSV/baskı. Hesap sınıflandırması (60/61/64 = gelir) mali müşavirce doğrulanmamıştır; gayrimenkul/taksit ve fonlar sonraki aşamalardadır.
- **Satın alma zinciri (B2p):** şantiye **satın alma talebi** (tutar kademeli onay kuralları), onaylı talepten **RFQ** ve **teklif karşılaştırma** (kurla defter para birimi, en ucuz/en hızlı, teslim ve vade yan yana), teklifi seçince **sipariş** taslağı; verilen sipariş kalan miktarıyla proje maliyet raporunda **taahhüt** olur (EAC'ye girmez), **mal kabul** kısmi teslimi alış irsaliyesiyle stoğa girer.
- **Fonlar, kârlılık ve nakit (B4):** tarihli, doğrulama alanlı **altyapı fonu/harç tarifeleri** (alıcıdan tahsil edilen fon satış sözleşmesine eklenir, projenin ödediği fon tahmin edilir); **proje kârlılığı** (sözleşmeli gelir − tahmini maliyet, defter ve GBP raporlama); **13 haftalık nakit projeksiyonu** (açık alacak/borç vadeleri + elle kalemler).
- **Gayrimenkul satışı (B3):** kendi projesinde **birim envanteri** (toplu üretim, kat planı), alıcıyla **satış sözleşmesi** ve dövizli (GBP vb.) **taksit planı**; taksitler alıcı carisinde vadeli kalem olur, tahsilat mevcut kasa/banka akışıyla taksidi kapatır (kur farkı dahil), **gelir teslimde** tanınır (ertelenmiş gelir → proje geliri), teslim öncesi **fesih + kesinti + iade**, geciken taksit listesi ve proje satış özeti, yazdırılabilir sözleşme/ödeme planı.
- **İnsan kaynakları (D1):** personel kartı; kimlik no, doğum tarihi ve IBAN şifreli saklanır, maskeli gösterilir, yalnızca gerekçeyle açılır (erişim günlüğü); **Veri koruma** sayfasında kişisel veri envanteri (dayanaklar "doğrulanmadı"), ilgili kişi talepleri ve kişi verisi dışa aktarma.
- **Puantaj (D2):** günlük devam/izin/mesai (çalıştı, devamsız, yıllık/hastalık/ücretsiz izin, resmî tatil, hafta tatili + normal/fazla mesai saati), saatlere isteğe bağlı **proje + iş kalemi + maliyet kodu** etiketi; **aylık çizelge** (personel × gün, fırçayla boyama) ve **günlük giriş**; **aylık kapanış** (kapalı ayda ekleme/değiştirme/silme veritabanında reddedilir, yeniden açma gerekçeli ve denetimli), **aylık özet** ve proje/iş kalemi başına **işçilik saatleri** (bordro D3'ün girdisi), Excel çıktıları. Yasal çalışma süresi, fazla mesai ve izin değerleri kodda yoktur (doğrulanmadı); gün türünü ve tatilleri kullanıcı girer.
- **Bordro (D3):** `hr.payroll` modülü; aylık bordro puantajdan (normal/fazla mesai saati, izin/devamsızlık günleri), personel ücret şartından (aylık/günlük/saatlik, tarihli) ve elle ek ödeme/kesinti kalemlerinden **brüt → kesinti → net** ve işveren yükünü hesaplar; **onayda** proje + iş kalemi + maliyet koduna etiketli (puantaj saatine göre) yevmiye yazılır (ödenecek net, sosyal güvenlik, vergi, diğer kesinti), ödeme takibi ve gerekçeli iptal (yevmiye ters kaydı) vardır. **Hiçbir yasal oran kodda yok:** prim, vergi, asgari ücret, fazla mesai çarpanı ve bölenler yalnızca **tarihli, kaynak notlu, doğrulama alanlı ve varsayılan KAPALI** `payroll_params` satırlarıdır; parametre yokken motor yalnızca yazdığınızı işler ve doğrulanmamış parametreyle hesaplanan her bordro/pusula/dışa aktarma ⚠ **"oranlar doğrulanmadı"** taşır. **Bordro iç belgedir, resmî bordro değildir** (pusula yazdırılabilir). Puantaj ay kilidiyle bağlıdır: açık ayda onay yok, onaylı bordro varken ay yeniden açılamaz. Ücret verisi `hr.payroll` iznine bağlı, okunması erişim günlüğüne yazılır, IBAN maskelidir; proje bazında bordro maliyeti raporu ve Excel/CSV dışa aktarma.
- **Sosyal güvenlik çıktıları (D4):** `hr.socialsecurity` modülü (bordroya bağlı); tarihli personel profili (bordro tipi kodu **serbest veri**, sigorta başlangıç/bitiş, **şifreli + maskeli sosyal güvenlik numarası**: açık okuma gerekçe + `hr.sensitive` + erişim günlüğü), **tarihli, kaynak notlu, doğrulama alanlı, varsayılan KAPALI prim desteği kuralları** ve personel uygunluk beyanı (kodda yasal değer yok); **onaylı/ödenmiş bordrodan aylık bildirim** (personel başına gün sayıları, prime esas kazanç, bordrodaki işçi/işveren primi, kural açık + uygunluk varsa destek; taslak → kesinleşmiş, kesinleşmiş bildirim bordro iptalini ve puantaj ayı açmayı engeller), xlsx/csv/yazdır çıktısı ve aya/projeye göre prim özeti. **Çıktı GENEL düzendir: "resmî bildirim formatı değildir, doğrulanmadı"**; sütun kümesi sabittir.
- **Yabancı işçi belge ve teminat takibi (D5):** `hr.foreign` modülü (personel modülüne bağlı); kullanıcı yönetimli belge türleri (yalnızca genel adlar), **şifreli + maskeli belge numarası** (açık okuma gerekçeli, `hr.sensitive`, erişim günlüğü), son kullanma durumu (geçerli/dolmak üzere/süresi dolmuş/iptal; uyarı günü tarihli **doğrulanmamış** kullanıcı parametresi), salt-eklenir yenileme geçmişi, teminat kaydı (tutar yalnızca tarihli, varsayılan kapalı kullanıcı parametresinden; kodda yasal tutar yok), tutulan teminat raporu, xlsx/csv dışa aktarma. Ek belgeler özel dosya deposunda ve ayrı hassas veri yetkisiyle yüklenebilir; muhasebe bağlantısı yok; süre uyarısı bildirim olarak gelir (N1).
- **Çek/senet portföyü ve takas, banka teminat mektubu (X1):** `treasury.cheques` ve `treasury.guarantees` modülleri (kasa/bankaya bağlı); alınan ve verilen çek/senet, veritabanında korunan durum geçişleri (portföy → tahsilde → tahsil/karşılıksız, ciro, iade; verilen: ödeme/karşılıksız/iptal) ve salt-eklenir geçmiş, her değişiklikte yevmiye (cari kalemi kapatır, karşılıksız/iade alacağı yeniden açar), **toplu takas** (tek yevmiye, tek banka satırı), vade analizi, vadesi gelenler, karşılıksız listesi, nakit projeksiyonu bağlantısı; banka teminat mektubu nazım takibi (proje/sözleşme bağlantısı, kullanıcı girişli komisyon, **kullanıcı ayarlı** süre uyarısı), xlsx/csv dışa aktarma. Hesap eşlemeleri, komisyon ve yasal geçerlilik **doğrulanmadı**; dövizli çek/senet, tarihli kayıt kuru ve tahsil/ödemede kur farkı desteklenir.
- **Taşeron sözleşmesi ve hakediş (B2):** taşeron sözleşmesi, **revizyonlu BOQ**, **kümülatif hakediş** (teminat, avans mahsubu, stopaj, diğer kesinti, KDV), tutar kademeli **onay kuralları**, onaylanınca aynı işlemde proje + iş kalemi + **maliyet kodu** etiketli yevmiye (320 cari açık kalemi, mevcut ödeme akışıyla kapanır), avans ve teminat iadesi, **değişiklik emri** (ek/eksilen iş, fiyat, süre uzatımı; onay ve işveren sözleşmesinde işveren kabulü; bekleyen emirler raporlarda ayrı), **KDV tevkifatı** (iki yön, parametreli, varsayılan kapalı) ve **malzeme mahsubu** (taşerona verilen malzeme hakedişte bakiyeli mahsup edilir), proje maliyet raporunda **kalan taahhüt** (BOQ − hakediş; EAC'ye girmez) ve maliyet koduna göre kırılım. Teminat/stopaj/avans yüzdeleri tarihli, kaynak notlu ve "doğrulanmamış" rozetli veridir; hiçbiri kodda sabit değildir.
- **Kur:** elle giriş ya da KKTC Merkez Bankası XML'inden içe aktarma (resmî adres veya dosya yükleme); günlük otomatik indirme ve gerekçeli hata/yeniden deneme geçmişi.
- **Kurumsal işletim:** ayarlanabilir dosya sınırı, şirket MFA zorunluluğu, özel dosyalarla tam kurulum yedeği ve ayrı hedefte kurtarma; kullanıcı/süre/olay raporu, kaydedilmiş grafik panosu, kampanya, tekrar planı, personel masraf mahsubu, demirbaş/amortisman ve revizyonlu şirket/departman bütçesi. Kurulum gereksinimleri ve kalan kapsam: [kurumsal geliştirme kaydı](docs/ENTERPRISE-EXPANSION.md).
- **Modül yönetimi ve hesap güvenliği:** kullanılmayan modüller Ayarlar > Modüller'den bağımlılık korumalı kapatılır; parola sıfırlama ve e-posta doğrulama (SMTP ile), geçici parola zorunlu değişimi, parola politikası, güvenlik olayı kaydı.
- **Lisanslama:** yazılım müşterinin kendi sunucusunda çalışır; satıcı kendi VPS'indeki **lisans sunucusundan** (web paneli + komut satırı; parola ve zorunlu TOTP) istediği zaman lisans verir. Lisans sektörü (market / inşaat / ticaret), **cihaz kotasını** (cihaz = kayıtlı tarayıcı/bilgisayar; cihaz başına ücret), şirket sınırını ve bitişi belirler. Ed25519 imzalı kısa ömürlü kira; sahte lisans, veritabanında lisans düzenleme, sunucu klonlama, saat geri alma ve ağ kesme denemeleri engellenir ya da saptanır; süre bitince/doğrulanamayınca **salt-okunur mod** (veri görüntülenir ve dışa aktarılır). Muhasebe verisi lisans sunucusuna gitmez. Dürüst sınır: müşteri sunucuyu kontrol ettiği için %100 kırılamaz değildir ([lisans-server/docs/LICENSING.md](lisans-server/docs/LICENSING.md)); sözleşme/EULA avukata yazdırılmalıdır.
- **Rol bazlı yetki, sektöre göre menü, denetim izi, Türkçe arayüz** (çoklu dil altyapılı), açık/koyu tema, `Ctrl+K` komut paleti.

## Hızlı başlangıç

**Tek komutla (önerilen):** kurulum sihirbazı önce sistemi denetler (işletim sistemi, bellek, disk, portlar, Docker, Node, PostgreSQL), uygun yolu önerir, **düz Türkçe sorularla tüm yapılandırmayı alır** (demo mu boş mu, lisans, e-posta/SMTP + test e-postası, alan adı ve HTTPS sertifikası, yedekleme, portlar), eksik paketleri kurar ve sistemi ayağa kaldırır. Hiçbir ayar dosyasını elle düzenlemeniz gerekmez.

```bash
./install.sh                 # Linux / WSL (Ubuntu 22.04+, Debian 12+)
./install.sh --check         # yalnızca uyumluluk raporu
./install.sh --dry-run       # sistemi değiştirmeden ne yazılacağını gösterir
./install.sh --answers=../musteri.answers   # sürüm kitinin içinden, sormadan (installer/answers.example'dan kopyalayın; parola/kod varsa sonra silin)
./install.sh --reconfigure   # kurulu sistemde yalnızca ayarları (e-posta, HTTPS, yedek, lisans adresi) yeniden sorar
```

Yanıt dosyası müşteri kurulumu içindir: sürüm kitini açıp kitin klasöründe çalıştırın (depoda `INSTALL_PATH=native` kit olmadan çalışmaz); kurulu sistemde yalnızca `--reconfigure` ile okunur. Kaldırma: `./install.sh --uninstall` (veri korunur; `--purge` kalıcı siler ve `SIL` onayı ister), önce `--dry-run` ile bakın. Müşteri (kit) kurulumunda varsayılan **boş uygulamadır** (demo verisi yok) ve uygulama **lisans etkinleştirilmeden çalışmaz**; demo yalnızca sorulduğunda ve ilk kurulumda yüklenir. Windows'ta aynı bayraklar `-DryRun`, `-AnswersFile`, `-Reconfigure` adlarıyladır.

Windows'ta depo klasöründeki **`Kur.cmd`** dosyasına çift tıklayın (Windows PowerShell 5.1 yeterlidir; Docker gerekmez). Depodan çalıştırınca geliştirme/test kurulumu yapılır: Node 22 ve PostgreSQL 16 yoksa kurulur (ya da veritabanı Docker'da çalışır), `.env`, şema ve demo verisi hazırlanır; sonra `npm run dev`. Seçenekler: `./install.sh --help`, ayrıntı [docs/OPERATIONS.md §2](docs/OPERATIONS.md).

**Elle:** gereksinimler Node.js 22.9+, PostgreSQL 16 (ya da Docker). PostgreSQL'in ICU desteği gerekir (Türkçe sıralama için `tr-TR-x-icu`); resmî Docker imajı ve yaygın paketlerde vardır.

```bash
npm install
cp .env.example .env

# 1) Veritabanı: Docker ile
docker compose up -d db
#    ...ya da yerel PostgreSQL ile (roller ve veritabanları):
#    su postgres -c "psql -f infra/postgres/init.sql"

# 2) Şema
npm run db:migrate

# 3) (İsteğe bağlı) demo verisi: örnek inşaat şirketi, cariler, stok, kurlar, bir yıllık yevmiye; satış (fiyat listesi, teklif/sipariş),
#    İK (bordro, avans, sosyal güvenlik, yabancı işçi), çek/senet, teminat, gider, rehber/ajanda, ithalat dosyası, onay kuralları
npm run db:seed        # giriş: demo@ornek.local / Demo-Sifre-123
#    (sıfırdan: npm run demo:reset -- --confirm=erp_dev  → şemayı siler, migration + demo verisi)

# 4) Çalıştır: API http://localhost:3000, web http://localhost:5173
npm run dev
```

## Komutlar

| Komut                                                   | Ne yapar                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `npm run dev`                                           | API ve web'i birlikte başlatır                                                                                           |
| `npm test`                                              | Birim + entegrasyon testleri (gerçek PostgreSQL, RLS dahil)                                                              |
| `npm run e2e`                                           | Playwright uçtan uca testleri (`PW_CHROMIUM_PATH` ile hazır Chromium gösterilebilir)                                     |
| `npm run lint` / `npm run typecheck`                    | Kod kalitesi                                                                                                             |
| `npm run db:generate`                                   | Drizzle şemasından yeni migration üretir                                                                                 |
| `npm run db:seed`                                       | Demo verisi yükler (demo kullanıcı varsa dokunmaz; üretimde yalnızca `ALLOW_DEMO=true`)                                  |
| `npm run demo:reset -- --confirm=<veritabanı>`          | Veritabanını **siler**, migration'ları uygular, demo verisini yükler                                                     |
| `npm run admin -- reset-password --email=…`             | Operatör parola kurtarma (geçici parola üretir)                                                                          |
| `npm run release -- --version=X`                        | Müşteri sürüm kitleri (`release/X/`: linux-x64, win-x64; `--targets=` ile seçilir)                                       |
| `npm run build`                                         | Web + API üretim paketi (`apps/api/dist`, `apps/web/dist`)                                                               |
| `npm run licenses:notices`                              | `THIRD-PARTY-NOTICES.md` üretir                                                                                          |
| `npm run build:license`                                 | Lisans sunucusunu ve yönetim panelini derler                                                                             |
| `node lisans-server/server/dist/cli.js …`                | Satıcı CLI: `keygen`, `admin:create`, `license:issue\|list\|extend\|suspend\|revoke` ([LICENSING.md](lisans-server/docs/LICENSING.md)) |
| `npm run admin -- devices`                              | Operatör: kayıtlı cihazları (lisans koltukları) listeler; `devices:revoke`, `devices:revoke-all --yes`                   |
| `scripts/backup.sh` / `restore.sh` / `restore-drill.sh` | Yedek, geri yükleme, geri yükleme tatbikatı ([işletim kılavuzu](docs/OPERATIONS.md))                                     |
| `npm run load:gen` / `load:test`                        | Yük verisi üretir / yük ölçer ([PERFORMANCE.md](docs/PERFORMANCE.md))                                                    |
| `npm run tour`                                          | Demo verisiyle tüm ekranların ekran görüntüsünü alır, mobilde yatay taşmayı denetler                                     |
| `npm run licenses`                                      | Bağımlılık lisanslarını denetler                                                                                         |

## Dağıtım ve yedekleme

**Müşteri kurulumu (kaynaksız):** `npm run release -- --version=1.0.0` her platform için tek arşivli bir sürüm kiti üretir (`muhasebe-erp-1.0.0-linux-x64.tar.gz`, `muhasebe-erp-1.0.0-win-x64.zip`): derlenmiş uygulama, gömülü Node.js çalışma zamanı ve kurulum sihirbazı. Müşteri kiti açıp `./install.sh` (Linux/WSL) ya da `Kur.cmd` (Windows) çalıştırır; sihirbaz Docker varsa Docker yolunu, yoksa **Docker'sız yerel kurulumu** (PostgreSQL 16 + systemd/Windows hizmeti, günlük yedek) önerir. Ayrıntı: [docs/OPERATIONS.md §2](docs/OPERATIONS.md).

Docker ile elle kurulumda tek artefakt bir **Docker imajıdır** (derlenmiş API + web arayüzü, aynı kökenden). `deploy/docker-compose.prod.yml` PostgreSQL 16, tek seferlik migration ve uygulamayı (isteğe bağlı Caddy ile otomatik HTTPS) ayağa kaldırır; uygulama yalnızca RLS'e tabi çalışma zamanı rolünü bilir.

```bash
cp deploy/.env.production.example deploy/.env      # parolaları ve JWT_SECRET'ı doldurun
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build
scripts/backup.sh --compose                         # yedek (tüm veri; şifreleyip ofis dışında saklayın)
scripts/restore-drill.sh                            # yedeğin geri yüklenebildiğini kanıtlayan tatbikat
```

Müşteriye kurmadan/barındırmadan önce **[docs/OPERATIONS.md](docs/OPERATIONS.md)** (ortam değişkenleri, TLS, yükseltme, geri yükleme, izleme, destek sorguları, kurulum kontrol listesi) ve hukuki notları okuyun. Satış gösterimi için ayrı bir demo örneği vardır (`deploy/docker-compose.demo.yml`); demo verisi asla müşteri sunucusuna kurulmaz.

## Yapı

```
apps/api        Fastify API, Drizzle şeması ve SQL migration'ları (RLS, tetikleyiciler)
apps/web        React + Vite + Tailwind arayüzü
lisans-server/server  Satıcının lisans sunucusu (etkinleştirme, kalp atışı, yönetim API'si, CLI; kendi PostgreSQL'i)
lisans-server/panel   Satıcı yönetim paneli (lisans sunucusundan sunulur)
lisans-server/core  Lisans belirteci/kira/parmak izi/TOTP (Ed25519, yalnızca Node crypto)
packages/shared Para hesabı, izinler, modül/sektör kaydı, doğrulama şemaları
docs/           Mimari, kapsam, hukuki notlar, yol haritası, işletim kılavuzu
deploy/         Docker Compose (üretim, demo), Caddyfile, ortam şablonu
scripts/        Yedek/geri yükleme/tatbikat betikleri, yük ölçümü, arayüz turu, lisans bildirimi
infra/          PostgreSQL rol ve veritabanı kurulum dosyaları
e2e/            Playwright senaryoları
```

## Belgeler

- [Mimari](docs/ARCHITECTURE.md)
- [İşletim kılavuzu](docs/OPERATIONS.md) — kurulum, yedekleme/geri yükleme, yükseltme, izleme
- [Lisanslama kılavuzu](lisans-server/docs/LICENSING.md) — satıcı kurulumu, lisans verme, müşteri kılavuzu, güvenlik modeli ve dürüst sınırlar
- [Docker ve Cloudflare Tunnel kurulumu](lisans-server/docs/DOCKER-TUNNEL-KURULUM.md) — `admin.er0s3c.com`, Docker içinde Tunnel, kaynak kodsuz VPS paketi
- [Performans ölçümleri](docs/PERFORMANCE.md)
- [Tasarım sistemi](docs/DESIGN.md)
- [Kapsam ve işlev kontrol listesi](docs/SCOPE.md)
- [Hukuki notlar ve doğrulanması gerekenler](docs/LEGAL-NOTES.md) — ticari kullanımdan önce mutlaka okuyun
- [Yol haritası](docs/ROADMAP.md)

## Önemli uyarı

Hesap planı şablonu, KDV oranları ve diğer yasal parametreler **resmî kaynaktan doğrulanmamıştır**. Uygulama bunları sabit kodlamaz; tarihli ve kaynaklı veri olarak, mali müşavir/avukat onayıyla girilir. 1 Ekim 2026 mevzuat incelemesinde bazı maddeler güncellendi: e-Fatura API'si için kaynak bulundu, KDV oran kümesi %0/5/10/16/20 oldu, yabancı taşınmaz için eski kota modeli yerine 89/2026 YGK esas alındı, D3 bordro eklendi. Bazı maddeler de çıkarıldı (KIB-TEK katkı payı, “15:30” kur saati). Ayrıntı: [docs/LEGAL-NOTES.md](docs/LEGAL-NOTES.md) §3.

- **İade irsaliyesi, satış teklif/sipariş, toplu faturalama, Excel fatura içe aktarma (X2):** satış/alış iade irsaliyesi (orijinale bağlı miktar sınırı, stok orijinal maliyetle, iade faturasına bağlanır); `invoices.orders` modülüyle teklif → sipariş → teslim/fatura (karşılanma türetilir, yevmiye yok); toplu faturalama (cari başına, kısmi hata raporlu, çift faturalama korumalı); xlsx/csv ile fatura içe aktarma (taslak, eşleme arayüzü). Hukuki biçimler doğrulanmamıştır.
- **İthalat maliyet dağıtımı, gider kartları ve raporları (X4):** ithalat dosyası (kayıtlı alış faturası/irsaliye satırları + navlun, sigorta, gümrük vergisi vb. ek maliyetler kullanıcı girişiyle; değer/miktar/ağırlık/elle dağıtım, kuruş yuvarlaması belirli; stok maliyetine ve yevmiyeye yazılır, satılmış mala düşen pay satılan mal maliyetine; iptal ve geçmiş; birim maliyet öncesi/sonrası raporu) ve gider kartları (varsayılan hesap, KDV kodu, stopaj %, proje) ile hızlı gider fişi (kasa/banka ya da cari karşılığı) ve kart/ay/proje/cari/en yüksek gider raporları (`inventory.imports`, `treasury.expenses` modülleri; oranlar kullanıcı verisidir, muhasebe işlenişi doğrulanmamıştır).
- **Fiyat listeleri, cari özel fiyat/iskonto, seri no takibi (X3):** satış/alış fiyat listeleri (kademe, geçerlilik, kopyala/yüzde ayarı/toplu giriş), cariye özel fiyat ve iskonto, tek fiyat çözümleyici (cari özel > cari listesi > varsayılan liste > kart; satırda kaynağı görünür, her zaman elle değişir); seri takipli kartlarda giriş/çıkış/iade/fire/transfer seri no'ları, ters belgede geri alma, "Seri no sorgula" ile tedarikçiden müşteriye geçmiş (`sales.pricelists`, `inventory.serials` modülleri; döviz çevirisi ve lot takibi yok).
- **Personel cari ve avans takibi (X5):** personel kartından cari açma (`employee` türü, yalnız ad), kasa/bankadan avans verme/geri ödeme alma ve net maaş ödemesi (mevcut kasa/banka yolu), bordrodan avans kesintisi (taslakta seçim, onayda personel avansları hesabına yevmiye ve taksit, bordro iptalinde geri alma; isteğe bağlı kullanıcı üst sınırı, doğrulanmadı), "kim kime borçlu" listesi, avans sicili/yaşlandırma ve personel ekstresi (`hr.employee_ledger` modülü; `hr.payroll` izni + erişim günlüğü, dışa aktarmalar IBAN'sız; hesap eşlemesi 196 ve kesintinin hukuki uygunluğu doğrulanmamıştır).
- **Rehber, ajanda ve görüşme notları (X6):** kurum ve kişi rehberi (telefon/e-posta/adres; kimlik no ve doğum tarihi tutulmaz), etiket, yinelenen kişi ipucu, birleştirme, arşiv (silme yok), vCard/CSV/Excel dışa aktarma ve içe aktarma, cari/proje kartında ilgili kişiler; ajanda (görev/randevu; bugün/yaklaşan/gecikmiş; hatırlatma bildirim olarak gelir (N1)), özel/paylaşılan görüşme notu ve tek tıkla takip görevi; ilgili kişi talebi, günlüklü dışa aktarma ve anonimleştirme. Hukuki dayanak ve saklama süresi doğrulanmamıştır (docs/LEGAL-NOTES.md §21).
- **Çoklu şirket konsolidasyonu, döviz pozisyonu, yönetici özeti (X7):** kullanıcıya ait **konsolidasyon grubu**: aynı kullanıcının üyesi olduğu (sahip/yönetici rolüyle) ve konsolidasyon modülünü açık tuttuğu şirketler; üyelik/rol/modül **her istekte sunucuda yeniden doğrulanır**, düşen şirket rapordan çıkar ve ekranda uyarılır; şirket verisi şirket şirket kendi RLS bağlamında okunur (çapraz kiracı yolu yok). Hesap koduna göre eşlenmiş **konsolide mizan**, bilanço ve gelir tablosu gösterimi (şirket sütunları + eliminasyon + konsolide; eşleşmeyen kodlar ayrı), kullanıcı seçimli kur (kapanış / dönem ortalaması / elle) ve çevrim farkı, elle girilen salt-eklenir **eliminasyonlar**, vergi numarası ipucu. **Döviz pozisyon raporu** (şirket ve grup: net pozisyon, karşılık, gerçekleşmemiş kur farkı tahmini; yevmiye yazmaz) ve **yönetici özet raporu** (gelir/gider/kâr, nakit, yaşlandırma, stok, en büyük müşteri/tedarikçi, proje, İK toplamları, KPI + tanımları, dönem karşılaştırması; izin ve modüle göre bölümler; A4 baskı, Excel). Yöntemlerin hiçbiri doğrulanmadı (LEGAL-NOTES §22); yasal konsolide tablo değildir. Migration 0075/0076 (ERP22). Bununla birlikte yol haritasındaki "Diğer özellikler" listesi tamamlandı; kalanlar Faz C (resmî uyum), Faz E (market) ve mevzuat doğrulaması bekleyen kalemlerdir (docs/ROADMAP.md).
- **Bildirimler (N1):** üst çubukta zil (okunmamış sayısı), `/notifications` listesi ve `/settings/notifications` tercihleri; çek/senet vadesi, teminat mektubu ve yabancı işçi belge süresi, ajanda (bugün/geciken, hatırlatma ofseti), onay bekleyen belge, lisans, kapatılmamış puantaj/bordro ayı, vadesi geçmiş alacak, kritik stok ve eski taslak için. Her bildirim kaynak modülü şirkette açık ve kaynak iznine sahip kullanıcıya gider; metin **genel** (yalnız sayı; ad, kimlik no, tutar yok). Zamanlayıcı (`NOTIFY_ENABLED`, `NOTIFY_INTERVAL_MINUTES`) her şirketi kendi RLS bağlamında tarar, çok örnekli kurulumda şirket başına PostgreSQL advisory kilidiyle çalışır, kopya üretmez ve koşul kalkınca bildirimi çözer. İsteğe bağlı günlük **e-posta özeti** yalnızca SMTP açıkken ve kullanıcı isterse (varsayılan kapalı) gider; yalnızca tür + sayı + bağlantı içerir. Eşikler kullanıcı tercihidir (yasal süre değil). Push/SMS yok (docs/ARCHITECTURE.md, docs/OPERATIONS.md §9b, docs/LEGAL-NOTES.md §24).
- **Kullanıcı bazlı modül erişimi (M-A1):** sahip ve yönetici her üye için her modülde _Erişim yok / Sadece görüntüle / Görüntüle ve düzenle_ seçer (rol varsayılanı ya da özel erişim; Ayarlar > Kullanıcılar ve yetkiler > Modül erişimi). Etkin izin = rol + istisna, her istekte hesaplanır (önbellek yok, anında geçerli); API, menü, sayfa kapıları, dışa aktarma, bildirim, onay ve konsolidasyon aynı kümeye bakar. Şirket/üye yönetimi, yıl sonu, konsolidasyon, hassas personel verisi ve dışa aktarma yalnızca role bağlıdır; kimse kendi erişimini değiştiremez, sahibinki kısıtlanamaz, yönetici yalnızca kendinde olanı verir. RLS + koruyucu tetikleyici (`ERP26`) + denetim izi. Ayrıntı: docs/ARCHITECTURE.md "Kullanıcı bazlı modül erişimi".
