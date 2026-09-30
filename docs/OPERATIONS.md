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

Uygulama kabı yalnızca **RLS'e tabi çalışma zamanı rolünü** (`erp_app`) bilir; şema sahibi rolün (`erp`) parolası yalnızca tek seferlik `migrate` kabındadır. Uygulama, süper kullanıcı/`BYPASSRLS`/tablo sahibi bir rolle ya da RLS'siz tablolarla açılmayı **reddeder** (üretimde `exit 1`).

**Lisans:** imaj **lisanslıdır**: üretim paketi lisans denetimi açık derlenir ve satıcının açık anahtarını gömer; lisans etkinleştirilmeden uygulama yalnızca etkinleştirme ekranını sunar. Müşteri imajı, lisansı veren satıcının derlediği imajdır (açık anahtar pakete gömülüdür; bkz. [LICENSING.md §5](LICENSING.md)). Bu kılavuzdaki "müşteri kurulumu" bölümleri lisans etkinleştirme adımını içerir (§4).

**Müşteriye yalnızca imajla teslim (kaynak kodu verilmez).** Satıcı imajı derler (`docs/LICENSING.md §5`) ve `docker save muhasebe-erp:1.0.0 | gzip > muhasebe-erp-1.0.0.tar.gz` ile dosyalar. Müşteri kiti, **aynı klasör düzeniyle**: imaj dosyası + `deploy/docker-compose.prod.yml`, `deploy/.env.production.example`, `deploy/Caddyfile`, `infra/postgres/init-prod.sh`, `scripts/backup.sh`, `scripts/restore.sh`, `docs/OPERATIONS.md`. Müşteri tarafında: `docker load < muhasebe-erp-1.0.0.tar.gz`, `deploy/.env` içinde `ERP_IMAGE=muhasebe-erp:1.0.0`, sonra `docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d` (**`--build` kullanılmaz**: kaynak kod yoktur; aşağıdaki `git clone` ve `--build` adımları yalnızca kaynağı olan satıcı/geliştirici içindir).

İmaj yayını (registry) henüz yoktur: imaj müşteri sunucusunda `docker build` ile ya da sizin derleyip `docker save/load` ile taşıdığınız imajla kurulur.

## 2. Kurulum (Docker Compose)

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
| `JWT_SECRET` | — (zorunlu) | ≥ 32 karakter. Üretimde `example`, `change-me`, `secret-secret`, `password` gibi örnek kalıplar **reddedilir** |
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
| `DB_POOL_MAX` | `10` | Bağlantı havuzu üst sınırı |
| `DB_STATEMENT_TIMEOUT_MS` | `60000` | Tek SQL ifadesi üst süresi; `0` kapalı |
| `EXPORT_CONCURRENCY` | `2` | Eşzamanlı (bellek içi) dışa aktarma sayısı; fazlası `429 EXPORT_BUSY` |
| `SHUTDOWN_TIMEOUT_MS` | `20000` | Kapanışta bekleme süresi |
| `SMTP_URL` | yok | Örn. `smtps://kullanici:parola@smtp.ornek.com:465`. Verilirse parola sıfırlama ve e-posta doğrulama **açılır**; TLS sertifikası doğrulanır |
| `MAIL_FROM` | yok | `SMTP_URL` ile birlikte zorunlu: `"Muhasebe ERP <no-reply@ornek.com>"` |
| `APP_BASE_URL` | yok | E-postalardaki bağlantı kökü (`https://erp.ornek.com`); posta açıkken zorunlu |
| `MAIL_TRANSPORT` | yok | `log` yalnızca geliştirme (bağlantıyı günlüğe yazar); **üretimde reddedilir** |
| `WEB_DIST_DIR` | imajda `/app/web` | Derlenmiş arayüz klasörü |
| `APP_VERSION` | `dev` | İmaj derlemesinde verilir; `/api/public-config` döndürür |
| `LICENSE_SERVER_URL` | imaja gömülü | Lisans sunucusu adresi (yalnızca `https`); verilirse derlemede gömülü varsayılanın yerine geçer. Normalde boş bırakılır: satıcı imajı derlerken belirler |
| `LICENSE_HOST_ID_FILE` | `/etc/host-machine-id` | Ana makine kimliği dosyası (compose bağlar); sunucu parmak izinin parçası |
| `LICENSE_ALLOW_INSECURE_URL` | `false` | Yalnızca test düzenekleri (`http://` lisans sunucusu); **müşteri kurulumunda kullanılmaz** |
| `LICENSE_ENFORCEMENT_DEV`, `LICENSE_DEV_KEYRING` | yok | Yalnızca `NODE_ENV≠production` (geliştirme/e2e); üretimde **reddedilir**. Üretim paketinde lisans denetimi **derleme zamanı sabitidir**, ortam değişkeniyle kapatılamaz |
| `ALLOW_DEMO` | yok | Yalnızca demo örneğinde `true` (bkz. §8); müşteri kurulumunda **asla** |

