# Muhasebe ERP

KKTC işletmeleri için sade ve güçlü, web tabanlı muhasebe/ERP. İlk hedef sektör inşaat ve taahhüt; market ve ticaret modülleri aynı çekirdeğin üstüne eklenecek şekilde tasarlandı.

**Durum:** Çekirdek ERP hazır (kiracılık, kimlik doğrulama, ayarlar, genel muhasebe, cari, stok, fatura, irsaliye, kasa ve banka, raporlar ve dışa aktarma, içe aktarma, banka mutabakatı), **inşaat modülünün ilk aşaması hazır** (şantiye projesi, iş kırılımı, bütçe, gerçekleşen maliyet ve tamamlanma tahmini; taşeron hakedişi, gayrimenkul/taksit ve fonlar sırada) ve **dağıtıma hazırlandı** (Docker imajı, güvenlik sağlamlaştırması, yedekleme/geri yükleme tatbikatı, modül yönetimi) ve **lisanslanabilir** (imzalı kiralı lisans: sektör, cihaz kotası, şirket sınırı, abonelik bitişi; satıcı lisans sunucusu ve yönetim paneli). Yıl sonu kapanış/devir ve kur değerlemesi mali müşavir teyidini bekliyor. Sıradaki adımlar: bkz. [docs/ROADMAP.md](docs/ROADMAP.md).

