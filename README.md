# Muhasebe ERP

KKTC işletmeleri için sade ve güçlü, web tabanlı muhasebe/ERP. İlk hedef sektör inşaat ve taahhüt; market ve ticaret modülleri aynı çekirdeğin üstüne eklenecek şekilde tasarlandı.

**Durum:** Çekirdek ERP hazır (kiracılık, kimlik doğrulama, ayarlar, genel muhasebe, cari, stok, fatura, irsaliye, kasa ve banka, raporlar ve dışa aktarma, içe aktarma, banka mutabakatı) ve **dağıtıma hazırlandı** (Docker imajı, güvenlik sağlamlaştırması, yedekleme/geri yükleme tatbikatı, modül yönetimi). Yıl sonu kapanış/devir ve kur değerlemesi mali müşavir teyidini bekliyor. Sıradaki adımlar: bkz. [docs/ROADMAP.md](docs/ROADMAP.md).

## Neler var?

- **Çok şirketli, yalıtılmış veri:** her satır bir şirkete aittir; PostgreSQL satır düzeyi güvenlik (RLS) uygulama hatası olsa bile başka şirketin verisini göstermez.
- **Değiştirilemez defter:** kaydedilen yevmiye değiştirilemez ve silinemez; düzeltme ters kayıtla yapılır. Borç=alacak, dönem kilidi ve hesap kuralları veritabanında da denetlenir.
- **Çoklu para birimi:** TL, GBP, EUR, USD. Dövizli satırlar işlem tarihindeki kurdan çevrilir; yönetim raporlaması için ikinci bir para birimi tutulabilir.
- **Cari hesaplar:** müşteri/tedarikçi kartı, ekstre, vadeye göre yaşlandırma, açık kalemler; cari kontrol hesabına (120/320) cari olmadan kayıt atılamaz.
- **Stok:** stok kartı, çoklu depo, giriş/çıkış/fire/transfer/devir, sayım, hareketli ağırlıklı ortalama maliyet, kritik seviye uyarısı, tarih anı stok değeri. Alış maliyeti EUR/GBP/TL girilebilir, hareket günü kuruyla çevrilir. Stok defteri değiştirilemez (düzeltme ters belgeyle); negatif stok şirket ayarıyla açılır.
- **Fatura:** satış, alış, gider, satış iadesi, alış iadesi. Kayıt; stok hareketini, cari alacak/borcu ve yevmiyeyi **tek işlemde** yazar; numara boşluksuzdur, kaydedilmiş fatura değiştirilemez (iptal = ters kayıt). KDV hariç/dahil fiyat, iskonto, dövizli fatura, orijinale bağlı iade, KDV özeti. **Hesap eşlemesi** ile elle girilen stok belgeleri de otomatik yevmiye üretir; stok değeri ile 150–157 hesapları baştan mutabıktır. Varsayılan hesaplar ve KDV oranları mali müşavirce doğrulanmamıştır.
- **İrsaliye:** satış (sevk) ve alış (mal kabul) irsaliyesi stoğu hemen hareket ettirir, yevmiyeyi fatura kesilince yazar. Fatura irsaliyeye bağlanır (kısmi/çoklu faturalama, stok tekrar hareket etmez); alışta fiyat farkı elde kalan miktar payı stoğa, satılan payı satılan mal maliyetine gider. Faturalanmamış irsaliyeler stok mutabakatında açıklanan fark olarak görünür. Yasal irsaliye biçimi doğrulanmamıştır.
- **Kasa ve banka:** kasa/banka hesapları (her biri bir muhasebe hesabına bağlı, çoklu para birimi), tahsilat ve ödeme (cari açık kalemleriyle elle eşleştirilir: kısmi, çoklu kalem, farklı para birimi, avans), **gerçekleşen kur farkı otomatik yazılır**, virman, döviz alım-satım (ortalama maliyetle), banka masrafı/faiz, iptal (ters kayıt), kasa eksi bakiye denetimi. Kur değerlemesi ve avans mahsubu sonraki adımdır; kambiyo hesapları ve kasa kuralı doğrulanmamıştır.
- **Raporlar ve dışa aktarma:** yevmiye defteri, kebir, satış/alış raporu, stok kârlılığı, kambiyo raporu; tüm raporlar **Excel (.xlsx), CSV ve yazdır/PDF** olarak alınabilir, tam veri dışa aktarma tek Excel dosyasıdır. PDF, tarayıcının yazdır penceresinden “PDF olarak kaydet”tir; yevmiye defteri/kebir çıktıları yasal onaylı defter yerine geçmez.
- **İçe aktarma:** cari ve stok kartları ile cari/stok/mizan açılış bakiyeleri Excel ya da CSV dosyasından aktarılır (sütun eşleme, satır satır ön izleme, hata varsa hiçbir kayıt yazılmaz). Açılış kaydının karşı hesabı ve mizan açılışı akışı mali müşavirce doğrulanmamıştır.
- **Banka mutabakatı:** banka ekstresi (Excel/CSV) içe aktarılır ve defter kayıtlarıyla eşleştirilir (tutar birebir, ±3 gün; kesin/olası öneri, elle ve otomatik); eşleşmeyen ekstre satırından tek tıkla hareket oluşturulur; ekstre kapanış bakiyesi ile defter bakiyesi farkı ekranda açıklanır. Eşleşmiş hareket/fiş iptal edilemez. Bankaya özgü ekstre biçimleri doğrulanmamıştır.
- **Kur:** elle giriş ya da KKTC Merkez Bankası XML'inden içe aktarma (resmî adres veya dosya yükleme).
- **Modül yönetimi ve hesap güvenliği:** kullanılmayan modüller Ayarlar > Modüller'den bağımlılık korumalı kapatılır; parola sıfırlama ve e-posta doğrulama (SMTP ile), geçici parola zorunlu değişimi, parola politikası, güvenlik olayı kaydı.
- **Rol bazlı yetki, sektöre göre menü, denetim izi, Türkçe arayüz** (çoklu dil altyapılı), açık/koyu tema, `Ctrl+K` komut paleti.

