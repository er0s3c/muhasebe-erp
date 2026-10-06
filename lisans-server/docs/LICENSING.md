# Lisanslama kılavuzu

Bu belge üç kitleye yöneliktir: **satıcı** (lisans veren siz), **müşteri** (yazılımı kendi sunucusunda çalıştıran) ve **güvenlik incelemesi yapan**.
Kod ve komutlar depodaki gerçek uygulamayı anlatır; "doğrulanmadı" denen hukuki noktalar `docs/LEGAL-NOTES.md` §11'dedir.

## 1. Özet ve dürüst sınırlar

- Yazılım müşterinin **kendi sunucusunda** (Docker imajı) çalışır. Siz kendi VPS'inizde bir **lisans sunucusu** çalıştırır, istediğiniz kişiye
  istediğiniz zaman lisans verirsiniz. Lisans şunları belirler: **sektör(ler)** (market / inşaat / ticaret), **cihaz kotası** (cihaz başına ücret),
  şirket sınırı, abonelik bitişi.
- Süre bitince ya da lisans doğrulanamayınca uygulama **salt-okunur moda** geçer: veriler görüntülenir ve dışa aktarılır, yazma kapanır.
  Müşterinin verisi rehin tutulmaz.
- **Dürüst sınır:** müşteri sunucuyu ve dosyaları kontrol ediyorsa %100 kırılamaz yazılım yoktur; kararlı biri kodu yamalayabilir.
  Hedef; sahte lisans üretmeyi, veritabanındaki lisansı düzenlemeyi, lisansı başka sunucuya kopyalamayı, saati geri almayı, ağı kesmeyi ve
  cihaz kotasını atlatmayı **imkânsız ya da belirgin ve geçici** yapmak, kodu yamalamayı ise **pahalılaştırmaktır** (bkz. §10). Gerçekten kırılamaz
  tek model yazılımı **sizin** sunucunuzda barındırmaktır (aynı lisans sunucusu ileride kiracı başına lisansla bu modele uyarlanabilir).
- Kriptografi standarttır: Ed25519 (Node `crypto`), yeni bağımlılık yoktur. Muhasebe verisi lisans sunucusuna **gönderilmez** (§3).

## 2. Kavramlar

| Kavram | Anlamı |
|---|---|
| **Lisans** | Sizin verdiğiniz hak: müşteri, sektörler, kotalar, bitiş. Lisans sunucusunun veritabanındadır. |
| **Etkinleştirme kodu** | 25 karakter (125 bit). Sunucuda yalnızca özeti saklanır; oluşturulduğunda **bir kez** gösterilir. |
| **Kurulum (installation)** | Uygulamanın bir çalışan örneği: ilk çalışmada kendi Ed25519 anahtar çiftini ve kimliğini üretir. |
| **Kira (lease)** | Sizin imzaladığınız, kuruluma ve sunucu parmak izine bağlı, süreli yetki belgesi (varsayılan 7 gün). Uygulama her 12 saatte yeniler. |
| **Tolerans** | Kira yenilenemezse tam işlevli kalınan ek süre (varsayılan 14 gün). Sonrası salt-okunur. |
| **Sunucu parmak izi** | Ana makine kimliği (`/etc/machine-id`) + PostgreSQL küme kimliğinin özeti. Veritabanı başka makineye kopyalanırsa değişir. |
| **Cihaz (koltuk)** | Kayıtlı bir tarayıcı/bilgisayar (çerez). Cihaz kotası bunları sayar (§8). |

Uygulama yalnızca **açık anahtarınızı** bilir (imaja gömülür); özel anahtar yalnızca lisans sunucusundadır.

## 3. Uygulamadan lisans sunucusuna giden bilgiler

Yalnızca: kurulum kimliği, kurulum açık anahtarı, sunucu parmak izi (özet), uygulama sürümü, etkinleştirme kodu (etkinleştirmede), ve kalp atışında
**kayıtlı etkin cihaz sayısı ile şirket sayısı**, kurulum sihirbazıyla kurulmuşsa **kit hedefi** (`linux-x64`/`win-x64`; uzaktan güncelleme arşivini seçer). Kullanıcı, müşteri, fatura, stok, tutar gibi hiçbir muhasebe verisi gönderilmez. Sunucu IP adresini
TCP bağlantısı gereği görür (klon şüphesi tespitinde kullanılır; `docs/LEGAL-NOTES.md` §11). Bu açıklama uygulamada da (Lisans sayfası) vardır.

## 4. Satıcı kurulumu (lisans sunucusu, VPS)

### 4.1 Gereksinimler

Docker Engine + Compose v2, bir alan adı (DNS bu sunucuya, 80/443 açık), çalışma için ~1 GB bellek; **imajı VPS'te derleyecekseniz ≥ 2 GB** (1 GB'ta 2 GB swap ekleyin ya da imajı kendi makinenizde derleyip `docker save | ssh … docker load` ile taşıyın). Lisans sunucusu ayrı bir PostgreSQL kullanır (aynı compose içinde). Güvenlik duvarı: yalnızca 22, 80, 443.

**Alan adı Cloudflare'daysa kaydı "DNS only" (gri bulut) yapın.** Turuncu bulut (proxy) açıkken Caddy müşterinin değil Cloudflare'in IP'sini görür: `LICENSE_ADMIN_ALLOW` denetimi ve oran sınırı doğru çalışmaz.