## Neler var?

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
- **Taşeron sözleşmesi ve hakediş (B2):** taşeron sözleşmesi, **revizyonlu BOQ**, **kümülatif hakediş** (teminat, avans mahsubu, stopaj, diğer kesinti, KDV), tutar kademeli **onay kuralları**, onaylanınca aynı işlemde proje + iş kalemi + **maliyet kodu** etiketli yevmiye (320 cari açık kalemi, mevcut ödeme akışıyla kapanır), avans ve teminat iadesi, **değişiklik emri** (ek/eksilen iş, fiyat, süre uzatımı; onay ve işveren sözleşmesinde işveren kabulü; bekleyen emirler raporlarda ayrı), **KDV tevkifatı** (iki yön, parametreli, varsayılan kapalı) ve **malzeme mahsubu** (taşerona verilen malzeme hakedişte bakiyeli mahsup edilir), proje maliyet raporunda **kalan taahhüt** (BOQ − hakediş; EAC'ye girmez) ve maliyet koduna göre kırılım. Teminat/stopaj/avans yüzdeleri tarihli, kaynak notlu ve "doğrulanmamış" rozetli veridir; hiçbiri kodda sabit değildir.
- **Kur:** elle giriş ya da KKTC Merkez Bankası XML'inden içe aktarma (resmî adres veya dosya yükleme).
- **Modül yönetimi ve hesap güvenliği:** kullanılmayan modüller Ayarlar > Modüller'den bağımlılık korumalı kapatılır; parola sıfırlama ve e-posta doğrulama (SMTP ile), geçici parola zorunlu değişimi, parola politikası, güvenlik olayı kaydı.
- **Lisanslama:** yazılım müşterinin kendi sunucusunda çalışır; satıcı kendi VPS'indeki **lisans sunucusundan** (web paneli + komut satırı; parola ve zorunlu TOTP) istediği zaman lisans verir. Lisans sektörü (market / inşaat / ticaret), **cihaz kotasını** (cihaz = kayıtlı tarayıcı/bilgisayar; cihaz başına ücret), şirket sınırını ve bitişi belirler. Ed25519 imzalı kısa ömürlü kira; sahte lisans, veritabanında lisans düzenleme, sunucu klonlama, saat geri alma ve ağ kesme denemeleri engellenir ya da saptanır; süre bitince/doğrulanamayınca **salt-okunur mod** (veri görüntülenir ve dışa aktarılır). Muhasebe verisi lisans sunucusuna gitmez. Dürüst sınır: müşteri sunucuyu kontrol ettiği için %100 kırılamaz değildir ([docs/LICENSING.md](docs/LICENSING.md)); sözleşme/EULA avukata yazdırılmalıdır.
- **Rol bazlı yetki, sektöre göre menü, denetim izi, Türkçe arayüz** (çoklu dil altyapılı), açık/koyu tema, `Ctrl+K` komut paleti.

## Hızlı başlangıç

**Tek komutla (önerilen):** kurulum sihirbazı önce sistemi denetler (işletim sistemi, bellek, disk, portlar, Docker, Node, PostgreSQL), sonra uygun yolu önerir, eksik paketleri kurar ve sistemi ayağa kaldırır.

```bash
./install.sh                 # Linux / WSL (Ubuntu 22.04+, Debian 12+)
./install.sh --check         # yalnızca uyumluluk raporu
```

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

# 3) (İsteğe bağlı) demo verisi: örnek inşaat şirketi, cariler, stok, kurlar, bir yıllık yevmiye
npm run db:seed        # giriş: demo@ornek.local / Demo-Sifre-123
#    (sıfırdan: npm run demo:reset -- --confirm=erp_dev  → şemayı siler, migration + demo verisi)

# 4) Çalıştır: API http://localhost:3000, web http://localhost:5173
npm run dev
```

## Komutlar

| Komut | Ne yapar |
|---|---|
| `npm run dev` | API ve web'i birlikte başlatır |
| `npm test` | Birim + entegrasyon testleri (gerçek PostgreSQL, RLS dahil) |
| `npm run e2e` | Playwright uçtan uca testleri (`PW_CHROMIUM_PATH` ile hazır Chromium gösterilebilir) |
| `npm run lint` / `npm run typecheck` | Kod kalitesi |
| `npm run db:generate` | Drizzle şemasından yeni migration üretir |
| `npm run db:seed` | Demo verisi yükler (demo kullanıcı varsa dokunmaz; üretimde yalnızca `ALLOW_DEMO=true`) |
| `npm run demo:reset -- --confirm=<veritabanı>` | Veritabanını **siler**, migration'ları uygular, demo verisini yükler |
| `npm run admin -- reset-password --email=…` | Operatör parola kurtarma (geçici parola üretir) |
| `npm run release -- --version=X` | Müşteri sürüm kitleri (`release/X/`: linux-x64, win-x64; `--targets=` ile seçilir) |
| `npm run build` | Web + API üretim paketi (`apps/api/dist`, `apps/web/dist`) |
| `npm run licenses:notices` | `THIRD-PARTY-NOTICES.md` üretir |
| `npm run build:license` | Lisans sunucusunu ve yönetim panelini derler |
| `node apps/license-server/dist/cli.js …` | Satıcı CLI: `keygen`, `admin:create`, `license:issue\|list\|extend\|suspend\|revoke` ([LICENSING.md](docs/LICENSING.md)) |
| `npm run admin -- devices` | Operatör: kayıtlı cihazları (lisans koltukları) listeler; `devices:revoke`, `devices:revoke-all --yes` |
| `scripts/backup.sh` / `restore.sh` / `restore-drill.sh` | Yedek, geri yükleme, geri yükleme tatbikatı ([işletim kılavuzu](docs/OPERATIONS.md)) |
| `npm run load:gen` / `load:test` | Yük verisi üretir / yük ölçer ([PERFORMANCE.md](docs/PERFORMANCE.md)) |
| `npm run tour` | Demo verisiyle tüm ekranların ekran görüntüsünü alır, mobilde yatay taşmayı denetler |
| `npm run licenses` | Bağımlılık lisanslarını denetler |

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
apps/license-server  Satıcının lisans sunucusu (etkinleştirme, kalp atışı, yönetim API'si, CLI; kendi PostgreSQL'i)
apps/license-admin   Satıcı yönetim paneli (lisans sunucusundan sunulur)
packages/license-core  Lisans belirteci/kira/parmak izi/TOTP (Ed25519, yalnızca Node crypto)
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
- [Lisanslama kılavuzu](docs/LICENSING.md) — satıcı kurulumu, lisans verme, müşteri kılavuzu, güvenlik modeli ve dürüst sınırlar
- [Performans ölçümleri](docs/PERFORMANCE.md)
- [Tasarım sistemi](docs/DESIGN.md)
- [Kapsam ve işlev kontrol listesi](docs/SCOPE.md)
- [Hukuki notlar ve doğrulanması gerekenler](docs/LEGAL-NOTES.md) — ticari kullanımdan önce mutlaka okuyun
- [Yol haritası](docs/ROADMAP.md)

## Önemli uyarı

Hesap planı şablonu, KDV oranları ve diğer yasal parametreler **resmî kaynaktan doğrulanmamıştır**. Uygulama bunları sabit kodlamaz; tarihli ve kaynaklı veri olarak, mali müşavir/avukat onayıyla girilir. 1 Ekim 2026 mevzuat incelemesinde bazı maddeler güncellendi: e-Fatura API'si için kaynak bulundu, KDV oran kümesi %0/5/10/16/20 oldu, yabancı taşınmaz için eski kota modeli yerine 89/2026 YGK esas alındı, D3 bordro eklendi. Bazı maddeler de çıkarıldı (KIB-TEK katkı payı, “15:30” kur saati). Ayrıntı: [docs/LEGAL-NOTES.md](docs/LEGAL-NOTES.md) §3.
