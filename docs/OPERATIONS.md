# İşletim kılavuzu

Bu belge ürünü bir müşteriye kuran ya da barındıran kişi içindir: kurulum, yapılandırma, yükseltme, yedekleme ve geri yükleme, izleme, destek sorguları ve müşteri kurulum kontrol listesi. Hukuki/mali konular için [LEGAL-NOTES.md](LEGAL-NOTES.md), ölçüm sonuçları için [PERFORMANCE.md](PERFORMANCE.md), **lisans sunucusunu işleten satıcı** için [LICENSING.md](LICENSING.md).

## 1. Ne dağıtılır

Tek artefakt bir **Docker imajıdır** (`Dockerfile`): derlenmiş API ve web arayüzü aynı kapta, **aynı kökenden** sunulur. Yanında:

| Dosya | Amaç |
|---|---|
| `deploy/docker-compose.prod.yml` | Müşteri kurulumu: `db` (PostgreSQL 16) + tek seferlik `migrate` + `app` (+ isteğe bağlı `caddy` ile otomatik HTTPS) |
| `deploy/docker-compose.demo.yml` | Ayrı **demo örneği** (bkz. §8) |
| `deploy/.env.production.example` | Ortam değişkenleri şablonu (`deploy/.env` olarak kopyalanır; depoya girmez) |
| `infra/postgres/init-prod.sh` | İlk açılışta rolleri ve veritabanını yaratır |
| `scripts/backup.sh`, `restore.sh`, `restore-drill.sh` | Yedek, geri yükleme, geri yükleme tatbikatı |
| `install.sh`, `Kur.cmd`, `installer/` | Kurulum sihirbazı (Linux/WSL, Windows; Docker'lı ve Docker'sız; tüm yapılandırmayı sorar), §2. `installer/answers.example`: yanıt dosyası örneği |
| `npm run release` | Sürüm kitleri (linux-x64, win-x64): Docker'sız kurulum da kitten yapılır |

Uygulama kabı yalnızca **RLS'e tabi çalışma zamanı rolünü** (`erp_app`) bilir; şema sahibi rolün (`erp`) parolası yalnızca tek seferlik `migrate` kabındadır. Uygulama, süper kullanıcı/`BYPASSRLS`/tablo sahibi bir rolle ya da RLS'siz tablolarla açılmayı **reddeder** (üretimde `exit 1`).

**Lisans:** imaj **lisanslıdır**: üretim paketi lisans denetimi açık derlenir ve satıcının açık anahtarını gömer; lisans etkinleştirilmeden uygulama yalnızca etkinleştirme ekranını sunar. Müşteri imajı, lisansı veren satıcının derlediği imajdır (açık anahtar pakete gömülüdür; bkz. [LICENSING.md §5](LICENSING.md)). Bu kılavuzdaki "müşteri kurulumu" bölümleri lisans etkinleştirme adımını içerir (§4).

**Müşteriye yalnızca imajla teslim (kaynak kodu verilmez).** Satıcı imajı derler (`lisans-server/docs/LICENSING.md §5`) ve `docker save muhasebe-erp:1.0.0 | gzip > muhasebe-erp-1.0.0.tar.gz` ile dosyalar. Müşteri kiti, **aynı klasör düzeniyle**: imaj dosyası + `deploy/docker-compose.prod.yml`, `deploy/.env.production.example`, `deploy/Caddyfile`, `infra/postgres/init-prod.sh`, `scripts/backup.sh`, `scripts/restore.sh`, `docs/OPERATIONS.md`. Müşteri tarafında: `docker load < muhasebe-erp-1.0.0.tar.gz`, `deploy/.env` içinde `ERP_IMAGE=muhasebe-erp:1.0.0`, sonra `docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d` (**`--build` kullanılmaz**: kaynak kod yoktur; aşağıdaki `git clone` ve `--build` adımları yalnızca kaynağı olan satıcı/geliştirici içindir).

İmaj yayını (registry) henüz yoktur: imaj müşteri sunucusunda `docker build` ile ya da sizin derleyip `docker save/load` ile taşıdığınız imajla kurulur.

## 2. Kurulum

### Kurulum sihirbazı (önerilen)

Tek giriş noktası: **Linux/WSL** `./install.sh`, **Windows** `Kur.cmd` (çift tıklama; Windows PowerShell 5.1 yeterli, gerekirse UAC ile yönetici izni ister). **Tek betik hem kurulumu hem tüm yapılandırmayı yapar**: hiçbir ayar dosyasını elle düzenlemeniz gerekmez. Sihirbaz beş aşamada çalışır ve güvenle yeniden çalıştırılabilir (mevcut parolalara/ayarlara dokunmaz):

1. **Uyumluluk kontrolü** — işletim sistemi ve sürümü (Ubuntu 22.04+, Debian 12+, WSL, Windows 10 1809+/11/Server 2019+), mimari (x64), bellek (en az 2 GB, 4 GB önerilir), boş disk (en az 5 GB), yönetici yetkisi, systemd, Docker + compose v2, sanallaştırma (Windows), mevcut Node.js ve PostgreSQL, portlar, internet, makine kimliği, kit hedefi. Her satır ✓/!/✗; ✗ varsa kurulum başlamaz. Yalnızca rapor: `./install.sh --check` / `installer\install.ps1 -Check`.
2. **Yol seçimi** — kip: `dev` (depodan test/geliştirme) ya da `prod` (sürüm kitinden müşteri kurulumu; `kit.json` varsa varsayılan). Yol: `docker` (Docker çalışıyorsa önerilir) ya da `native` (Docker'sız; sanallaştırması kapalı PC'ler dahil). Erişim: `local` (yalnız bu bilgisayar), `lan` (yerel ağ), `domain` (alan adı üzerinden internet).
3. **Yapılandırma (sorular)** — aşağıdaki "Kurulum soruları" tablosu: demo/boş, port, alan adı ve HTTPS, e-posta, lisans, yedek, kayıt. Bu aşamada **hiçbir şey yazılmaz**; en sonda özet gösterilir ve onay istenir.
4. **Gerekli paketler** — geliştirmede Node.js 22 (nodejs.org resmî paketi, SHA-256 doğrulamalı); yerel yolda PostgreSQL 16 (Linux: dağıtım deposu ya da resmî PGDG deposu; Windows: winget, yoksa EnterpriseDB sessiz kurulumu, Authenticode imzası doğrulanır). Müşteri kitinde Node.js gömülüdür, ayrıca kurulmaz.
5. **Sistemin kurulumu** — aşağıdaki tabloya göre; sonunda **özet ekranı** (adresler, lisans durumu, e-posta, yedek, dosya/günlük/yedek konumları, ilk giriş adımları ve "resmî fatura/bordro değildir" notu) yazılır.

#### Kurulum soruları

Her sorunun varsayılanı vardır (Enter kabul eder), bir satırlık açıklaması gösterilir, geçersiz girişte yeniden sorulur; parolalar ve lisans kodu yazarken görünmez. Aynı anahtarlar `--yes`/yanıt dosyasında kullanılır (sonraki bölüm).