**VPS'e taşınacak dosyalar.** En kolayı tüm depoyu, izlenmeyen/gizli dosyalar (`.env`, `node_modules`, `dist`, anahtar dosyaları) girmeden paketlemektir:

```bash
git archive --format=tar.gz -o muhasebe-erp.tar.gz HEAD          # kendi makinenizde
scp muhasebe-erp.tar.gz kullanici@VPS:/opt/                      # sonra VPS'te: mkdir -p /opt/muhasebe-erp && tar xzf /opt/muhasebe-erp.tar.gz -C /opt/muhasebe-erp
```

Yalnızca lisans sunucusu için gereken alt küme: `package.json`, `package-lock.json`, `tsconfig.base.json`, `apps/api/package.json`, `apps/web/package.json`,
`apps/web/src/components/ui/`, `apps/web/src/lib/cn.ts`, `lisans-server/server/`, `lisans-server/panel/`, `packages/`, `lisans-server/deploy/`, `infra/postgres/init-prod.sh`
(yedek için ayrıca `scripts/backup.sh`, `scripts/restore.sh`). Müşteri uygulama imajını da VPS'te derleyecekseniz tüm depo gerekir. İmza özel anahtarı ve `lisans-server/deploy/.env`
**hiçbir zaman** depoya, pakete ya da başka makineye girmez.

### 4.2 Anahtar töreni (bir kez; en önemli adım)

```bash
cd /opt/muhasebe-erp                                   # (git clone yerine yukarıdaki paketten açılan klasör de olur)
docker build -f lisans-server/server/Dockerfile -t muhasebe-lisans .
# Kap 'node' kullanıcısıyla (uid 1000) çalışır: dizin ona ait olmalı (root'a chmod 700 yazmayı ve okumayı engeller)
mkdir -p /etc/muhasebe-lisans && chown 1000:1000 /etc/muhasebe-lisans && chmod 700 /etc/muhasebe-lisans
# parola ≥ 12 karakter; güçlü, rastgele ve ayrı bir yerde saklanır
export LICENSE_SIGNING_KEY_PASSPHRASE="$(openssl rand -base64 24)"; echo "$LICENSE_SIGNING_KEY_PASSPHRASE"   # KAYDEDİN
docker run --rm -v /etc/muhasebe-lisans:/out -e LICENSE_SIGNING_KEY_PASSPHRASE muhasebe-lisans \
  node dist/cli.js keygen --kid=k1 --out=/out/signing-key.json
```

Komut **mühürlü** anahtar dosyasını (scrypt + AES-256-GCM) yazar ve **açık anahtarı** ekrana basar:

```
  "k1": "eeCfbBA9C4ORuNfjf-lleTjHwm-s8yl20JBYygsODqw"
```

1. **Açık anahtarı** depoda `apps/api/src/licensing/public-keys.json` içindeki `"keys"` nesnesine ekleyin ve commit'leyin.
2. **Anahtar dosyasını ve parolasını AYRI yerlerde çevrimdışı yedekleyin** (parola yöneticisi + şifreli USB gibi). Kaybolursa yeni lisans imzalayamazsınız;
   sızarsa herkes sahte lisans üretebilir (§11).
3. Dosya izinleri: `keygen` dosyayı `0600` ve sahibi uid 1000 (kapta `node`) olarak yazar; dizin `700` ve aynı sahiptir. Ana makinede yalnızca root ve bu kullanıcı okuyabilir;
   lisans sunucusu kabı dosyayı `LICENSE_KEY_DIR` bağlamasından (salt-okunur) okur. Dizini root'a `chmod 600/700` yaparsanız kap yazamaz/okuyamaz ve sunucu açılmaz.

### 4.3 Sunucuyu ayağa kaldırma

```bash
cp lisans-server/deploy/.env.example lisans-server/deploy/.env   # parolaları doldurun (openssl rand -hex 24), LICENSE_DATA_KEY: openssl rand -base64 48
# LICENSE_DOMAIN, LICENSE_KEY_DIR=/etc/muhasebe-lisans, LICENSE_SIGNING_KEY_PASSPHRASE, LICENSE_ADMIN_ALLOW=<kendi IP adresiniz>/32
docker compose -f lisans-server/deploy/docker-compose.yml --env-file lisans-server/deploy/.env up -d --build
curl https://<alan-adı>/healthz        # {"ok":true,...}
```

- Herkese açık olan yalnızca **`/v1/*`** (müşteri uygulamaları) ve **`/healthz`**'dir. **Yönetim paneli ve `/admin/api`** Caddy'de `LICENSE_ADMIN_ALLOW`
  ile izin verilen adreslere kısıtlıdır: kendi IP adresinizi yazın (varsayılan "herkes" yalnızca ilk kurulum içindir). IP'niz değişiyorsa VPN/sabit IP kullanın.
- Veritabanı portu yayınlanmaz. Yönetici parolası/TOTP sırrı diskte şifrelidir (`LICENSE_DATA_KEY`).