## Hızlı başlangıç

Gereksinimler: Node.js 22.9+, PostgreSQL 16 (ya da Docker). PostgreSQL'in ICU desteği gerekir (Türkçe sıralama için `tr-TR-x-icu`); resmî Docker imajı ve yaygın paketlerde vardır.

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
| `npm run build` | Web + API üretim paketi (`apps/api/dist`, `apps/web/dist`) |
| `npm run licenses:notices` | `THIRD-PARTY-NOTICES.md` üretir |
| `scripts/backup.sh` / `restore.sh` / `restore-drill.sh` | Yedek, geri yükleme, geri yükleme tatbikatı ([işletim kılavuzu](docs/OPERATIONS.md)) |
| `npm run load:gen` / `load:test` | Yük verisi üretir / yük ölçer ([PERFORMANCE.md](docs/PERFORMANCE.md)) |
| `npm run tour` | Demo verisiyle tüm ekranların ekran görüntüsünü alır, mobilde yatay taşmayı denetler |
| `npm run licenses` | Bağımlılık lisanslarını denetler |

## Dağıtım ve yedekleme

Tek artefakt bir **Docker imajıdır** (derlenmiş API + web arayüzü, aynı kökenden). `deploy/docker-compose.prod.yml` PostgreSQL 16, tek seferlik migration ve uygulamayı (isteğe bağlı Caddy ile otomatik HTTPS) ayağa kaldırır; uygulama yalnızca RLS'e tabi çalışma zamanı rolünü bilir.

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
- [Performans ölçümleri](docs/PERFORMANCE.md)
- [Tasarım sistemi](docs/DESIGN.md)
- [Kapsam ve işlev kontrol listesi](docs/SCOPE.md)
- [Hukuki notlar ve doğrulanması gerekenler](docs/LEGAL-NOTES.md) — ticari kullanımdan önce mutlaka okuyun
- [Yol haritası](docs/ROADMAP.md)

## Önemli uyarı

Hesap planı şablonu, KDV oranları ve kapsam belgesindeki tüm yasal parametreler **resmi kaynaktan doğrulanmamıştır**. Uygulama bunları sabit kodlamaz; mali müşavir/avukat onayıyla girilir. Ayrıntı: [docs/LEGAL-NOTES.md](docs/LEGAL-NOTES.md).