Compose dikkat: kabuk ortam değişkenleri `--env-file` değerlerinden **önceliklidir**; kabukta eski bir `JWT_SECRET` tanımlıysa dosyadaki değer yok sayılır.

## 4. İlk kiracı ve kullanıcılar

- **Özel (tek müşteri) kurulum:** arayüzü açın, **bir kez** kayıt olun (kuruluş + şirket + sahip), ardından `deploy/.env` içinde `REGISTRATION_ENABLED=false` yapıp `docker compose … up -d app` ile kapıyı kapatın. Diğer kullanıcıları sahip/yönetici **Ayarlar > Kullanıcılar**'dan ekler (geçici parola verir; kullanıcı ilk girişte kendi parolasını seçmek zorundadır).
- **Barındırılan çok kiracılı kurulum:** `REGISTRATION_ENABLED=true` bırakılır; her kayıt kendi kuruluşunu açar ve veri PostgreSQL **Row-Level Security** ile yalıtılır. Kötüye kullanıma karşı kayıt/giriş uçları IP ve e-posta başına oran sınırlıdır; yine de bir ters vekil/WAF ve SMTP doğrulaması önerilir.
- **Parola kurtarma:** SMTP açıksa kullanıcı "Şifremi unuttum" ile sıfırlar. SMTP kapalıysa operatör, geçici parola üretir (oturumlar kapanır, ilk girişte parola değişimi zorunlu olur):

  ```bash
  docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env exec app \
    node dist/admin.js reset-password --email=kisi@ornek.com
  ```

  Komut çalışma zamanı rolüyle (`DATABASE_URL`) çalışır; şema sahibi parolası gerekmez. Geçici parola yalnızca komut çıktısında görünür; kullanıcıya güvenli bir kanaldan iletin. İşlem `security_events` tablosuna `via: operator-cli` imzasıyla yazılır.
- **Lisans etkinleştirme:** lisanssız kurulumda tarayıcı yalnızca **Lisans etkinleştirme** sayfasını gösterir; satıcıdan aldığınız kodu (`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`) girin. Sunucu internete çıkamıyorsa aynı sayfada **çevrimdışı etkinleştirme** ile "istek kodu" üretip satıcıya gönderin, dönen lisans kodunu yapıştırın. Sonra ilk sahip kaydı yapılır. Durum ve kullanım **Ayarlar > Lisans**'tadır (yalnızca sahip); ayrıntı için [LICENSING.md §9](LICENSING.md).
- **Cihaz koltukları:** her kayıtlı tarayıcı/bilgisayar lisansın cihaz kotasından bir koltuk tutar; kota dolunca yeni cihaz giremez. Sahip/yönetici **Ayarlar > Cihazlar**'dan listeler, adlandırır, kaldırır; 30 gün kullanılmayan cihaz koltuğunu bırakır. Kota dolduğu için **kimse giremiyorsa** operatör kurtarma komutu:

  ```bash
  docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env exec app node dist/admin.js devices
  docker compose … exec app node dist/admin.js devices:revoke --id=<kimlik|ön ek>
  docker compose … exec app node dist/admin.js devices:revoke-all --yes      # herkes yeniden giriş yapar
  ```
- Rol değişiklikleri: `owner` rolünü yalnızca sahip verir/alır; son sahip düşürülemez.

## 5. Yükseltme