| Soru (ekranda) | Yanıt anahtarı | Varsayılan | Ne işe yarar |
|---|---|---|---|
| Demo verisi (örnek şirket/cari/proje) yüklensin mi? `[e/H]` | `DEMO` (`yes`/`no`) | **hayır** (üretim); dev'de evet | Hayır = **tamamen boş uygulama**: örnek şirket, kullanıcı, cari yok; ilk hesabı siz "Kayıt ol" ile açarsınız. Evet = deneme verisi (`demo@ornek.local`; parolası herkesçe bilinir, gerçek veri girmeyin). Demo yalnızca **ilk kurulumda** yüklenir; yeniden çalıştırma/yükseltme asla yüklemez |
| Uygulamaya nereden erişilecek? | `ACCESS` | `local` | `local` bu bilgisayar, `lan` yerel ağ, `domain` internet |
| Uygulama portu | `PORT` | `3000` | Başka uygulama kullanıyorsa yeniden sorulur (çakışma denetimi). Veritabanı portu dışarı açılmaz; yerel yolda mevcut PostgreSQL kümesi kullanılır |
| Güvenli bağlantı (HTTPS) nasıl sağlansın? | `TLS_MODE` | domain: `auto`; diğer: `none` | `auto` Let's Encrypt, `byo` kendi sertifikanız, `selfsigned` kendi imzalı (yerel ağ), `none` düz http. **HTTPS şimdilik Docker yolundadır** (Caddy) |
| Alan adı ya da adres | `DOMAIN` | LAN'da makinenin IP'si | `auto` için gerçek alan adı (FQDN); diğerlerinde IP/bilgisayar adı da olur |
| Sertifika bildirimleri için e-posta | `ACME_EMAIL` | boş | Let's Encrypt bitiş uyarıları |
| Sertifika dosyası / Özel anahtar dosyası | `CERT_FILE`, `KEY_FILE` | — | `byo`: tam zincir `.crt/.pem` + parolasız `.key`. Doğrulanır: anahtar sertifikaya uyuyor mu, süresi, alan adını kapsıyor mu, zincir sırası, ara sertifika eksik mi. Dosyalar yalnızca yöneticinin okuyabildiği `deploy/certs` klasörüne kopyalanır; anahtar içeriği asla yazdırılmaz |
| HTTP / HTTPS portu | `HTTP_PORT`, `HTTPS_PORT` | `80` / `443` | `auto` için sabittir; diğerlerinde değiştirilebilir (çakışma denetimi) |
| E-posta gönderimi kurulsun mu? | `MAIL_ENABLED` | hayır | Hayır = parola sıfırlama/e-posta doğrulama kapalı kalır (§9) |
| SMTP sunucusu, güvenlik türü, port | `SMTP_HOST`, `SMTP_SECURITY`, `SMTP_PORT` | `starttls`; 465/587/25 | `ssl` (465), `starttls` (587), `none` (şifresiz; uyarı verir) |
| Kullanıcı adı, parola | `SMTP_USER`, `SMTP_PASSWORD` | — | Parola yazarken görünmez; ortam dosyasına yüzde-kodlu `SMTP_URL` olarak yazılır |
| Gönderen adresi / adı | `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME` | kullanıcı adı / `Muhasebe ERP` | `MAIL_FROM` olur |
| Uygulamanın adresi | `APP_BASE_URL` | erişim ayarından türetilir | E-postalardaki bağlantı kökü |
| Test e-postası adresi | `MAIL_TEST_TO` | boş (test yok) | Doluysa **gerçek bir test e-postası gönderilir**. Başarısızsa nedeni düz Türkçe yazılır ve seçenek sunulur: tekrar dene / ayarları düzenle / e-postasız devam / yine de kaydet. Yanıt dosyası kipinde başarısızlık kurulumu **durdurur** |
| Lisans sunucusu adresi | `LICENSE_SERVER_URL` | boş (kitteki/imajdaki varsayılan) | Yalnızca https; verilirse `/healthz` ile erişimi sınanır, ulaşılamazsa uyarılır. Sihirbaz kitte adres gömülü olup olmadığını söyler (`kit.json` → `licenseServerUrl`); kitte de yoksa yalnızca çevrimdışı etkinleştirme yapılabilir |
| Lisans etkinleştirme kodu | `LICENSE_CODE` | boş (tarayıcıda girilir) | Girilirse uygulama açıldıktan sonra yerel `POST /api/license/activate` ile etkinleştirilir (belgeli akış; kod yazdırılmaz/saklanmaz). Girilmezse ilk açılışta "Lisans etkinleştirme" ekranından girilir |
| Yedek klasörü, kaç yedek, saat | `BACKUP_DIR`, `BACKUP_KEEP`, `BACKUP_TIME` | Linux yerel: `/var/backups/muhasebe-erp` (yalnız root); Windows yerel: `ProgramData\MuhasebeERP\backups`; Docker: `<kurulum klasörü>/backups`; `14` (en az 1), `02:30` | Günlük yedek (systemd zamanlayıcısı, yoksa cron; Windows'ta — Docker yolu dahil — zamanlanmış görev). Temizlik yalnızca yedek betiğinin adlandırdığı dosyalara dokunur. Eski kurulumlardaki `/var/lib/muhasebe-erp/backups` (hizmet kullanıcısının klasörü) yeniden çalıştırmada buraya taşınır. Ofis dışı kopya (rsync/UNC) elle kurulur (§6) |
| Yeni kullanıcı/şirket kaydı açık olsun mu? | `REGISTRATION` | evet | İlk sahip hesabı için gerekli; sonra `--reconfigure` ile kapatın (`REGISTRATION_ENABLED=false`) |

Saat dilimi/dil ve şirket görünen adı için sihirbaz soru **sormaz**: uygulamada bunlar yapılandırma ayarı değildir (şirket adı ilk kayıtta girilir).

**Lisans zorunludur.** Üretim kurulumunda uygulama lisans etkinleştirilmeden **iş uçlarını açmaz** (`402 LICENSE_REQUIRED`; yalnızca sağlık, genel yapılandırma ve lisans uçları açık; arayüz etkinleştirme ekranını gösterir). Sihirbaz kurulumdan sonra bunu doğrular (`/api/public-config` → denetim açık, iş ucu 402) ve denetim açık görünmüyorsa uyarır. Geliştirme kipinde (`NODE_ENV≠production`) denetim kapalıdır; sihirbaz üretim kipinde `LICENSE_ENFORCEMENT_DEV`/`LICENSE_DEV_KEYRING` anahtarlarını asla yazmaz, bulursa siler.

#### Çalışma biçimleri ve bayraklar

| Biçim | Linux/WSL | Windows | Açıklama |
|---|---|---|---|
| Etkileşimli | `./install.sh` | `Kur.cmd` | Terminal varsa sorar |
| Varsayılanlarla | `--yes` | `-Yes` | Hiçbir şey sormaz (güncelleyici böyle çağırır) |
| Yanıt dosyası | `--answers=DOSYA` | `-AnswersFile DOSYA` | Sormaz; `KEY=VALUE` dosyasından okur. Yalnızca **yeni kurulumda** ya da `--reconfigure` ile; kurulu sistemde yanıt dosyası (ya da mevcut ayardan farklı `--port`/`--access`/`--domain`/`--tls`/`--demo` bayrağı) verilirse sihirbaz yok saymaz, **durur** ve `--reconfigure`'u önerir |
| Yeniden yapılandırma | `--reconfigure` | `-Reconfigure` | Kurulu sistemde yalnızca yapılandırmayı yeniden sorar |
| Kuru çalıştırma | `--dry-run` | `-DryRun` | Sistemi değiştirmeden ne yazılacağını gösterir (parolalar `********`); `--uninstall [--purge]` ile birlikte neyin durdurulup silineceğini listeler |
| Kaldırma | `--uninstall [--purge]` | `-Uninstall [-Purge]` | Yerel ya da Docker kurulumunu kaldırır; ayrıntı aşağıda |

Diğer bayraklar: `--check`, `--mode=dev|prod`, `--path=docker|native`, `--access=…`, `--domain=…`, `--port=…`, `--tls=auto|byo|selfsigned|none`, `--http-port`, `--https-port`, `--demo`/`--no-demo`, `--start`, `--uninstall [--purge [--i-understand-purge]]`, `--allow-downgrade`, `--restore-db=…` (Windows'ta aynı adlar `-Mode`, `-Path`, `-Access`, `-Domain`, `-Port`, `-Tls`, `-HttpPort`, `-HttpsPort`, `-Demo`/`-NoDemo`, `-IUnderstandPurge`, `-AllowDowngrade`, `-RestoreDb`, `-PgSuperPasswordFile`, …). Komut satırı bayrakları yanıt dosyasından önceliklidir.

**Sürüm düşürme yapılmaz.** Kurulu sürümden (ayar dosyasındaki `APP_VERSION`) eski bir kit çalıştırılırsa sihirbaz durur: migration'lar ileri yönlüdür, eski kod yeni şemayla çalışmaz. İstisnalar: güncelleyicinin geri dönüşü (`--restore-db=…`: eski sürümün yedeği de geri yüklenir) ve bilinçli `--allow-downgrade`. Uzaktan güncellemede de yalnızca **daha yeni** sürüm teklif edilir, onaylanır ve kurulur (aynı sürümü yeniden kurmak için kitin sihirbazını yerelde çalıştırın).

**Yanıt dosyası.** Yanıt dosyası **sürüm kitinin içinden** kullanılır (müşteri kurulumu; depo klasöründe `MODE=prod` + `INSTALL_PATH=native` kit olmadan çalışmaz, depoda Docker yolu ya da `MODE=dev` kullanın). `installer/answers.example` dosyasını kopyalayıp düzenleyin (örnek olduğu gibi de geçerlidir: yerel yol, boş uygulama, e-postasız). Kurallar (Linux ve Windows'ta aynı):

- Satır başına bir `ANAHTAR=değer`; `#` ile başlayan satır yorumdur. Dosya UTF-8'dir (Windows Not Defteri'nin eklediği BOM ve CRLF satır sonları sorun değildir).
- Tırnaksız değerde baştaki/sondaki boşluk atılır; **"boşluk + `#`" sonrası yorumdur** (`PORT=3000   # uygulama portu` → `3000`); `#` ile başlayan değer yorum sayılır, yani `SMTP_HOST=   # açıklama` **boş** değerdir (= varsayılan).
- Değer `#`, ` #` ya da baştaki/sondaki boşluk içeriyorsa (parolalarda olabilir) **tırnak** kullanın: `SMTP_PASSWORD="a #b c"` ya da `'…'`. Tırnak içi olduğu gibi alınır; kaçış dizisi yoktur, değer aynı tırnak karakterini içeremez (diğer tırnak türünü seçin).
- Boş değer = varsayılan. Anahtarlar yukarıdaki tablodaki sütundur; ayrıca `MODE` (`prod`/`dev`) ve `INSTALL_PATH` (`docker`/`native`). Bilinmeyen anahtar hata verir.

Dosya **çalıştırılmaz**, yalnızca okunur; sihirbaz dosyayı hiçbir yere **kopyalamaz**. `SMTP_PASSWORD` ve `LICENSE_CODE` gizlidir: dosyada bulunabilir ancak sihirbaz uyarır ve **kurulum bitince dosyayı silmeniz** gerekir (Linux'ta `chmod 600`).

```bash
tar -xzf muhasebe-erp-1.2.0-linux-x64.tar.gz && cd muhasebe-erp-1.2.0-linux-x64
cp installer/answers.example ../musteri.answers && chmod 600 ../musteri.answers   # düzenleyin
./install.sh --answers=../musteri.answers --dry-run     # önce ne yazılacağına bakın
./install.sh --answers=../musteri.answers                # sonra uygulayın; sonra dosyayı silin
```

Windows: kiti açın, `installer\answers.example` dosyasını kopyalayıp düzenleyin, yönetici PowerShell'de `powershell -ExecutionPolicy Bypass -File installer\install.ps1 -AnswersFile C:\yol\musteri.answers -DryRun`, sonra `-DryRun` olmadan.

**Yeniden yapılandırma** (`--reconfigure`). Kurulumdan sonra e-posta, HTTPS/sertifika, yedek, lisans adresi/kodu ve kayıt kapısını **yeniden sorar** (mevcut değerler varsayılandır; parola için Enter = koru). Sürüm, veritabanı ve veriler değişmez; demo sorulmaz. Uygulama: eski ayar dosyaları zaman damgalı yedeklenir (`erp.env.bak-YYYYMMDD-HHMMSS`, chmod 600), yenisi önce geçici dosyaya yazılıp yerine taşınır (atomik), hizmet yeniden başlatılır ve `/api/health/ready` doğrulanır; **sağlık başarısızsa eski ayarlar otomatik geri yazılır**. Yerel (Linux) kurulumda kurulu kopyadan: `sudo erp-setup --reconfigure`; Docker'da kit klasöründen: `./install.sh --reconfigure`; Windows yerelde `Program Files\MuhasebeERP\current\installer\install.ps1 -Reconfigure`. Sihirbazın durum dosyası (`/etc/muhasebe-erp/wizard.conf`, Docker'da `deploy/wizard.conf`, Windows'ta `ProgramData\MuhasebeERP\wizard.conf`) **gizli bilgi içermez**; yalnızca soruların varsayılanlarını ve demo durumunu tutar.

**HTTPS ayrıntıları (Docker yolu).** `auto`: Let's Encrypt; sihirbaz DNS'in bu makinenin genel IP'sine (`api.ipify.org` ile öğrenilir) işaret edip etmediğini, 80/443'ün boş olduğunu denetler ve uyarır (dışarıdan 80/443'ün açık olması sizin işinizdir). `byo`: kendi sertifikanız (yukarıdaki doğrulamalarla). `selfsigned`: openssl ile 825 günlük kendi imzalı sertifika (openssl yoksa Caddy'nin yerel CA'sı); istemcilerde güvenilir yapma adımları özet ekranında yazılır. Sihirbaz `deploy/Caddyfile.local` ve `deploy/certs/` üretir (`ERP_CADDYFILE`, `ERP_CERT_DIR`, `HTTP_PORT`, `HTTPS_PORT` ortam değişkenleriyle compose'a bağlanır). **Docker'sız (yerel) yolda HTTPS yoktur**: `lan` seçip kendi ters vekilinizi (nginx/Caddy) önüne koyun. Caddy/TLS profili CI'da otomatik sınanmaz; ilk kurulumda elle doğrulayın.

| Kip / yol | Ne yapılır |
|---|---|
| dev / docker | `.env` (rastgele JWT), `docker compose up -d db`, geliştirme rolleri, `npm ci`, migration, demo verisi → `npm run dev` |
| dev / native | Aynısı; veritabanı yerel PostgreSQL'de (`infra/postgres/init.sql`) |
| prod / docker | İmaj kitteki derlenmiş dosyalardan yerelde oluşturulur (kaynak gerekmez); `deploy/.env` rastgele parolalar ve yanıtlarla yazılır (chmod 600 / yalnız yöneticiler), HTTPS seçildiyse `deploy/Caddyfile.local` + sertifikalar, `docker compose up -d`, sağlık kontrolü, (seçildiyse) demo verisi, lisans kapısı doğrulaması ve kod girildiyse etkinleştirme, günlük yedek: Linux'ta systemd zamanlayıcısı/cron (`scripts/backup.sh --compose`), Windows'ta **Muhasebe ERP Yedek** görevi (`docker compose exec db pg_dump`; Docker Desktop o saatte çalışıyor olmalı). Kaplarda günlük döndürme açıktır (json-file, 5 × 10 MB). Windows'ta makine kimliği `ProgramData\MuhasebeERP\host-machine-id` dosyasına yazılıp `ERP_HOST_ID_FILE` ile bağlanır |
| prod / native (Linux) | `/opt/muhasebe-erp/versions/<sürüm>` + `current` bağı, `/etc/muhasebe-erp/erp.env` (640, uygulama) ve `migrate.env` (600, şema sahibi), `muhasebe-erp` sistem kullanıcısı, systemd hizmeti (yoksa `erpctl start|stop|status|logs`; WSL'de systemd'yi açmayı önerir), günlük yedek zamanlayıcısı (varsayılan 02:30, son 14; `/var/backups/muhasebe-erp`, yalnız root; hepsi sorulur), uzaktan güncelleyicinin root'a ait çalışma klasörü `/var/lib/muhasebe-erp-updater`, `erp-setup` kısayolu, isteğe bağlı ufw kuralı |
| prod / native (Windows) | `Program Files\MuhasebeERP\versions\<sürüm>` + `current` bağlantısı (junction), `ProgramData\MuhasebeERP` (yalnız SYSTEM ve Yöneticiler; ayarlar, günlükler, yedekler), **Muhasebe ERP** Windows hizmeti (WinSW; otomatik başlar, çökmede yeniden başlar; LocalService hesabıyla), günlük yedek zamanlanmış görevi (varsayılan 02:30, son 14), isteğe bağlı güvenlik duvarı kuralı, masaüstü kısayolu |

Yeniden çalıştırma = yükseltme: yeni kitin sihirbazı ayarları korur, uygulamayı durdurur, yeni sürümü yan klasöre kopyalar, `current`'ı çevirir, migration'ı uygular, başlatır; migration başarısızsa önceki sürüme döner. **Yükseltmeden önce yedek alın** (`sudo /opt/muhasebe-erp/bin/erp-backup` / `ProgramData\MuhasebeERP` altındaki yedek görevi; Docker: `scripts/backup.sh --compose`).

**Docker kurulum klasörü sabittir.** Docker yolunda kurulum, kitin açıldığı klasördür (`deploy/.env`, `deploy/Caddyfile.local`, `deploy/certs/`, `deploy/wizard.conf`, varsayılan `backups/` burada). Uzaktan güncelleme bu klasörü **yerinde** günceller (program dosyaları değişir, ayarlar/sertifikalar/yedekler taşınmaz); güncellemeden sonra da sihirbazı, yedek betiğini ve `docker compose` komutlarını aynı klasörden çalıştırın. Elle yükseltmede yeni kiti başka bir klasöre açıp oradan `./install.sh` çalıştırırsanız sihirbaz çalışan kurulumu (compose etiketi) bulur, onayınızla ayarları yeni klasöre **taşır**, yedek zamanlayıcısını yeni yola çevirir ve eski klasöre `.erp-tasindi` notu bırakır; o klasördeki sihirbaz artık çalışmaz ve yeni yeri söyler. Eski bir kopyadan (canlı kurulum başka klasördeyken) sihirbaz çalışmaz. Eski sürümlerin güncelleyicisiyle güncellenmiş kurulumlarda canlı klasör `/var/lib/muhasebe-erp/updater/kits/<sürüm>/…` olabilir: `docker compose ls` (CONFIG FILES sütunu) ile bulun.

**Kaldırma.** `./install.sh --uninstall` (Windows `-Uninstall`) programı ve hizmetleri kaldırır, **veriyi korur**: yerelde hizmet, zamanlayıcılar, `/opt/muhasebe-erp`, kısayollar silinir; veritabanı, `/etc/muhasebe-erp` ve yedekler kalır. Docker'da kaplar `docker compose down` ile durdurulur (veritabanı birimi, `deploy/.env` ve yedekler kalır), yedek/güncelleyici zamanlayıcıları silinir. Önce `--dry-run` ile neyin silineceğini görün. `--purge` ayrıca **kalıcı olarak** siler ve terminalde **`SIL` yazarak onay** ister (`--yes` bu onayı vermez; betikten bilerek silmek için `--i-understand-purge` / `-IUnderstandPurge`):

| Yol | `--purge` siler | `--purge` korur |
|---|---|---|
| Linux yerel | Sihirbazın **oluşturduğu** veritabanı (`wizard.conf` → `DB_NAME`, `DB_CREATED`; kurulumdan önce var olan veritabanı silinmez), `erp`/`erp_app` rolleri (başka veritabanı kullanıyorsa korunur; kurulumdan önce varsa silinmez), `/etc/muhasebe-erp`, `/var/lib/muhasebe-erp`, varsayılan yedek klasörü `/var/backups/muhasebe-erp`, `muhasebe-erp` kullanıcısı | Özel yedek klasörü, PostgreSQL programı ve kümesi |
| Windows yerel | Sihirbazın oluşturduğu veritabanı ve roller (aynı kurallar), `ProgramData\MuhasebeERP` (ayarlar, günlükler, varsayılan yedekler) | Özel yedek klasörü, PostgreSQL programı |
| Docker (Linux/Windows) | Compose birimleri (`docker compose down -v`: **veritabanı** ve Caddy sertifika verisi), `deploy/.env`, `Caddyfile.local`, `certs/`, `wizard.conf`, varsayılan `backups/` | Özel yedek klasörü, kit klasörünün program dosyaları, Docker imajları |

**Sürüm kiti üretimi (satıcı):** `LICENSE_SERVER_URL=https://lisans.firma.com npm run release -- --version=1.2.0 [--targets=linux-x64,win-x64] [--out=DİZİN]` → `release/1.2.0/` (ya da `DİZİN/1.2.0/`, göreli/mutlak) altında arşivler ve `SHA256SUMS`. Lisans sunucusu adresi verilmeden kit üretilmez (yalnızca çevrimdışı etkinleştirilecek bir kit için bilerek `--allow-no-license-server`); adres derlemeye gömülür ve `kit.json`'a (`licenseServerUrl`) yazılır. Kitte derlenmiş API + web (kaynak haritası yok), hedef platformun üretim bağımlılıkları (yerel argon2 dahil), resmî Node.js çalışma zamanı, kurulum sihirbazı, Docker yolu dosyaları; Windows kitinde ayrıca WinSW (MIT, sabit SHA-256) ve Docker yolu için Linux bağımlılıkları bulunur. Kitte `dist/demo.js` de bulunur: yalnızca sihirbazın demo sorusuna "evet" denirse ve `ALLOW_DEMO=true` verilerek çalıştırılır (üretimde aksi halde reddedilir). Kit lisanslı derlenir (satıcı açık anahtarı gömülü; [LICENSING.md §5](LICENSING.md)). Kitler şimdilik yalnızca x64'tür.

**Sınamalar:** Linux yerel ve Docker yolları (dev ve prod) Ubuntu 24.04 üzerinde uçtan uca denenmiştir; yapılandırma aşaması (boş/demo kurulum, lisans kapısı, e-posta testi, yeniden yapılandırma, kuru çalıştırma) Linux yerel yolunda sahte bir kitle denenmiştir (Docker/Caddy/HTTPS ve gerçek SMTP sağlayıcısı bu ortamda denenmedi). Windows sihirbazı **Windows'ta çalıştırılarak denenmemiştir**: PowerShell ayrıştırıcısıyla sözdizimi, kitaplık işlevleri (doğrulayıcılar, SMTP adresi, yanıt dosyası, ortam düzenleyici, sertifika denetimi, e-posta sorusu) PowerShell 7 ile Linux'ta sınanmış, Windows PowerShell 5.1 uyumluluğu ise okuyarak denetlenmiştir; gerçek bir Windows makinede ilk kurulumu bu bölüme göre doğrulayın (özellikle PostgreSQL sessiz kurulumu, hizmet hesabı, ACL'ler, UAC ile yeniden başlatma ve yeni sorular). Yanıt dosyası kuralları (bash ve PowerShell aynı dosyalarla), sürüm karşılaştırması, kaldırmanın kuru çalıştırması ve kalıcı silme onayı (bash ve PowerShell), yedek temizliği ve parolanın komut satırında olmaması, üretilen JSON/yedek betiklerinin tırnaklaması taklit yönetici komutlarıyla otomatik sınanır (`apps/api/test/installer-ops.test.ts`); Docker kurulum klasörünün yerinde güncellenmesi ve HTTPS doğrulaması güncelleyicinin birim sınamalarındadır. Gerçek Docker motoruyla yerinde güncelleme/taşıma, Windows'ta Docker yedek görevi (SYSTEM hesabıyla Docker Desktop erişimi) ve EDB kurulum programının `--optionfile` seçeneği bu ortamda **denenmedi**: ilk müşteri kurulumunda doğrulayın.

### Docker Compose ile elle kurulum

Gerekenler: Docker Engine + Compose v2, ≥ 2 GB bellek, kalıcı disk.

```bash
git clone <depo> muhasebe-erp && cd muhasebe-erp
cp deploy/.env.production.example deploy/.env
# Parolaları ve JWT_SECRET'ı doldurun:
#   openssl rand -hex 24     (POSTGRES_PASSWORD, ERP_OWNER_PASSWORD, ERP_APP_PASSWORD)
#   openssl rand -base64 48  (JWT_SECRET)
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build
curl -fsS http://127.0.0.1:3000/api/health/ready
```

Sırayla: `db` sağlıklı olur → `migrate` şemayı kurar/yükseltir ve çıkar → `app` açılır. **Uygulama lisans sunucusuna giden HTTPS erişimi ister** (etkinleştirme ve ~12 saatte bir yenileme; varsayılan `LICENSE_SERVER_URL` imajda gömülüdür). Ana makinenin `/etc/machine-id` dosyası salt-okunur bağlanır (sunucu parmak izi; bkz. §4 ve [LICENSING.md](LICENSING.md)): dosya yoksa `sudo systemd-machine-id-setup` ile oluşturun. `deploy/.env` dosyasını yalnızca yetkili kişi okuyabilmeli (`chmod 600`) ve **yedeklenmelidir** (parolalar olmadan veritabanı geri yüklenemez).

### TLS (otomatik HTTPS)

Alan adı sunucuya yönlenmişse ve 80/443 açıksa:

```bash
# deploy/.env içinde:  ERP_DOMAIN=erp.ornek.com
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env --profile tls up -d
```

Caddy sertifikayı (Let's Encrypt) kendisi alır ve yeniler; `Caddyfile` arka uca `app:3000` ile bağlanır. Bu profil CI'da **otomatik sınanmaz**; ilk kurulumda elle doğrulayın.

Önemli kurallar:

- **Kök yol ve aynı köken:** arayüz ve API aynı alan adında, **kök yolda** (`/`) sunulmalıdır. Alt yol (`/erp/`) desteklenmez (oturum çerezi yolu `/api/auth`, arayüz `/` tabanlıdır).
- **`TRUST_PROXY=loopback,uniquelocal`** (compose varsayılanı) yalnızca **tam bir ters vekil** (Caddy, nginx, cloudflared) arkasında doğrudur: vekilin adresi bu aralıklardadır, gerçek istemci adresi `X-Forwarded-For`'dan okunur. Uygulama **vekilsiz** çalışıyorsa (doğrudan internete ya da LAN'a açık, ör. `APP_BIND=0.0.0.0` ile düz http) `TRUST_PROXY=false` verin; aksi halde `uniquelocal` yerel ağ istemcilerinin `X-Forwarded-For` başlığıyla sahte IP üretmesine izin verir (oran sınırı ve denetim kaydı IP'ye dayanır). **Sayısal atlama değeri (`1`) kabul edilmez**: Fastify ≥ 5.12 onu yok sayar, tüm istekler vekilin adresinden gelmiş görünür ve oran sınırı tek kovaya düşer; uygulama bu değerle açılmayı reddeder.
- **Düz http (TLS'siz LAN) kurulumu:** `COOKIE_SECURE=false` ve istenirse `APP_BIND=0.0.0.0` verin; aksi halde tarayıcı yenileme çerezini atar ve oturum kendiliğinden düşer. İnternete açık kurulumda TLS şarttır.
- Veritabanı portu **yayınlanmaz**; yalnızca uygulama kabı ağ içinden bağlanır.

## 3. Ortam değişkenleri

Geçersiz/eksik değerde uygulama başlamaz ve nedenini yazar. Boş değer "tanımsız" sayılır.

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `DATABASE_URL` | — (zorunlu) | **Çalışma zamanı** rolü (`erp_app`). Sahip rolü buraya konmaz |
| `MIGRATION_DATABASE_URL` | — | Yalnızca `migrate`/`demo` kaplarında: şema sahibi rol (`erp`). Üretimde `DATABASE_URL`'e düşmez |
| `JWT_SECRET` | — (zorunlu) | ≥ 32 karakter. Üretimde `example`, `change-me`, `secret-secret`, `password` gibi örnek kalıplar **reddedilir**. Personel kimlik/doğum tarihi/IBAN alanlarının şifreleme anahtarı da bundan türetilir: **değiştirirseniz bu alanlar okunamaz**; döndürme için önce yeniden şifreleme gerekir |
| `NODE_ENV` | `development` | İmajda `production` |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `TRUST_PROXY` | `false` (compose: `loopback,uniquelocal`) | `false`, `true` ya da vekil adresi listesi (CIDR ya da `loopback`, `linklocal`, `uniquelocal`). Sayı (`1`) **reddedilir** |
| `COOKIE_SECURE` | production'da `true` | Yenileme çerezi `Secure`; düz http'de `false` |
| `REGISTRATION_ENABLED` | `true` | `false`: `POST /api/auth/register` → 403 (özel kurulumda ilk kayıttan sonra kapatın) |
| `CORS_ORIGIN` | üretimde boş | Aynı kökende gerekmez; yalnızca ayrı kökenli arayüz için |
| `SESSION_MAX_DAYS` | `90` | Yenilemeyle uzasa da oturumun mutlak ömrü |
| `ACCESS_TOKEN_TTL_SECONDS` / `REFRESH_TOKEN_TTL_DAYS` | `900` / `30` | |
| `RATE_LIMIT_ENABLED` | `true` | Yalnızca testlerde kapatılır |
| `LOG_LEVEL` | `info` | pino: `fatal…trace`, `silent` |
| `DB_POOL_MAX` | `20` | Bağlantı havuzu üst sınırı. PostgreSQL `max_connections` (varsayılan 100) değerini aşmayın; havuz doluyken bağlantı `DB_CONNECT_TIMEOUT_MS` içinde boşalmazsa istek **503 `BUSY`** + `Retry-After` alır (arayüz okuma isteklerini bir kez yeniden dener). Sık 503 görülürse artırın |
| `DB_CONNECT_TIMEOUT_MS` | `5000` | Havuzdan bağlantı bekleme üst süresi |
| `DB_STATEMENT_TIMEOUT_MS` | `60000` | Tek SQL ifadesi üst süresi; `0` kapalı |
| `EXPORT_CONCURRENCY` | `2` | Eşzamanlı (bellek içi) dışa aktarma sayısı; fazlası `429 EXPORT_BUSY` |
| `SHUTDOWN_TIMEOUT_MS` | `20000` | Kapanışta bekleme süresi |
| `SMTP_URL` | yok | Örn. `smtps://kullanici:parola@smtp.ornek.com:465`. Verilirse parola sıfırlama ve e-posta doğrulama **açılır**; TLS sertifikası doğrulanır |
| `MAIL_FROM` | yok | `SMTP_URL` ile birlikte zorunlu: `"Muhasebe ERP <no-reply@ornek.com>"` |
| `APP_BASE_URL` | yok | E-postalardaki bağlantı kökü (`https://erp.ornek.com`); posta açıkken zorunlu |
| `MAIL_TRANSPORT` | yok | `log` yalnızca geliştirme (bağlantıyı günlüğe yazar); **üretimde reddedilir** |
| `NOTIFY_ENABLED` | `true` | Bildirim zamanlayıcısı (§9b). `false`: otomatik tarama durur (elle tarama ve mevcut bildirimler çalışır) |
| `NOTIFY_INTERVAL_MINUTES` | `30` | Tarama aralığı (1–1440 dk). Bildirimler ve hatırlatmalar en çok bu kadar gecikir |
| `NOTIFY_RETENTION_DAYS` | `90` | Okunmuş/kapatılmış/çözülmüş bildirimlerin saklama süresi (7–3650 gün); açık bildirim silinmez |
| `NOTIFY_DIGEST_HOUR` | `8` | E-posta özetinin gönderileceği ilk yerel saat (Europe/Nicosia, 0–23); yalnızca SMTP açıkken ve kullanıcı istediyse |
| `WEB_DIST_DIR` | imajda `/app/web` | Derlenmiş arayüz klasörü |
| `APP_VERSION` | `dev` | İmaj derlemesinde verilir; `/api/public-config` döndürür |
| `LICENSE_SERVER_URL` | imaja gömülü | Lisans sunucusu adresi (yalnızca `https`); verilirse derlemede gömülü varsayılanın yerine geçer. Normalde boş bırakılır: satıcı imajı derlerken belirler |
| `LICENSE_HOST_ID_FILE` | `/etc/host-machine-id` | Ana makine kimliği dosyası (compose bağlar); sunucu parmak izinin parçası |
| `LICENSE_ALLOW_INSECURE_URL` | `false` | Yalnızca test düzenekleri (`http://` lisans sunucusu); **müşteri kurulumunda kullanılmaz** |
| `LICENSE_ENFORCEMENT_DEV`, `LICENSE_DEV_KEYRING` | yok | Yalnızca `NODE_ENV≠production` (geliştirme/e2e); üretimde **reddedilir**. Üretim paketinde lisans denetimi **derleme zamanı sabitidir**, ortam değişkeniyle kapatılamaz |
| `ERP_UPDATER_TOKEN` | yok | Uzaktan güncelleme: ana makinedeki güncelleyiciyle paylaşılan belirteç (≥ 32 karakter; sihirbaz üretir). Yoksa güncelleyici uçları kapalıdır |
| `ERP_KIT_TARGET` | yok | `linux-x64` / `win-x64`: kurulum kitinin hedefi (sihirbaz yazar); kalp atışında satıcıya bildirilir, güncelleme arşivini seçer |
| `ALLOW_DEMO` | yok | Yalnızca demo örneğinde `true` (bkz. §8); müşteri kurulumunda **asla** |

**Compose düzeyi değişkenler** (`deploy/.env`; kurulum sihirbazı yazar, uygulama kabına geçmez):

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `APP_BIND` / `APP_PORT` | `127.0.0.1` / `3000` | Uygulamanın ana makinedeki dinleme adresi/portu (`0.0.0.0` = yerel ağ, yalnız TLS'siz LAN) |
| `ERP_DOMAIN` | yok | Doluysa `tls` profili (Caddy) çalışır; HTTPS'in alan adı/adresi |
| `ERP_CADDYFILE` | `./Caddyfile` | Caddy yapılandırması; sihirbaz `./Caddyfile.local` üretir ve buraya yazar |
| `ERP_CERT_DIR` | `./certs` | Kendi sertifikanız/kendi imzalı için `fullchain.pem` + `privkey.pem` klasörü (Caddy'ye salt-okunur bağlanır) |
| `HTTP_PORT` / `HTTPS_PORT` | `80` / `443` | Caddy'nin ana makinedeki portları |

Bu dosyaları elle yazmak zorunda değilsiniz: `./install.sh --reconfigure` hepsini sorar ve atomik yazar (§2). `SMTP_URL` ve `MAIL_FROM` için sihirbaz yüzde-kodlama yapar (`@ $ / ! ' ( ) * % #` içeren parolalar güvenle yazılır).

Compose dikkat: kabuk ortam değişkenleri `--env-file` değerlerinden **önceliklidir**; kabukta eski bir `JWT_SECRET` tanımlıysa dosyadaki değer yok sayılır.

## 4. İlk kiracı ve kullanıcılar

- **Özel (tek müşteri) kurulum:** arayüzü açın, **bir kez** kayıt olun (kuruluş + şirket + sahip), ardından `deploy/.env` içinde `REGISTRATION_ENABLED=false` yapıp `docker compose … up -d app` ile kapıyı kapatın. Diğer kullanıcıları sahip/yönetici **Ayarlar > Kullanıcılar**'dan ekler (geçici parola verir; kullanıcı ilk girişte kendi parolasını seçmek zorundadır).
- **Barındırılan çok kiracılı kurulum:** `REGISTRATION_ENABLED=true` bırakılır; her kayıt kendi kuruluşunu açar ve veri PostgreSQL **Row-Level Security** ile yalıtılır. Kötüye kullanıma karşı kayıt/giriş uçları IP ve e-posta başına oran sınırlıdır; yine de bir ters vekil/WAF ve SMTP doğrulaması önerilir.
- **Parola kurtarma:** SMTP açıksa kullanıcı "Şifremi unuttum" ile sıfırlar. SMTP kapalıysa operatör, geçici parola üretir (oturumlar kapanır, ilk girişte parola değişimi zorunlu olur):

  ```bash
  # Docker (kurulum klasöründe)
  docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env exec app \
    node dist/admin.js reset-password --email=kisi@ornek.com
  # Linux yerel (Docker'sız)
  sudo /opt/muhasebe-erp/current/app/runtime/node --env-file=/etc/muhasebe-erp/erp.env \
    /opt/muhasebe-erp/current/app/dist/admin.js reset-password --email=kisi@ornek.com
  ```

  ```powershell
  # Windows yerel (yönetici PowerShell)
  & "$env:ProgramFiles\MuhasebeERP\current\app\runtime\node.exe" --env-file="$env:ProgramData\MuhasebeERP\erp.env" `
    "$env:ProgramFiles\MuhasebeERP\current\app\dist\admin.js" reset-password --email=kisi@ornek.com
  ```

  Komut çalışma zamanı rolüyle (`DATABASE_URL`) çalışır; şema sahibi parolası gerekmez. Geçici parola yalnızca komut çıktısında görünür; kullanıcıya güvenli bir kanaldan iletin. İşlem `security_events` tablosuna `via: operator-cli` imzasıyla yazılır.
- **Lisans etkinleştirme:** lisanssız kurulumda tarayıcı yalnızca **Lisans etkinleştirme** sayfasını gösterir; satıcıdan aldığınız kodu (`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`) girin. Sunucu internete çıkamıyorsa aynı sayfada **çevrimdışı etkinleştirme** ile "istek kodu" üretip satıcıya gönderin, dönen lisans kodunu yapıştırın. Sonra ilk sahip kaydı yapılır. Durum ve kullanım **Ayarlar > Lisans**'tadır (yalnızca sahip); ayrıntı için [LICENSING.md §9](LICENSING.md).
- **Cihaz koltukları:** her kayıtlı tarayıcı/bilgisayar lisansın cihaz kotasından bir koltuk tutar; kota dolunca yeni cihaz giremez. Sahip/yönetici **Ayarlar > Cihazlar**'dan listeler, adlandırır, kaldırır; 30 gün kullanılmayan cihaz koltuğunu bırakır. Kota dolduğu için **kimse giremiyorsa** operatör kurtarma komutu:

  ```bash
  docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env exec app node dist/admin.js devices
  docker compose … exec app node dist/admin.js devices:revoke --id=<kimlik|ön ek>
  docker compose … exec app node dist/admin.js devices:revoke-all --yes      # herkes yeniden giriş yapar
  # Linux yerel: aynı komutlar ("node dist/admin.js" yerine)
  sudo /opt/muhasebe-erp/current/app/runtime/node --env-file=/etc/muhasebe-erp/erp.env /opt/muhasebe-erp/current/app/dist/admin.js devices
  ```

  Windows yerelde parola sıfırlamadaki `node.exe … admin.js` satırının sonuna `devices`, `devices:revoke --id=…` ya da `devices:revoke-all --yes` yazın.
- Rol değişiklikleri: `owner` rolünü yalnızca sahip verir/alır; son sahip düşürülemez.
- **Yeni şirket ve kurulum yönetimi:** yeni şirketi yalnızca mevcut bir şirketin sahibi/yöneticisi açar. Lisans, uzaktan güncelleme ve cihaz yönetimi **kurulumun sahibi kuruluşa** aittir (ilk şirketi açan kuruluş; yükseltilen kurulumlarda en eski şirketin kuruluşu). Açık kayıtla (`REGISTRATION_ENABLED=true`) gelen başka bir kuruluş bunları yönetemez ama kendi ilk şirketini açabilir (lisans şirket sınırından düşer) — özel kurulumda kaydı kapatın. Sahip kuruluşu değiştirmek gerekirse (ör. yanlış kuruluş sabitlendi) şema sahibi rolle:

  ```sql
  -- psql "$MIGRATION_DATABASE_URL"
  UPDATE license_state SET owner_org_id = (SELECT organization_id FROM users WHERE email = 'sahip@ornek.com') WHERE id = 1;
  ```
- **Üye işlemleri:** başka şirketlerde de üyeliği olan kullanıcının iki adımlı doğrulamasını sıfırlamak ya da mevcut bir kullanıcıyı şirkete eklemek, işlemi yapanın o kullanıcının üye olduğu her şirkette en az onun rütbesinde sahip/yönetici olmasını ister (`MEMBER_OUTRANKS_YOU`); gerekirse ilgili şirketin sahibi yapar.
- **Çıkış ve parola değişikliği** açık oturumların erişim belirteçlerini de hemen geçersiz kılar (diğer sekmeler/cihazlar yeniden giriş ister).

### 4b. Kullanıcı bazlı modül erişimi (sahip/yönetici)

Rol herkesin varsayılan yetkisidir; bir kullanıcının belirli bir modülde farklı davranmasını istiyorsanız Ayarlar > **Kullanıcılar ve yetkiler** sayfasında kullanıcının satırındaki **Modül erişimi** düğmesini kullanın. Her modül için: *Rol varsayılanı* (hiçbir şey değişmez), *Erişim yok* (menüden kalkar, adres yetki ekranı gösterir, işlemler reddedilir), *Sadece görüntüle* (liste ve ayrıntıyı görür; ekle/düzenle/kaydet/onayla yok) ya da *Görüntüle ve düzenle* (rolün izin vermediği modülde bile kayıt açabilir). Kaydetmeden önce değişiklik özeti onay ister; değişiklik kullanıcının bir sonraki isteğinde hemen geçerlidir (oturumu kapatması gerekmez). Kullanıcı listesinde özel erişimi olanlar **Özel erişim** rozetiyle işaretlenir; "Etkin erişim" sekmesi sonucu gösterir; "Tümünü rol varsayılanına döndür" hepsini sıfırlar.

- **Kimler yönetir:** sahipler herkesin (sahipler hariç), yöneticiler yalnızca yönetici olmayan üyelerin erişimini değiştirir. Kimse kendi erişimini değiştiremez; sahibin erişimi kısıtlanamaz; yönetici kendinde olmayan bir yetkiyi başkasına veremez. Kullanıcı bu düğmeyi görmüyorsa kural gereği değiştiremiyordur.
- **Her zaman role bağlı olanlar** (buradan verilemez): şirket ve üye yönetimi, ayarlar, yıl sonu kapanışı, konsolidasyon, hassas personel verisi (kimlik no, IBAN) ve veri koruma yönetimi, verileri dışa aktarma. Personel modülünü "Görüntüle ve düzenle" yapmak hassas veri görme yetkisi vermez; bordro ayrı bir modüldür.
- **Rol değiştirilirse** üyenin özel erişim ayarları silinir ve yeni rolün varsayılanı geçerli olur (yanıtta ve ekranda kaç ayarın silindiği bildirilir). Üye şirketten çıkarılırsa da silinir; yeniden eklenirse eski ayarlar geri gelmez. Özel erişimi olan bir üye kendi rolünü değiştiremez; özel erişimi olan yöneticinin rolünü yalnızca sahip değiştirir (kısıt, rol değiştirerek aşılamasın diye).
- **Menüde görünen bazı modüller birlikte yönetilir:** çek/senet, teminat mektubu ve gider kartları "Kasa ve banka" ile; satış teklif/sipariş ve fiyat listeleri "Fatura ve irsaliye" ile; yabancı işçi takibi "Personel" ile; personel cari ve sosyal güvenlik "Bordro" ile. Raporlar muhasebe alanına bağlıdır ("Muhasebe" erişim yok ise raporlar da kapanır).
- **İzleme:** her değişiklik denetim kaydına (`audit_log`, tablo `member_module_access`) ve güvenlik olaylarına (`member_module_access_changed`) yazılır:

  ```sql
  select at, user_id as hedef, meta->>'by' as yapan, meta->'changes' as degisiklik
    from security_events where event = 'member_module_access_changed' order by at desc limit 100;
  ```

  Bir kullanıcıya erişim sorunuyla gelinirse API yanıt kodlarına bakın: `MODULE_ACCESS_DENIED` (modül yönetici tarafından kapatıldı), `MODULE_READ_ONLY` (yalnızca görüntüleme), `MODULE_DISABLED` (modül şirketçe kapalı), `FORBIDDEN` (rolün yetkisi yok).

## 5. Yükseltme

### Uzaktan güncelleme (sihirbazla kurulmuş müşteri kurulumları)

Satıcı yeni sürümü lisans panelinden **gönderir**; müşteride **kurulum sahibi onaylar**; ana makinedeki güncelleyici uygular.

1. Uygulama kalp atışında (yaklaşık 12 saatte bir; **Ayarlar > Lisans > Yazılım güncellemesi > Güncellemeleri denetle** ile hemen) satıcının imzalı sürüm manifestosunu alır ve gömülü satıcı anahtarıyla doğrular. Sahte/bozuk teklif yok sayılır.
2. Sahip aynı kartta sürüm notunu görür: **Şimdi güncelle** ya da **Bu gece güncelle (02:00, sunucu saati)**. Onay `security_events`'e yazılır (`update_requested`).
3. Güncelleyici (Linux: `muhasebe-erp-updater.timer`, dakikada bir; Windows: **Muhasebe ERP Güncelleyici** zamanlanmış görevi, SYSTEM) onaylı işi alır: kiti lisans sunucusundan kısa ömürlü, kuruluma özel bir belirteçle indirir, **SHA-256 ve boyutu** manifestoyla karşılaştırır, **yedek alır** (yedek alınamazsa güncelleme yapılmaz), kiti açar ve **yeni kitin kurulum sihirbazını** etkileşimsiz çalıştırır (durdurma, yan klasöre kopyalama, migration, başlatma, sağlık). Uygulama yeni sürümle yanıt verince durum **Tamamlandı** olur.
4. **Başarısızlıkta:** migration tek işlemde çalıştığından migration hatası veritabanını değiştirmez; eski sürüm çalışmaya devam eder → **Başarısız**. Yeni sürüm migration sonrası ayağa kalkmazsa güncelleyici **önceki sürümün sihirbazını yedekten veritabanı geri yüklemesiyle** çalıştırır → **Geri alındı** (güncelleme sonrası girilen veri yoktur, çünkü uygulama kapalıydı). İkisi de olmazsa durum ve yedeğin yolu günlükte kalır; §6'ya göre elle geri yükleyin.
   Güncelleyicinin durum bildirimi (`POST /api/system/updater/report`) lisans salt-okunur moddayken de kabul edilir; sonuç (başarısız/geri alındı) böylece kaydedilir. Bildirim yine de gidemezse aynı güncelleme her dakika baştan denenmez: en çok 3 deneme yapılır (aralarında 15 dk ve 1 saat beklenir), sonra **Başarısız** bildirilir; sahip yeniden onaylayabilir.
5. HTTPS (Caddy) yapılandırılmış Docker kurulumunda "Tamamlandı" demeden önce uygulamanın **HTTPS üzerinden** de yanıt verdiği doğrulanır (`https://127.0.0.1:<HTTPS portu>`, alan adı SNI ile); yanıt yoksa durum **Başarısız** olur ve iletide nedeni yazar.

Gereksinimler ve notlar:

- Docker'lı ve Docker'sız kurulumlarda çalışır. Docker'da yedek `pg_dump` kap içinde alınır ve **kurulum klasörü değişmez**: yeni kitin program dosyaları kurulum klasörüne yerinde konur (eskileri geri dönüş için `…/kits/<eski sürüm>-onceki` altında saklanır), `deploy/.env`, `Caddyfile.local`, `certs/`, `wizard.conf` ve `backups/` yerinde kalır; imaj sürüm etiketlidir (`muhasebe-erp:<sürüm>`), aynı compose projesi ve birimler kullanılır. Güncellemeden sonra da kurulum klasörünüz aynıdır (§2 "Docker kurulum klasörü sabittir").
- Sürüm düşürme yapılmaz: daha eski ya da aynı sürüm teklifi saklanmaz, onaylanamaz (`UPDATE_NOT_NEWER`) ve güncelleyici eski sürümü kurmaz.
- Güncelleme öncesi Docker dökümlerinden (`erp-oncesi-*.dump`) yalnızca son 3'ü saklanır.
- Linux'ta **systemd** gerekir; yoksa (ör. systemd kapalı WSL) onaylanan güncellemeyi `sudo erp-update` çalıştırır.
- Günlük: Linux `/var/lib/muhasebe-erp-updater/updater.log` (yalnız root; eski kurulumlardaki `/var/lib/muhasebe-erp/updater` — hizmet kullanıcısının klasörü — sihirbaz yeniden çalışınca buraya taşınır), Windows `C:\ProgramData\MuhasebeERP\updater-work\updater.log`. Ayar: `/etc/muhasebe-erp/updater.json` / `C:\ProgramData\MuhasebeERP\updater.json`. Kilit dosyası, sahibi süreç yaşıyorsa (en çok 6 saat) geçerlidir; süreç ölmüşse hemen bırakılır.
- Uygulama ile güncelleyici, sihirbazın ürettiği `ERP_UPDATER_TOKEN` ile konuşur (ayar dosyasında; yoksa uzaktan güncelleme kapalıdır, uçlar 401 döner). Kalp atışında satıcıya ayrıca kit hedefi (`linux-x64`/`win-x64`) gönderilir; başka veri gönderilmez.
- Elle (sihirbazsız) kurulumlarda teklif yine görünür ama onay düğmesi yerine "yeni kiti indirip sihirbazla güncelleyin" uyarısı çıkar.

### Elle yükseltme

```bash
scripts/backup.sh --compose                      # 1) yedek al
git pull                                         # 2) yeni sürüm (ya da yeni imaj etiketi: ERP_IMAGE)
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build
curl -fsS http://127.0.0.1:3000/api/health/ready # 3) doğrula, bir oturum açma denemesi yap
```

`up -d` önce `migrate` kabını çalıştırır (yalnızca bekleyen migration'lar uygulanır), ardından uygulamayı yeniden başlatır; uygulama kapanırken süren istekleri `SHUTDOWN_TIMEOUT_MS`'e kadar bitirir.

**Lisanslama öncesi bir sürümden yükseltme:** ilk lisanslı imaja geçişte mevcut kurulum **lisanssız** (yalnızca etkinleştirme ekranı) açılır; veriler bozulmaz ve silinmez. Müşteri lisans kodunu girene kadar giriş/yazma kapalıdır: geçişi önceden planlayın, kodu hazır edin. Lisans süresi dolar ya da lisans sunucusuna ulaşılamazsa uygulama **salt-okunur** moda düşer (veri görüntülenir ve dışa aktarılır, yazma kilitlenir); ayrıntı [LICENSING.md §7](LICENSING.md).

**Faz B1 (şantiye projeleri) yükseltmesi:** `0023_projects` / `0024_projects_rls_rules` migration'ları beş yeni tablo ve `journal_lines`, `stock_movements`, `invoice_lines` üzerinde **boş (nullable) proje/iş kalemi sütunları** ekler; mevcut veriler değişmez, hiçbir kayıtta proje zorunlu olmaz. `construction.projects` modülü inşaat şirketlerinde kendiliğinden açılır (Ayarlar > Modüller'den kapatılabilir; kullanılmayan şirkette menüde "Şantiye" grubu görünmez). Yeni ortam değişkeni ya da bağımlılık yoktur. Yedekten geri yükleme ve yük özellikleri değişmez; `restore-drill` yeni tabloları da kapsar.

**Geri dönüş:** migration'lar ileri yönlüdür. Yükseltme başarısız olursa eski imaja dönüp (`ERP_IMAGE=<eski>`) **yedeği geri yükleyin** (§6, `--recreate`). Bu yüzden yükseltmeden önce yedek şarttır.

## 6. Yedekleme ve geri yükleme

### Yedek

> **Yıl sonu kapanışından önce mutlaka yedek alın.** Kapanış fişleri ve dönem kilidi geri açma akışıyla geri alınabilir ama bu yöntem mali müşavirce doğrulanmamıştır (LEGAL-NOTES §23); önce yedek, sonra kapanış.

```bash
scripts/backup.sh --compose                       # deploy/.env'den okur; ./backups/ altına yazar
scripts/backup.sh --compose --dir /var/backups/erp --keep-days 30
MIGRATION_DATABASE_URL=postgres://erp:…@host/erp scripts/backup.sh   # doğrudan kip (compose dışı)
```

Bir `pg_dump -Fc` dökümü üretir: **tüm şirketlerin verisi**, erişim izinleri (GRANT) ve migration geçmişi dökümdedir. Betik kısmi dosya bırakmaz (önce geçici dosyaya yazar, `pg_restore --list` ile arşivi doğrular, sonra adlandırır), `sha256` özetini yanına yazar ve yalnızca **kendi adlandırdığı** `erp-<veritabanı>-<YYYYMMDDTHHMMSSZ>.dump` dosyalarını temizler (`--keep-days N`: N günden eski; `--keep-count N`: en yeni N, en az 1; aynı klasördeki başka dosyalara dokunmaz). Parola komut satırına yazılmaz (compose: kap içi yerel soket; doğrudan kip: `PG*` ortam değişkenleri). Dizin yalnızca sahibine açıktır (0700).

Sihirbazla kurulan sistemlerde günlük yedek **zaten kuruludur** (Linux: `muhasebe-erp-backup.timer` ya da `/etc/cron.d/muhasebe-erp-backup`; Windows: **Muhasebe ERP Yedek** görevi). Elle kurulan Docker sisteminde cron örneği (her gece 02:15; `cd` hedefi `deploy/` klasörünü içeren **kurulum klasörüdür**, ör. kitin açıldığı yer — `/opt/muhasebe-erp` değil):

```cron
15 2 * * * cd /srv/muhasebe-erp-1.2.0-linux-x64 && bash scripts/backup.sh --compose --dir /var/backups/erp --keep-count 14 >> /var/log/erp-backup.log 2>&1
```

Yerel (Docker'sız) Linux kurulumunda yedek komutu `sudo /opt/muhasebe-erp/bin/erp-backup`'tır (yedekler `/var/backups/muhasebe-erp`); Windows yerelde `powershell -ExecutionPolicy Bypass -File "C:\Program Files\MuhasebeERP\bin\erp-backup.ps1"`, Windows Docker'da `…\ProgramData\MuhasebeERP\bin\erp-backup-docker.ps1` (Docker Desktop çalışıyor olmalı).

**Yedek dosyası müşteri verisidir.** (1) Başka bir makineye/ofis dışına kopyalayın (rclone, rsync, nesne depolama); (2) şifreleyin (`age` ya da `gpg`); (3) `deploy/.env` dosyasını ayrıca saklayın. Aynı diske alınan yedek, disk arızasına karşı yedek değildir.

### Geri yükleme

Hedef veritabanı **boş** olmalıdır; betik dolu bir veritabanının üzerine yazmaz. Roller (`erp`, `erp_app`) küme genelindedir ve dökümde yoktur: hedef sunucuda önceden var olmalıdır (`init-prod.sh` ya da `infra/postgres/init.sql`). PostgreSQL ana sürümü, yedeği alan sunucuyla **aynı ya da daha yeni** olmalıdır.

```bash
# Felaket kurtarma (compose): uygulamayı durdurur, veritabanını SİLİP yeniden yaratır, geri yükler
scripts/restore.sh --compose --recreate --yes /var/backups/erp/erp-erp-20260930T021500Z.dump
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d app

# Başka bir boş veritabanına (deneme / inceleme): önce boş veritabanı yaratılır
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env exec db \
  psql -U postgres -c 'CREATE DATABASE erp_inceleme OWNER erp'
scripts/restore.sh --compose --target-db erp_inceleme yedek.dump

# Doğrudan kip
RESTORE_DATABASE_URL=postgres://erp:…@host/BOS_VERITABANI scripts/restore.sh yedek.dump
```

Geri yükleme tek işlemde çalışır; hata olursa hedefte yarım veri kalmaz. Sonrasında `/api/health/ready` ve bir oturum açma ile doğrulayın.

**Yerel (Docker'sız) kurulumda geri yükleme.** Yedekler `/var/backups/muhasebe-erp` (Linux; eski kurulumlarda `/var/lib/muhasebe-erp/backups`) ya da `C:\ProgramData\MuhasebeERP\backups` (Windows) altındadır; `scripts/restore.sh` yerel kuruluma kopyalanmaz. En kolay ve önerilen yol, kurulu sürümün sihirbazının yerleşik geri yüklemesidir: hizmeti durdurur, veritabanını **silip** `erp` sahibiyle yeniden yaratır, yedeği tek işlemde yükler, migration'ı uygular ve başlatır (parola komut satırına yazılmaz):

```bash
# Linux (yönetici): yedek, kurulu sürümle aynı ya da daha eski bir sürümden alınmış olmalı
sudo erp-setup --yes --restore-db=/var/backups/muhasebe-erp/erp-20260930-023000.dump
```

```powershell
# Windows (yönetici PowerShell)
powershell -ExecutionPolicy Bypass -File "$env:ProgramFiles\MuhasebeERP\current\installer\install.ps1" -Yes -RestoreDb "C:\ProgramData\MuhasebeERP\backups\erp-20260930-023000.dump"
```

(PostgreSQL'i sihirbaz kurmadıysa süper kullanıcı parolası istenir: `-PgSuperPasswordFile <parolayı içeren dosya>`; dosya okunduktan sonra silinir.)

Elle yapmak isterseniz: hizmeti durdurun (`sudo erpctl stop` / `services.msc` → Muhasebe ERP), süper kullanıcıyla (`sudo -u postgres psql`; Windows: `psql -U postgres`) `DROP DATABASE erp WITH (FORCE); CREATE DATABASE erp OWNER erp; REVOKE ALL ON DATABASE erp FROM PUBLIC; GRANT CONNECT ON DATABASE erp TO erp_app;`, ardından şema sahibiyle `pg_restore --exit-on-error --single-transaction --no-owner --role=erp -d erp yedek.dump` (bağlantı bilgileri `migrate.env`'deki adresten: Linux'ta `sudo` ile `PGHOST=127.0.0.1 PGUSER=erp PGPASSWORD=… /usr/lib/postgresql/16/bin/pg_restore …`; Windows'ta `C:\Program Files\PostgreSQL\16\bin\pg_restore.exe`, parolayı `$env:PGPASSWORD` ile verin, komut satırına yazmayın) ve hizmeti başlatın (`sudo erpctl start`).

**Lisans ve başka sunucuya geri yükleme.** Lisans, sunucu parmak izine (ana makine kimliği + PostgreSQL **küme** kimliği) bağlıdır. Yedeği **aynı** kümeye geri yüklemek lisansı etkilemez. **Başka bir PostgreSQL kümesine** (yeni sunucu, yeniden kurulan PostgreSQL, Docker birimi silinip yeniden yaratılmış veritabanı) geri yüklerseniz parmak izi değişir ve uygulama **salt-okunur** açılır (veriler görünür, yazma kapalı). Açmak için: (1) mümkünse eski sunucuda **Ayarlar › Lisans › Bu sunucuda lisansı kaldır**; (2) yeni sunucuda **Ayarlar › Lisans**'tan **aynı lisans koduyla yeniden etkinleştirin** (internet yoksa çevrimdışı etkinleştirme); (3) eski sunucuya erişilemiyorsa satıcıdan ilgili etkinleştirmeyi devre dışı bırakmasını isteyin ([LICENSING.md §6](LICENSING.md) "Sunucu taşıma").

### Tatbikat: "yedeğim gerçekten geri yüklenir mi?"

```bash
scripts/restore-drill.sh
```

Geçici veritabanlarında demo veriyle kaynak kurar, yedek alır, taze veritabanına geri yükler ve şunları **karşılaştırır**: tüm tablo satır sayıları, defter/stok veri parmak izleri, yapı parmak izleri (tetikleyiciler, RLS politikaları ve bayrakları, fonksiyonlar, `erp_app` yetkileri); `erp_app` ile RLS davranışını (bağlamsız görünürlük 0, doğru bağlamda görünür, başka şirkette 0) ve değiştirilemezlik tetikleyicilerinin (defter ERP01, denetim kaydı ERP07) çalıştığını doğrular; en sonda **kendi negatif kontrolünü** yapar (bir satır silinince ve RLS kapatılınca karşılaştırmanın kırıldığını kanıtlar; değilse `exit 2`). CI'da her itmede çalışır. Gerçek müşteri yedeğiniz için üç ayda bir, hazırlık makinesinde `restore.sh --target-db` ile elle bir geri yükleme denemesi yapın ve sonucu kaydedin.

## 7. İzleme ve günlükler

- **Canlılık:** `GET /api/health` (süreç ayakta). **Hazırlık:** `GET /api/health/ready` (veritabanına `select 1`; hata → 503). Bir çalışma süresi izleyicisini (UptimeRobot, Uptime Kuma vb.) `ready` adresine yöneltin. İmajın `HEALTHCHECK`'i de `ready`'yi kullanır.
- **Günlükler:** JSON (pino), `docker compose … logs -f app`. `authorization` ve `cookie` başlıkları günlükte **gizlenir**; her istekte istek kimliği vardır. Hata yanıtlarındaki `error.code` destek için anahtardır.
- **Sürüm:** `GET /api/public-config` → `{version, registrationEnabled, mailEnabled}`.
- **Disk:** yedekler ve PostgreSQL hacmi için disk doluluk uyarısı kurun. Denetim kaydı (`audit_log`) her yazma işleminde büyür.
- **Tek örnek varsayımı:** oran sınırı sayaçları **bellektedir**; uygulama tek örnek çalışır (yatay ölçekleme için paylaşılan depo sonraya). Yük ölçümü için bkz. PERFORMANCE.md.

### Destek sorguları (`security_events`)

Şema sahibi rolle: `docker compose … exec db psql -U erp erp`. Kayıt yalnız-ekleme türündedir; parola/jeton içermez.

```sql
-- Son başarısız girişler
select at, email, ip from security_events where event = 'login_failed' order by at desc limit 50;
-- Bir IP'den son saatteki başarısız giriş sayısı (kaba kuvvet şüphesi)
select ip, count(*) from security_events
 where event = 'login_failed' and at > now() - interval '1 hour' group by ip order by 2 desc limit 20;
-- Yenileme jetonu yeniden kullanımı (çalıntı oturum şüphesi; ilgili oturum ailesi kapatılır)
select at, email, ip, meta from security_events where event = 'refresh_reuse_detected' order by at desc limit 50;
-- Bir kullanıcının olayları
select at, event, ip, meta from security_events where email = 'kisi@ornek.com' order by at desc limit 100;
-- Rol/üyelik değişiklikleri
select at, email, event, meta from security_events
 where event in ('member_added','member_role_changed','member_removed','member_module_access_changed') order by at desc limit 100;
-- Parola sıfırlamaları (operatör komutu via=operator-cli imzalıdır)
select at, email, meta from security_events where event like 'password_reset%' order by at desc limit 50;
```

Olay adları: `login_succeeded`, `login_failed`, `password_changed`, `password_reset_requested`, `password_reset_completed`, `email_verified`, `refresh_reuse_detected`, `member_added`, `member_role_changed`, `member_removed`, `member_module_access_changed`.

`audit_log` (hangi satırı kim/ne zaman değiştirdi) şirket bazlıdır ve **sahip rolüne karşı bile** yalnız-ekleme tetikleyicisiyle (ERP07) korunur. Şişmesi sorun olursa budamak bilinçli bir operatör kararıdır: tetikleyici geçici olarak devre dışı bırakılmalıdır (`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`, işlem sonrası yeniden etkinleştirilir). **Kaç yıl saklanması gerektiği doğrulanmamıştır** (LEGAL-NOTES §5); mali müşavir/avukatla teyit etmeden silmeyin.

## 8. Demo örneği

Satış gösterimi için **müşteri kurulumundan ayrı** bir örnek. Demo kullanıcı bilgileri herkesçe bilinir (`demo@ornek.local` / `Demo-Sifre-123`): bu örneğe gerçek müşteri verisi girmeyin ve müşterinin üretim sunucusunda çalıştırmayın. Uygulama içinde "demo verisi yükle" düğmesi yoktur (şirket silinemediğinden kalıcı kalırdı).

```bash
cp deploy/.env.production.example deploy/.env.demo     # ERP_DB_NAME=erp_demo önerilir; parolaları doldurun
docker compose -f deploy/docker-compose.demo.yml --env-file deploy/.env.demo up -d app
# http://127.0.0.1:3001  (APP_PORT)
```

Ayrı proje adı ve veritabanı hacmi kullanır; kayıt kapalıdır. Demo örneği de **lisanslıdır**: satıcıdan bir `demo` türü (kısa süreli) lisans alıp etkinleştirin; demo sıfırlama (`demo-reset`) **lisans durumunu korur** (yalnızca iş verisini sıfırlar), böylece her hafta yeniden etkinleştirmek gerekmez. `demo-seed` kabı demo veriyi **yalnızca yoksa** yükler (yeniden başlatmak veriyi sıfırlamaz). Demo veri "bugün"e göre üretilir ve eskir: **haftalık sıfırlayın**:

```bash
D="docker compose -f deploy/docker-compose.demo.yml --env-file deploy/.env.demo"
$D stop app && $D run --rm demo-reset && $D up -d app
```

`demo-reset` veritabanındaki **tüm veriyi siler**, migration'ları uygular ve demo veriyi yeniden yükler; `--confirm=<veritabanı adı>` ister. `node dist/demo.js` üretim modunda yalnızca `ALLOW_DEMO=true` ile çalışır: bir müşteri kurulumunda yanlışlıkla çalıştırılamaz. Geliştirmede aynı iş: `npm run demo:reset -- --confirm=erp_dev`, yalnız yükleme için `npm run db:seed`.

## 9. E-posta (SMTP)

`SMTP_URL` + `MAIL_FROM` + `APP_BASE_URL` verilmezse parola sıfırlama ve e-posta doğrulama **kapalıdır** (arayüz "Şifremi unuttum" bağlantısını göstermez; kayıt sırasında e-posta otomatik doğrulanmış sayılır). Açıkken:

- Gönderim işlem tamamlandıktan **sonra** ve arka planda yapılır: posta hatası isteği bozmaz; kullanıcı var/yok bilgisi yanıt süresinden sızmaz.
- Bağlantı jetonları yalnızca `sha256` özetiyle saklanır, tek kullanımlıktır, sıfırlama 60 dakika geçerlidir.
- **Kurulum sihirbazı SMTP'yi sorar** (sunucu, güvenlik türü, port, kullanıcı, parola, gönderen, adres) ve istenirse **gerçek bir test e-postası** gönderir (`installer/tools/erp-tool.mjs smtp-test`; kitteki gömülü Node ile). Sonradan değiştirmek için `--reconfigure`; e-postasız devam etmek için "hayır" deyin (akışlar kapalı kalır).
- **SPF, DKIM ve DMARC kayıtları alan adınızda sizin işinizdir**; olmazsa mesajlar spam'e düşer. SMTP sağlayıcınızın belgelerine bakın.
- TLS sertifikası doğrulaması **kapatılamaz**; kendi imzalı sertifikalı bir SMTP için CA'yı `NODE_EXTRA_CA_CERTS` ile verin.

### 9b. Bildirim zamanlayıcısı ve e-posta özeti

Uygulama içi bildirimler (zil, `/notifications`) ek kurulum gerektirmez. API süreci açılışta bir zamanlayıcı başlatır (`NOTIFY_ENABLED`, varsayılan açık) ve her `NOTIFY_INTERVAL_MINUTES` dakikada (varsayılan 30; ilk tur açılıştan 20–40 sn sonra):

- Tüm şirketleri **tek tek**, her biri ayrı işlemde ve kendi RLS bağlamıyla tarar: vadesi gelen çek/senet, süresi dolan teminat mektubu ve yabancı işçi belgesi, ajanda (bugün/geciken, hatırlatma ofseti), onay bekleyen belge, lisans durumu, kapatılmamış puantaj/bordro ayı, vadesi geçmiş alacak, kritik stok, eski taslak. Her kullanıcıya yalnızca **o kaynak modülü şirkette açıksa ve izni varsa** bildirim gider.
- Aynı durum için kopya üretmez; durum değişince yeni bildirim açar, koşul kalkınca eskisini "çözüldü" yapar, `NOTIFY_RETENTION_DAYS` sonrası kapanmış bildirimleri siler. Eşik günleri kullanıcı tercihidir (varsayılanlar düz kullanım değerleridir, yasal süre değildir).
- **Çok örnekli güvenlik:** şirket başına PostgreSQL advisory kilidi vardır; iki uygulama örneği aynı şirketi aynı anda taramaz (kilidi alamayan örnek o şirketi atlar, bir sonraki turda yine dener) ve veritabanı kısıtı kopyayı ayrıca engeller. Bir örnek ölürse kilit işlemle birlikte kendiliğinden düşer.
- Hata: bir şirketin ya da kaynağın hatası günlüğe `uyarı` olarak yazılır ve diğerlerini durdurmaz. İzleme için günlükte `bildirim taraması tamam` (yalnızca değişiklik olduğunda) ve `bildirim taraması başarısız` satırlarına bakın. Sahip/yönetici, **Bildirimler → Şimdi tara** ile (ya da `POST /api/notifications/scan`) şirketi hemen taratabilir.
- **E-posta özeti** yalnızca e-posta yapılandırılmışsa (§9: `SMTP_URL` + `MAIL_FROM` + `APP_BASE_URL`) çalışır ve **kullanıcı başına, türe göre isteğe bağlıdır (varsayılan kapalı)**: kullanıcı + şirket + gün başına en çok bir ileti, yerel saat `NOTIFY_DIGEST_HOUR`'dan sonraki ilk turda; yalnızca okunmamış bildirim başlıklarını (tür ve sayı) ve `APP_BASE_URL/notifications` bağlantısını taşır — ad, kimlik no, IBAN, ücret, belge numarası ya da tutar içermez. SMTP yoksa özet hiç üretilmez ve arayüzde e-posta anahtarı kapalıdır. Gönderim mevcut arka plan hattıyla yapılır; SMTP hatası taramayı bozmaz ve aynı gün yeniden denenmez (özet kaydı gönderimden önce yazılır). SMTP sağlayıcısı yurt dışındaysa bildirim özeti de aktarım değerlendirmesine girer (LEGAL-NOTES §5, §24).
- Zamanlayıcıyı kapatmak (`NOTIFY_ENABLED=false`) mevcut bildirimleri silmez; yeni bildirim yalnızca elle taramayla üretilir.

## 10. Üçüncü taraf bildirimi

İmaj derlenirken `npm run licenses:notices` ile üretim bağımlılıklarından `THIRD-PARTY-NOTICES.md` oluşturulur ve imajda `/app/THIRD-PARTY-NOTICES.md` ile arayüz kökünde **`/THIRD-PARTY-NOTICES.md`** olarak sunulur (MIT/BSD/Apache dağıtımda telif bildirimi şartı). Sekiz paket lisans dosyasını yayımlamaz; bildirimde lisans türü ve kaynak adresi yazılıdır (LEGAL-NOTES §2). Ticari dağıtımdan önce bu dosyayı ve ürün adı/marka taramasını hukuki olarak gözden geçirin.

## 11. Müşteri kurulum kontrol listesi

**Kurulumdan önce**
- [ ] Alan adı ve (internete açıksa) TLS planı; sunucu ≥ 2 GB bellek, kalıcı disk
- [ ] Yedek hedefi (ofis dışı, şifreli) ve yedekten sorumlu kişi belirlendi
- [ ] Mali müşavirle teyit: hesap eşlemesi varsayılanları, KDV oranları (yürürlükteki tüzük değişiklikleriyle; %20 dahil), açılış bakiyesi karşı hesabı, stok değerleme yöntemi, yıl sonu kapanış/devir (henüz yok; LEGAL-NOTES)
- [ ] Kişisel veri: SMTP, yedek ve diğer üçüncü taraf servisler KKTC dışındaysa aktarım ruhsatı değerlendirildi (LEGAL-NOTES §5)
- [ ] İç belgelerin (fatura, irsaliye, defter çıktısı) **yasal belge yerine geçmediği** müşteriye yazılı bildirildi
- [ ] Lisans sözleşmesi/EULA müşteriyle imzalandı (hukuki metin avukata yazdırılır; LEGAL-NOTES §11) ve lisans kodu müşteriye güvenli kanaldan iletildi (kod yalnızca bir kez gösterilir)
- [ ] Sunucu giden HTTPS ile lisans sunucusuna ulaşabiliyor (güvenlik duvarı/vekil); `/etc/machine-id` mevcut ve kalıcı

**Kurulum**
- [ ] Kurulum sihirbazı çalıştırıldı (sorular yanıtlandı; `--answers` dosyası kullanıldıysa **silindi**); `deploy/.env`/`erp.env` (`chmod 600/640`) ayrı bir yerde yedeklendi; parolalar rastgele ve benzersiz
- [ ] `up -d` başarılı; `/api/health/ready` 200; sürüm `/api/public-config` ile doğrulandı
- [ ] Lisans etkinleştirildi (Ayarlar > Lisans: durum **Etkin**, sektör/cihaz/şirket sınırı sözleşmeyle uyumlu)
- [ ] İlk sahip kaydı yapıldı; `REGISTRATION_ENABLED=false` (özel kurulum) ve uygulama yeniden oluşturuldu
- [ ] TLS/`TRUST_PROXY`/`COOKIE_SECURE` ortamla uyumlu; oturum açıp yenileme (15 dk sonra) sınandı
- [ ] SMTP (isteğe bağlı; sihirbazın test e-postası ulaştı) ve SPF/DKIM; parola sıfırlama uçtan uca denendi
- [ ] Sihirbazın özetindeki lisans durumu doğru (lisanssızken iş uçları 402); "boş uygulama" seçildiyse demo hesabı yok; HTTPS seçildiyse sertifika tarayıcıda geçerli (kendi imzalıda istemcilere kök eklendi)

**Devreye almadan önce**
- [ ] Şirket kuruldu; mali dönemler, kurlar, KDV oranları (doğrulanmış işaretli), hesap eşlemesi gözden geçirildi; kullanılmayan modüller Ayarlar > Modüller'den kapatıldı
- [ ] Açılış bakiyeleri (cari, stok, mizan) içe aktarıldı ve mizan dengeli
- [ ] Rol/kullanıcılar eklendi (en az iki sahip/yönetici önerilir); cihaz kotası kullanıcıların gerçek cihaz sayısına yeter (kurtarma: `admin devices`)
- [ ] **Bir yedek alındı ve bir geri yükleme denemesi yapıldı** (§6); cron yedeği kuruldu
- [ ] İzleme (`/api/health/ready`) ve disk uyarısı kuruldu
- [ ] Müşteriye: yedekten sorumlu kişi, parola kurtarma yolu (§4), lisans bitiş tarihi/yenileme süreci (salt-okunura düşme davranışı) ve destek kanalı bildirildi

## 12. Bilinen sınırlar

Tek uygulama örneği varsayımı (bellek içi oran sınırı; bildirim zamanlayıcısı bundan **muaftır**, çok örnekte advisory kilidiyle güvenlidir, §9b; lisans durumu ve cihaz koltukları tek kurulum içindir); uygulama kullanıcıları için TOTP isteğe bağlıdır, şirket düzeyinde zorunlu kılma yoktur (lisans yönetim paneli için TOTP zorunludur: LICENSING.md); MFA sırrı `JWT_SECRET`'ten türetilen anahtarla şifrelenir, `JWT_SECRET` değişirse kayıtlı MFA sırları çözülemez (kullanıcıların MFA'sı yönetici tarafından sıfırlanır); lisanslama müşteri sunucusunda çalıştığından **%100 kırılamaz değildir** (LICENSING.md §1, §10); çevrimdışı lisans yıllık yenilenir; `users` tablosu çalışma zamanı rolüne tüm kiracılar için açıktır (giriş bunu gerektirir; kolon yetkisi/ayrı giriş rolü sonraya); dışa aktarma bellek içi üretilir (eşzamanlılık kapısı ve satır tavanı ile sınırlı); yıl sonu kapanış/devir ve kur değerlemesi (M7b) mali müşavir teyidine bağlıdır ve henüz yoktur; yedekleme/saklama/kişisel veri politikası hukuken **doğrulanmamıştır** (LEGAL-NOTES §5); imaj kayıt defterine yayınlanmaz ve Caddy TLS profili otomatik sınanmaz.