**Cloudflare Tunnel varyantı** (80/443 açmadan; paylaşılan sunucuda): Caddy port yayınlamaz, TLS Cloudflare'de biter, Caddy istemci adresini
`Cf-Connecting-IP`'den alır (`LICENSE_ADMIN_ALLOW` ve oran sınırı doğru çalışır; bu varyantta "DNS only" uyarısı geçerli değildir).

```bash
cloudflared tunnel create muhasebe-lisans                       # ~/.cloudflared/<tünel-id>.json üretir
mkdir -p /etc/muhasebe-lisans-tunnel && install -m 400 -o 65532 -g 65532 ~/.cloudflared/<tünel-id>.json /etc/muhasebe-lisans-tunnel/
cat > /etc/muhasebe-lisans-tunnel/config.yml <<EOF
tunnel: <tünel-id>
credentials-file: /etc/cloudflared/<tünel-id>.json
ingress:
  - hostname: <alan-adı>
    service: http://caddy:80
  - service: http_status:404
EOF
chown -R 65532:65532 /etc/muhasebe-lisans-tunnel
cloudflared tunnel route dns muhasebe-lisans <alan-adı>
# .env: CLOUDFLARED_DIR=/etc/muhasebe-lisans-tunnel
docker compose -f lisans-server/deploy/docker-compose.yml -f lisans-server/deploy/docker-compose.tunnel.yml --env-file lisans-server/deploy/.env up -d --build
```