```bash
scripts/backup.sh --compose                      # 1) yedek al
git pull                                         # 2) yeni sürüm (ya da yeni imaj etiketi: ERP_IMAGE)
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build
curl -fsS http://127.0.0.1:3000/api/health/ready # 3) doğrula, bir oturum açma denemesi yap
```

`up -d` önce `migrate` kabını çalıştırır (yalnızca bekleyen migration'lar uygulanır), ardından uygulamayı yeniden başlatır; uygulama kapanırken süren istekleri `SHUTDOWN_TIMEOUT_MS`'e kadar bitirir.

**Lisanslama öncesi bir sürümden yükseltme:** ilk lisanslı imaja geçişte mevcut kurulum **lisanssız** (yalnızca etkinleştirme ekranı) açılır; veriler bozulmaz ve silinmez. Müşteri lisans kodunu girene kadar giriş/yazma kapalıdır: geçişi önceden planlayın, kodu hazır edin. Lisans süresi dolar ya da lisans sunucusuna ulaşılamazsa uygulama **salt-okunur** moda düşer (veri görüntülenir ve dışa aktarılır, yazma kilitlenir); ayrıntı [LICENSING.md §7](LICENSING.md).

**Geri dönüş:** migration'lar ileri yönlüdür. Yükseltme başarısız olursa eski imaja dönüp (`ERP_IMAGE=<eski>`) **yedeği geri yükleyin** (§6, `--recreate`). Bu yüzden yükseltmeden önce yedek şarttır.

## 6. Yedekleme ve geri yükleme

### Yedek

```bash
scripts/backup.sh --compose                       # deploy/.env'den okur; ./backups/ altına yazar
scripts/backup.sh --compose --dir /var/backups/erp --keep-days 30
MIGRATION_DATABASE_URL=postgres://erp:…@host/erp scripts/backup.sh   # doğrudan kip (compose dışı)
```

Bir `pg_dump -Fc` dökümü üretir: **tüm şirketlerin verisi**, erişim izinleri (GRANT) ve migration geçmişi dökümdedir. Betik kısmi dosya bırakmaz (önce geçici dosyaya yazar, `pg_restore --list` ile arşivi doğrular, sonra adlandırır), `sha256` özetini yanına yazar ve `--keep-days`'ten eski `erp-*.dump` dosyalarını siler. Dizin yalnızca sahibine açıktır (0700).

Günlük yedek için cron örneği (her gece 02:15):

```cron
15 2 * * * cd /opt/muhasebe-erp && scripts/backup.sh --compose --dir /var/backups/erp >> /var/log/erp-backup.log 2>&1
```

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
 where event in ('member_added','member_role_changed','member_removed') order by at desc limit 100;
-- Parola sıfırlamaları (operatör komutu via=operator-cli imzalıdır)
select at, email, meta from security_events where event like 'password_reset%' order by at desc limit 50;
```

Olay adları: `login_succeeded`, `login_failed`, `password_changed`, `password_reset_requested`, `password_reset_completed`, `email_verified`, `refresh_reuse_detected`, `member_added`, `member_role_changed`, `member_removed`.

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
- **SPF, DKIM ve DMARC kayıtları alan adınızda sizin işinizdir**; olmazsa mesajlar spam'e düşer. SMTP sağlayıcınızın belgelerine bakın.
- TLS sertifikası doğrulaması **kapatılamaz**; kendi imzalı sertifikalı bir SMTP için CA'yı `NODE_EXTRA_CA_CERTS` ile verin.

## 10. Üçüncü taraf bildirimi

İmaj derlenirken `npm run licenses:notices` ile üretim bağımlılıklarından `THIRD-PARTY-NOTICES.md` oluşturulur ve imajda `/app/THIRD-PARTY-NOTICES.md` ile arayüz kökünde **`/THIRD-PARTY-NOTICES.md`** olarak sunulur (MIT/BSD/Apache dağıtımda telif bildirimi şartı). Sekiz paket lisans dosyasını yayımlamaz; bildirimde lisans türü ve kaynak adresi yazılıdır (LEGAL-NOTES §2). Ticari dağıtımdan önce bu dosyayı ve ürün adı/marka taramasını hukuki olarak gözden geçirin.

## 11. Müşteri kurulum kontrol listesi

**Kurulumdan önce**
- [ ] Alan adı ve (internete açıksa) TLS planı; sunucu ≥ 2 GB bellek, kalıcı disk
- [ ] Yedek hedefi (ofis dışı, şifreli) ve yedekten sorumlu kişi belirlendi
- [ ] Mali müşavirle teyit: hesap eşlemesi varsayılanları, KDV oranları, açılış bakiyesi karşı hesabı, stok değerleme yöntemi, yıl sonu kapanış/devir (henüz yok; LEGAL-NOTES)
- [ ] İç belgelerin (fatura, irsaliye, defter çıktısı) **yasal belge yerine geçmediği** müşteriye yazılı bildirildi
- [ ] Lisans sözleşmesi/EULA müşteriyle imzalandı (hukuki metin avukata yazdırılır; LEGAL-NOTES §11) ve lisans kodu müşteriye güvenli kanaldan iletildi (kod yalnızca bir kez gösterilir)
- [ ] Sunucu giden HTTPS ile lisans sunucusuna ulaşabiliyor (güvenlik duvarı/vekil); `/etc/machine-id` mevcut ve kalıcı

**Kurulum**
- [ ] `deploy/.env` dolduruldu, `chmod 600`, ayrı bir yerde yedeklendi; parolalar rastgele ve benzersiz
- [ ] `up -d` başarılı; `/api/health/ready` 200; sürüm `/api/public-config` ile doğrulandı
- [ ] Lisans etkinleştirildi (Ayarlar > Lisans: durum **Etkin**, sektör/cihaz/şirket sınırı sözleşmeyle uyumlu)
- [ ] İlk sahip kaydı yapıldı; `REGISTRATION_ENABLED=false` (özel kurulum) ve uygulama yeniden oluşturuldu
- [ ] TLS/`TRUST_PROXY`/`COOKIE_SECURE` ortamla uyumlu; oturum açıp yenileme (15 dk sonra) sınandı
- [ ] SMTP (isteğe bağlı) ve SPF/DKIM; parola sıfırlama uçtan uca denendi

**Devreye almadan önce**
- [ ] Şirket kuruldu; mali dönemler, kurlar, KDV oranları (doğrulanmış işaretli), hesap eşlemesi gözden geçirildi; kullanılmayan modüller Ayarlar > Modüller'den kapatıldı
- [ ] Açılış bakiyeleri (cari, stok, mizan) içe aktarıldı ve mizan dengeli
- [ ] Rol/kullanıcılar eklendi (en az iki sahip/yönetici önerilir); cihaz kotası kullanıcıların gerçek cihaz sayısına yeter (kurtarma: `admin devices`)
- [ ] **Bir yedek alındı ve bir geri yükleme denemesi yapıldı** (§6); cron yedeği kuruldu
- [ ] İzleme (`/api/health/ready`) ve disk uyarısı kuruldu
- [ ] Müşteriye: yedekten sorumlu kişi, parola kurtarma yolu (§4), lisans bitiş tarihi/yenileme süreci (salt-okunura düşme davranışı) ve destek kanalı bildirildi

## 12. Bilinen sınırlar

Tek uygulama örneği varsayımı (bellek içi oran sınırı; lisans durumu ve cihaz koltukları tek kurulum içindir); uygulama kullanıcıları için MFA/TOTP yok (lisans yönetim paneli için zorunlu TOTP vardır: LICENSING.md); lisanslama müşteri sunucusunda çalıştığından **%100 kırılamaz değildir** (LICENSING.md §1, §10); çevrimdışı lisans yıllık yenilenir; `users` tablosu çalışma zamanı rolüne tüm kiracılar için açıktır (giriş bunu gerektirir; kolon yetkisi/ayrı giriş rolü sonraya); dışa aktarma bellek içi üretilir (eşzamanlılık kapısı ve satır tavanı ile sınırlı); yıl sonu kapanış/devir ve kur değerlemesi (M7b) mali müşavir teyidine bağlıdır ve henüz yoktur; yedekleme/saklama/kişisel veri politikası hukuken **doğrulanmamıştır** (LEGAL-NOTES §5); imaj kayıt defterine yayınlanmaz ve Caddy TLS profili otomatik sınanmaz.