> `TRUST_PROXY` sayısal atlama değeri (`1`) almaz: Fastify ≥ 5.12 sayıyı güvenlik gereği yok sayar ve tüm istekler vekilin adresinden gelmiş görünür
> (oran sınırı tek kovaya düşer). Lisans sunucusu `loopback,uniquelocal` kullanır (yalnızca iç ağdaki Caddy'ye güvenir); **sayısal değerle açılmayı reddeder**.
> Üretimde **`LICENSE_ADMIN_ORIGIN` zorunludur** (https) ve compose `https://${LICENSE_DOMAIN}` verir: giriş anahtarlarının bağlandığı köken istekteki `Host`
> başlığından türetilmez.
>
> Tünel varyantı için gereken Compose sürümü ≥ 2.24'tür (`!reset`/`!override`). `cloudflare/cloudflared` imajını ilk kurulumdan sonra belirli bir sürüm
> etiketine sabitlemeniz önerilir (`latest` her `pull`'da değişir).

### 4.4 Yönetici hesabı (panel: parola + zorunlu TOTP ya da giriş anahtarı)

**İlk kurulum panelden** (yalnızca hiç yönetici yokken): `https://<alan-adı>/` adresi `/setup` sayfasına yönlenir.

```bash
docker compose -f lisans-server/deploy/docker-compose.yml [-f lisans-server/deploy/docker-compose.tunnel.yml] --env-file lisans-server/deploy/.env exec license \
  node dist/cli.js setup:token        # kurulum kodu: XXXX-XXXX-XXXX-XXXX-XXXX
```

1. **Hesap:** kurulum kodu, e-posta, ad soyad, parola ve parola tekrarı (≥ 12 karakter; Vaultwarden eklentisi kaydetmeyi önerir).
2. **Doğrulama uygulaması:** QR kodu, anahtar ve `otpauth://` adresi gösterilir. Vaultwarden/Bitwarden'da kaydın **Kimlik doğrulayıcı anahtarı (TOTP)**
   alanına adresi yapıştırın (ya da mobil uygulamayla QR'ı okutun). Kasadaki 6 haneli kod girilince hesap oluşur ve oturum açılır.
3. **Giriş anahtarı (isteğe bağlı):** passkey eklenir; Vaultwarden eklentisi saklar. Sonraki girişlerde "Giriş anahtarıyla giriş" e-posta/parola/kod sormaz
   (kasa kilidi/PIN/biyometri zorunludur). Anahtarlar sonradan **Güvenlik** sayfasından eklenir/silinir.

Kurulum kodu `LICENSE_DATA_KEY`'den türetilir (yalnızca sunucuya erişen görebilir); ilk yönetici oluşunca kurulum kapanır, kod geçersizleşir. Panel internete
açıkken hesabı ilk gelenin kapmasını bu kod önler (IP başına 10 hatalı denemede kilitlenir). Giriş anahtarları `LICENSE_ADMIN_ORIGIN` kökenine
(compose: `https://${LICENSE_DOMAIN}`) bağlıdır: alan adı değişirse yeniden eklenmeleri gerekir.

Bilinen sınırlar: giriş anahtarı **eklemek yeniden doğrulama istemez** (çalınmış bir oturum kalıcı bir anahtar ekleyebilir; oturum `httpOnly` + `SameSite=Strict` ve 8 saatlik,
ama hesap ele geçirildiğinde `admin:reset` tüm giriş anahtarlarını da siler); giriş anahtarı meydan okumaları bellekte tutulur (tek örnek varsayımı);
kurulum sihirbazının tarayıcı senaryosu depoda otomatik sınanmaz (sunucu tarafı kurulum ve WebAuthn akışları `test/setup-passkey.test.ts` ile sınanır).

Ek yönetici (komut satırından):

```bash
docker compose -f lisans-server/deploy/docker-compose.yml --env-file lisans-server/deploy/.env exec license \
  node dist/cli.js admin:create --email=siz@ornek.com --name="Ad Soyad"
```

Çıktıdaki **parola** ve **TOTP sırrı** yalnızca bir kez görünür: sırrı Vaultwarden'a ya da bir Authenticator uygulamasına (Aegis…) elle ekleyin.
Giriş: e-posta + parola + 6 haneli kod. Kurallar: aynı kod iki kez kullanılamaz, 5 başarısız denemede (IP+e-posta) ve 15'te (yalnızca e-posta) kilitlenir,
oturum 8 saattir, değiştiren isteklerde CSRF başlığı ve köken denetimi vardır. Parola/TOTP kaybolursa: `admin:reset --email=…` (parola ve TOTP yenilenir,
giriş anahtarları silinir).

### 4.5 Komut satırı (panelin eşi; SSH ile)

`docker compose … exec license node dist/cli.js <komut>`:

| Komut | Ne yapar |
|---|---|
| `license:issue --customer="Ad" --sectors=RETAIL_MARKET,COMMERCE --devices=3 [--companies=1] [--valid-until=2027-12-31] [--kind=commercial\|trial\|demo] [--lease-days=7] [--grace-days=14] [--activations=1] [--offline]` | Lisans verir; etkinleştirme kodunu **bir kez** yazar. Müşteri yoksa oluşturur. |
| `license:list` | Lisansları listeler. |
| `license:extend --id=… --valid-until=YYYY-MM-DD` | Süreyi uzatır. |
| `license:suspend / resume / revoke --id=…` | Askıya alır / devam ettirir / iptal eder (kurulumlar sonraki kalp atışında etkilenir, en geç ~12 saat). |
| `license:code --id=…` | Yeni etkinleştirme kodu üretir (eskisi geçersiz olur). |
| `setup:token` | İlk yönetici kurulum kodunu yazdırır (yalnızca hiç yönetici yokken; panel `/setup`). |
| `admin:create / admin:reset` | Yönetici oluşturur / parola ve TOTP'yi yeniler (giriş anahtarlarını siler). |
| `keygen --kid=… --out=…` | İmza anahtarı üretir (yalnızca anahtar töreninde). |

## 5. Uygulama imajını derleme ve müşteriye verme

Müşteriye **yalnızca imaj** verilir (kaynak kodu verilmez). İmaj, açık anahtarınızı ve varsayılan lisans sunucusu adresinizi **derlemeye gömer**; üretim
paketinde lisans denetimi bir **derleme zamanı sabitidir**, ortam değişkeniyle kapatılamaz.

```bash
export LICENSE_PUBLIC_KEYS_JSON='{"keys":{"k1":"<açık anahtar>"}}'   # ya da public-keys.json dosyasını commit'leyin
docker build -t registry.ornek.com/muhasebe-erp:1.0.0 --build-arg APP_VERSION=1.0.0 \
  --build-arg LICENSE_PUBLIC_KEYS_JSON --build-arg LICENSE_SERVER_URL=https://lisans.ornek.com .
```

- Güvenilir anahtar yoksa **derleme başarısız olur** (kullanılamaz/denetimsiz paket üretilmesin). `LICENSE_ALLOW_EMPTY_KEYRING=true` yalnızca CI'da derlenebilirliği doğrulamak içindir.
- `LICENSE_SERVER_URL` https olmalıdır (`LICENSE_ALLOW_INSECURE_URL=true` yalnızca test düzenekleri).
- Üretim kipi denetimsiz paketle başlamaz (`server.ts`). API kaynak haritası üretilmez, paket küçültülür.
- Müşterilere imaj kayıt defteriniz (özel registry) ya da `docker save` dosyasıyla iletilir; müşteri kurulum belgesi `docs/OPERATIONS.md`'dir.

### 5.1 Sürüm kiti ve uzaktan güncelleme (tek tıkla gönderme)

Sihirbazla kurulan müşteriler (Docker'lı ya da Docker'sız) **sürüm kiti** kullanır: `LICENSE_SERVER_URL=https://lisans.ornek.com npm run release -- --version=1.2.0` (aynı `LICENSE_PUBLIC_KEYS_JSON` ortamıyla; kit anahtarı ve adresi gömer). **`LICENSE_SERVER_URL` zorunludur:** verilmezse `release` kit üretmeyi reddeder, çünkü adressiz kit lisansı çevrimiçi etkinleştiremez (`409 LICENSE_SERVER_NOT_CONFIGURED`); yalnızca çevrimdışı etkinleştirmeyle teslim edilecek bir kit için bilerek `--allow-no-license-server` verin. `--skip-build` ile önceden derlenmiş paketin aynı adresle derlendiği denetlenir. Adres `kit.json`'a (`licenseServerUrl`, yoksa `null`) yazılır; kurulum sihirbazı müşteriye kitte adres olup olmadığını açıkça söyler. Yeni sürümü müşterilere göndermek:

1. Panel **Sürümler** → **Yeni sürüm** (sürüm numarası = kitin sürümü; notu müşteri görür) → **Kit arşivi seç** (`muhasebe-erp-1.2.0-linux-x64.tar.gz`, `…-win-x64.zip`; 8 MB'lık parçalarla yüklenir, kopan yükleme kaldığı yerden sürer) → **Yayımla (imzala)**: dosya özetleriyle manifesto satıcı anahtarınızla imzalanır; yayımlanan sürümün dosyaları ve özetleri artık değişmez (veritabanı tetikleyicisi, `LIC03`).
2. Aynı ekranda müşteri lisanslarını seçip **Seçilenlere gönder** ya da **Tüm etkin lisanslara gönder**. Kurulumlar bir sonraki kalp atışında teklifi alır (müşteri "Güncellemeleri denetle" ile hemen). Kurulumun sürümü ve platformu tabloda görünür; platformu olmayanlar elle kurulumdur, onlara teklif gitmez.
3. Müşteride kurulum sahibi onaylar; güncelleyici yedek alır, uygular, sorun çıkarsa önceki sürüme ve yedeğe döner (`docs/OPERATIONS.md` §5). Durum müşteride görünür; panelde "Bu sürümde kurulum" sayısı sonraki kalp atışıyla artar.
4. Sorunlu sürüm: **Sürümü geri çek** (yeni teklif kesilir, gönderilmiş hedefler temizlenir; kurulmuş olanlar etkilenmez). Seçili lisanslardan göndermeyi geri almak için **Seçilenlerden geri al**.

Güvenlik: kit indirmesi `/v1/releases/<sürüm>/<dosya>?t=<belirteç>` ile yapılır; belirteç kalp atışında kuruluma özel verilir (HMAC, `LICENSE_DATA_KEY`'den türetilen anahtar, 24 saat), etkin olmayan kuruluma dosya verilmez. Bütünlüğü belirteç değil, **imzalı manifesto + SHA-256** sağlar: lisans sunucusu ele geçirilse bile satıcı anahtarı olmadan kurulumlara kabul edilecek bir kit gönderilemez. Kit arşivleri `RELEASES_DIR` altında saklanır (compose: `releases` birimi; yedek gerektirmez, yeniden üretilebilir).

## 6. Lisans verme, yenileme, taşıma (adım adım)

**Yeni müşteri.** Panel › Müşteriler › *Yeni müşteri* → *Lisans ver*: sektörleri seçin, cihaz kotası/şirket sınırı/bitiş tarihini girin → **kodu** müşteriye güvenli
kanaldan iletin (kod bir kez gösterilir; kaybolursa *Yeni kod üret*). Müşteri uygulamayı kurar, açılışta çıkan *Lisansınızı etkinleştirin* sayfasına kodu girer.

**Yenileme (abonelik uzatma).** *Süreyi uzat*. Müşterinin uygulaması bir sonraki kalp atışında (en geç ~12 saat) yeni süreyi alır; hemen almak için sahibi
Ayarlar › Lisans › *Şimdi yenile*'ye basar. Değişen kota/sektörler de aynı yolla uygulanır (**sektör daraltırsanız, kapsam dışı kalan şirketler kalp atışından sonra kapanır**).

**Askıya alma / iptal.** *Askıya al* geri alınabilir; *İptal et* yeni etkinleştirmeyi de kapatır. İkisinde de müşterinin kurulumları sonraki kalp atışında
**salt-okunura** geçer (yazma kapanır, veriler görüntülenir/dışa aktarılır).

**Sunucu taşıma.** Müşteri eski sunucuda Ayarlar › Lisans › *Bu sunucuda lisansı kaldır*'a basar (satıcıya bildirilir, yuva boşalır), veritabanı yedeğini yeni sunucuya
geri yükler ve **aynı kodla** yeniden etkinleştirir. Eski sunucuya erişilemiyorsa panelde ilgili **etkinleştirmede** *Devre dışı bırak* (taşıma hakkı sayılır).
Veritabanı kopyası yeni sunucuda parmak izi uyuşmazlığı yüzünden salt-okunura düşer; yeniden etkinleştirme bunu açar. Aynı kurulum kimliği iki sunucudan birden kalp atışı
atarsa (klon) panelde **bayraklanır**; 3 farklı IP/24 saat ya da >3 parmak izi değişimi eşiktir.

**İnternet erişimi olmayan sunucu (çevrimdışı).** Lisansta *Çevrimdışı etkinleştirmeye izin ver* açık olmalı. Müşteri uygulamada *İstek kodu oluştur* der ve size iletir;
panel › lisans › *Çevrimdışı lisans imzala*'ya yapıştırıp süreyi (en çok 400 gün) verirsiniz; dönen metni müşteri uygulamaya yapıştırır. Kira bitince yeni istek kodu gerekir.

**Denetim kaydı.** Tüm yönetici/CLI işlemleri ve etkinleştirme olayları panelde *Denetim kaydı*'nda, yalnızca eklenir (veritabanı tetikleyicisi, sahip rol dahil silemez).

## 7. Lisans alanları ve davranış

| Alan | Etkisi |
|---|---|
| Sektörler | Şirket yalnızca bu sektörlerde açılır; mevcut şirketin sektörü lisans kapsamında olmalıdır (veritabanında sektörü elle değiştirmek işe yaramaz). |
| Cihaz kotası | En fazla bu kadar etkin kayıtlı tarayıcı (§8). |
| Şirket sınırı | Kurulumdaki toplam şirket sayısı (kuruluşlar arası, eşzamanlı açmalarda da aşılmaz). |
| Abonelik bitişi | Kira hiçbir zaman bunu aşamaz. |
| Kira / tolerans | 7 / 14 gün varsayılan; lisans başına ayarlanır. |
| Boşta cihaz günü | Bu kadar süre görülmeyen cihaz kotadan düşer (varsayılan 30). |
| Sunucu sayısı | Aynı anda etkin kurulum sayısı (varsayılan 1). |
| Çevrimdışı | Çevrimdışı imzaya izin. |

**Durumlar** (uygulama, her istekte imzalı kiradan hesaplar):

| Durum | Ne zaman | Davranış |
|---|---|---|
| Lisanssız | Hiç kira yok | Yalnızca sağlık, genel yapılandırma ve lisans uçları; arayüz etkinleştirme sayfasını gösterir. |
| Etkin | Kira geçerli | Tam işlevli (bitişe 14 gün kala uyarı bandı). |
| Tolerans | Kira bitti, tolerans sürüyor | Tam işlevli + sarı uyarı bandı (lisans sunucusuna ulaşılamıyor). |
| Salt-okunur | Tolerans bitti ya da iptal/askı/parmak izi uyuşmazlığı/saat geri alma/bozuk kayıt | GET/HEAD serbest (dışa aktarma dahil); yazma `402 LICENSE_RESTRICTED`; oturum açma, parola işlemleri, lisans ve cihaz yönetimi açık. |

## 8. Cihaz koltukları

- İlk girişte sunucu bir **cihaz** kaydeder ve tarayıcıya `erp_device` çerezini (HttpOnly, SameSite=Strict, yalnızca `/api/auth`) verir. Aynı tarayıcıda yeni giriş **yeni koltuk tüketmez**; aynı cihazı birden çok kullanıcı kullanabilir.
- **Çerezleri temizleyen ya da gizli pencerede giren kullanıcı yeni cihaz sayılır**; eski kayıt boşta kalana (varsayılan 30 gün) ya da yönetici kaldırana dek koltuk tüketir.
- Kota dolunca yeni cihaz `403 DEVICE_LIMIT_REACHED` alır. Yönetici (sahip/yönetici rolü) **Ayarlar › Cihazlar**'dan listeler, yeniden adlandırır, kaldırır. Kaldırılan cihazın erişim belirteci ve oturumu kapanır.
- Koltuk sayımı bir danışma kilidiyle seridir: son koltuk için eşzamanlı girişlerde yalnızca biri kazanır. Kota sonradan düşürülürse mevcut cihazlar çalışmaya devam eder, yenisi alınmaz.
- **Kurtarma (kimse giremiyorsa):** `docker compose … exec app node dist/admin.js devices` (listele), `devices:revoke --id=<ön ek>`, `devices:revoke-all --yes`.
- Bilinen sınır: çerezi başka bilgisayara kopyalayan biri aynı koltuğu paylaşır (tarayıcı fiziksel donanım kimliğini okuyamaz); bu, sözleşmeyle ve "kullanım raporu" (kalp atışındaki cihaz sayısı) ile kontrol edilir.

## 9. Müşteri kılavuzu

**Kurulum.** `docs/OPERATIONS.md` (Docker Compose). Ek olarak: ana makinede `/etc/machine-id` bulunmalı (compose salt-okunur bağlar; yoksa `systemd-machine-id-setup`),
uygulama sunucusundan **lisans sunucusuna HTTPS (443) çıkışı** açık olmalı, sunucu saati doğru olmalı (NTP; ±10 dakikadan fazla sapma reddedilir).

**Etkinleştirme.** Uygulamayı ilk açtığınızda *Lisansınızı etkinleştirin* sayfası çıkar; satıcınızdan aldığınız kodu girin. İnternet yoksa aynı sayfada *Çevrimdışı etkinleştirme*.
Lisans etkinleşince kayıt/giriş açılır. Lisans durumu, kapsamı ve kullanımı **Ayarlar › Lisans**'ta görünür.
Lisansı yenileme/devre dışı bırakma, güncellemeler ve cihazlar **kurulumun sahibi kuruluşa** aittir: ilk şirketi açan kuruluşun şirket sahipleri
(cihazlarda yöneticileri de) yönetir; açık kayıtla gelen başka bir kuruluş yönetemez (`docs/OPERATIONS.md` §4).

**Günlük kullanım.** Kira kendiliğinden yenilenir. Sarı bant "Lisans doğrulanamıyor" derse sunucunun internet erişimini kontrol edin; tolerans süresi içinde işiniz aksamaz.
Kırmızı bant "Salt-okunur mod" ise verilerinizi görüntüleyip dışa aktarabilirsiniz; yazma için satıcınızla iletişime geçin (süre yenileme ya da askının kaldırılması).

**Yeni şirket.** Yeni şirketi mevcut bir şirketin sahibi ya da yöneticisi açar; sektör, lisansınızdaki sektörlerle sınırlıdır; şirket sınırına ulaşınca oluşturma kapanır.

**Sunucu taşıma.** §6'daki adımlar. **Yedek:** lisans durumu veritabanı yedeğine dahildir; aynı PostgreSQL kümesine geri yüklemek lisansı etkilemez, **başka bir kümeye** (yeni sunucu, yeniden kurulan PostgreSQL, silinip yeniden yaratılan Docker veritabanı birimi) geri yüklemek parmak izi değiştiği için salt-okunura düşürür; **Ayarlar › Lisans**'tan aynı kodla yeniden etkinleştirme açar (adımlar: `docs/OPERATIONS.md` §6 "Lisans ve başka sunucuya geri yükleme").

**Sorun giderme.**

| Belirti | Neden | Ne yapmalı |
|---|---|---|
| "Lisans sunucusuna ulaşılamadı" | Çıkış HTTPS kapalı / DNS / lisans sunucusu kapalı | Sunucudan `curl https://<lisans-adresi>/healthz`; güvenlik duvarı; satıcıya haber verin. |
| `CLOCK_SKEW` | Sunucu saati yanlış | NTP'yi düzeltin. |
| "Salt-okunur — sunucu değişmiş olabilir" | Veritabanı başka makineye taşındı / `machine-id` değişti | Ayarlar › Lisans ya da etkinleştirme sayfasından **aynı kodla yeniden etkinleştirin**. |
| "Salt-okunur — saat geri alınmış" | Sunucu saati daha önce görülenden geri gitti | Saati düzeltin; son görülen zamanı geçince kendiliğinden açılır. |
| "Lisans kaydı doğrulanamadı" | Veritabanındaki lisans bozuldu | *Şimdi yenile* kendiliğinden onarır; olmazsa yeniden etkinleştirin. |
| `DEVICE_LIMIT_REACHED` | Cihaz kotası dolu | Yönetici Ayarlar › Cihazlar'dan kullanılmayanı kaldırır; ya da kota artırımı isteyin. |
| `INVALID_CODE` / `ACTIVATION_LIMIT` | Kod hatalı / lisans başka sunucuda etkin | Kodu kontrol edin; eski sunucuda lisansı kaldırın ya da satıcıdan devre dışı bıraktırın. |

## 10. Güvenlik modeli ve tehdit tablosu

| Tehdit | Önlem | Sonuç |
|---|---|---|
| Sahte lisans üretme | Ed25519 imza; özel anahtar yalnızca lisans sunucusunda (parola ile mühürlü dosya); uygulamada yalnızca açık anahtar(lar) | Engellenir |
| Veritabanında kira/lisansı düzenleme | Kira imzalı ve kuruluma + parmak izine bağlı; her okumada (en geç 60 sn) imza yeniden doğrulanır; bozuksa salt-okunur | Engellenir (en fazla geçici salt-okunur; kalp atışı onarır) |
| Eski (geçerli imzalı) kirayı geri koyma | Kira kısa ömürlüdür (7 gün); uygulamaya yeni alınan kira, eskisinden eski `issuedAt` ile kabul edilmez | En çok eski kiranın kalan süresi (kira + tolerans) |
| Lisansı/DB'yi başka sunucuya kopyalama | Parmak izi uyuşmazlığı → salt-okunur; satıcıda `maxActivations`; aynı kurulum iki IP'den kalp atışı atarsa bayrak | Engellenir/saptanır |
| Ağı kesme | Kira + tolerans sonunda salt-okunur | En çok ~3 hafta gecikme |
| Saati geri alma | DB'de ve bellekte en yüksek görülen zaman (yerel + satıcı saati); geri gidilirse kilit; uygulama hesabı geri alamaz (tetikleyici) | Engellenir (10 dk NTP toleransı) |
| Cihaz kotasını çerez silerek aşma | Her yeni çerez koltuk tüketir; boşta/yönetici kaldırma ile düşer; satıcıya cihaz sayısı raporlanır | Sınırlı/saptanır |
| Çerez kopyalama ile koltuk paylaşma | — | **Engellenemez** (sözleşme + kullanım raporu) |
| Koddaki kontrolleri yamalama | Dağınık bağımsız kapılar (genel kanca, `authedRoute`/`tenantRoute`, şirket açma, oturum), derleme zamanı zorlama sabiti, küçültülmüş paket, kaynak haritası yok, depo müşteriye verilmez | **Zorlaşır, engellenemez** |
| Yeniden oynatma (ağdaki saldırgan) | Yanıt istemcinin nonce'una bağlı; saat farkı >10 dk reddedilir; kalp atışı zarfı kurulum anahtarıyla imzalı ve artan zaman damgalı | Engellenir |
| Yönetim panelinin ele geçirilmesi | Parola + zorunlu TOTP (tek kullanımlık kod), kilitleme, CSRF başlığı + köken, SameSite=Strict, IP kısıtı (Caddy), denetim kaydı | Azaltılır |
| Satıcı anahtarının ele geçirilmesi | Mühürlü dosya + parola; çevrimdışı yedek; döndürme prosedürü (§11) | Belgeli risk |

Uygulama tarafı kapılar (hepsi bağımsız): (1) genel `onRequest` kancası, (2) `authedRoute`/`tenantRoute` içinde ikinci denetim, (3) şirket açma (sektör + sınır), (4) şirketin sektörünün her istekte lisansa karşı denetimi,
(5) oturum açma/yenileme sırasında cihaz koltuğu, (6) erişim belirtecinde cihaz denetimi. Kira imza doğrulaması ve parmak izi değerlendirmesi saf işlevlerdedir (`lisans-server/core`) ve birim testlidir.

## 11. Anahtar döndürme ve ele geçirilme

Halka birden çok anahtar taşıyabilir (`kid`) ve iptal listesi vardır: `{"keys":{"k1":"…","k2":"…"},"revoked":["k1"]}`.

**Planlı döndürme.**
1. Yeni anahtar üretin: `keygen --kid=k2 --out=…` (yeni parola).
2. Açık anahtarı `public-keys.json`'a **ekleyin** (k1 kalsın), yeni imaj derleyip müşterilere dağıtın (halka {k1,k2}).
3. Tüm müşteriler güncelleyince lisans sunucusunu **k2 dosyasıyla** yeniden başlatın (yeni kiralar k2 ile imzalanır; k1 imzalı eski kiralar süresine kadar geçerli kalır).
4. Bir sonraki imajda `"revoked":["k1"]` yapın.

**Özel anahtar sızdıysa.** Hemen yeni anahtar üretin ve yukarıdaki adımları **acil** uygulayın: yeni imajda `revoked:["k1"]`. **Dürüst sınır:** eski imajlar k1'e güvenmeye devam eder ve uzaktan iptal edilemez; sızıntı
sahibi eski imaj çalıştıran müşteriler için kira üretebilir. Bu yüzden müşteri sözleşmesinde "destek kapsamında güncel imaj" koşulu olmalı ve müşterilerin güncellemesi istenmelidir.
Panel/CLI kullanıcı bilgileri de sızdıysa: `admin:reset`, `LICENSE_DATA_KEY` değişimi (TOTP'ler yeniden kurulur).

## 12. Yedekleme ve işletim (lisans sunucusu)

**Yeni üretim kurulumunun varsayılanı:** lisans sunucusu ve Cloudflare Tunnel birlikte Docker içinde çalışır, adres `https://admin.er0s3c.com`, dışarı açılan host portu yoktur. Kaynak kodsuz imaj, günlük DB/dosya/anahtar yedeği ve kontrollü main dağıtımı için [Docker + Tunnel kurulum kılavuzunu](DOCKER-TUNNEL-KURULUM.md) kullanın. Aşağıdaki eski compose örnekleri geliştirme/önceki kurulumlar içindir.

- **Veritabanı:** `scripts/backup.sh` (lisans compose'u için `COMPOSE_FILE=lisans-server/deploy/docker-compose.yml`, `ERP_DB_NAME=erp_license`); günlük, ofis dışı, şifreli. Geri yükleme `scripts/restore.sh` (`docs/OPERATIONS.md` §6).
- **Anahtar dosyası + parola + `.env`** ayrı, çevrimdışı ve şifreli yedek: bunlar olmadan yeni lisans imzalanamaz.
- **İzleme:** `/healthz`; panelde *Özet* (30 gün içinde bitenler, klon şüphesi); günlükler JSON.
- **Kesinti:** lisans sunucusu kısa süre kapalı kalırsa müşteriler kira (7 gün) + tolerans (14 gün) boyunca etkilenmez. Uzun kesinti planlıyorsanız kira/tolerans sürelerini lisans bazında artırın.
- **Tek örnek varsayımı:** oran sınırı bellek içidir; lisans sunucusu tek örnek çalışır.

## 13. Geliştirme ve test

- Geliştirmede lisans denetimi **kapalıdır** (`NODE_ENV≠production`); açmak için `LICENSE_ENFORCEMENT_DEV=true` ve `LICENSE_DEV_KEYRING='{"keys":{…}}'`.
- Testler: `lisans-server/core` (belirteç, durum makinesi, TOTP), `lisans-server/server` (genel/yönetim uçları, panel sunumu; gerçek PostgreSQL), `apps/api/test/licensing*.test.ts`, `devices.test.ts` (sahte satıcıyla istemci sözleşmesi),
  e2e: `license-api`, `license-ui`, `license-admin` (gerçek lisans sunucusu + küçültülmüş üretim paketi). CI `lisans-server/tools/ci-license-host.sh` / `lisans-server/tools/ci-license-docker.sh` ile gerçek lisans sunucusu kurar.
- Ortam değişkenleri — **uygulama:** `LICENSE_SERVER_URL`, `LICENSE_ALLOW_INSECURE_URL`, `LICENSE_HOST_ID_FILE`, `LICENSE_ENFORCEMENT_DEV`, `LICENSE_DEV_KEYRING`. **Lisans sunucusu:** `DATABASE_URL`, `LICENSE_SIGNING_KEY_FILE`,
  `LICENSE_SIGNING_KEY_PASSPHRASE`, `LICENSE_DATA_KEY`, `LICENSE_ADMIN_ORIGIN`, `TRUST_PROXY`, `ADMIN_COOKIE_SECURE`, `RATE_LIMIT_ENABLED`, `LOG_LEVEL`, `PANEL_DIST_DIR`, `SHUTDOWN_TIMEOUT_MS`, `APP_VERSION`.

## 14. Kapsam dışı (şimdilik)

Ödeme/fatura entegrasyonu, eklenti (modül) bazlı lisans, çok kiracılı barındırmada kiracı başına lisans, kurulum bazında uzaktan "kill switch" ve sahip onaylı uzaktan güncelleme dışında uzaktan müdahale, sahip onayı olmadan otomatik güncelleme, çerez kopyalama tespiti.
Lisans metni/EULA ve sözleşme hukuki belgedir: avukata yazdırılmalıdır (`docs/LEGAL-NOTES.md` §11).
