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
**kayıtlı etkin cihaz sayısı ile şirket sayısı**. Kullanıcı, müşteri, fatura, stok, tutar gibi hiçbir muhasebe verisi gönderilmez. Sunucu IP adresini
TCP bağlantısı gereği görür (klon şüphesi tespitinde kullanılır; `docs/LEGAL-NOTES.md` §11). Bu açıklama uygulamada da (Lisans sayfası) vardır.

## 4. Satıcı kurulumu (lisans sunucusu, VPS)

### 4.1 Gereksinimler

Docker + Compose, bir alan adı (DNS bu sunucuya, 80/443 açık), ~1 GB bellek. Lisans sunucusu ayrı bir PostgreSQL kullanır (aynı compose içinde).

### 4.2 Anahtar töreni (bir kez; en önemli adım)

```bash
git clone … && cd muhasebe-erp
docker build -f apps/license-server/Dockerfile -t muhasebe-lisans .
mkdir -p /etc/muhasebe-lisans && chmod 700 /etc/muhasebe-lisans
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
3. Dosya izinleri: yalnızca root okur (`chmod 600`); kapta `node` kullanıcısı `LICENSE_KEY_DIR` bağlamasından okur.

### 4.3 Sunucuyu ayağa kaldırma

```bash
cp deploy/license/.env.example deploy/license/.env   # parolaları doldurun (openssl rand -hex 24), LICENSE_DATA_KEY: openssl rand -base64 48
# LICENSE_DOMAIN, LICENSE_KEY_DIR=/etc/muhasebe-lisans, LICENSE_SIGNING_KEY_PASSPHRASE, LICENSE_ADMIN_ALLOW=<kendi IP adresiniz>/32
docker compose -f deploy/license/docker-compose.yml --env-file deploy/license/.env up -d --build
curl https://<alan-adı>/healthz        # {"ok":true,...}
```

- Herkese açık olan yalnızca **`/v1/*`** (müşteri uygulamaları) ve **`/healthz`**'dir. **Yönetim paneli ve `/admin/api`** Caddy'de `LICENSE_ADMIN_ALLOW`
  ile izin verilen adreslere kısıtlıdır: kendi IP adresinizi yazın (varsayılan "herkes" yalnızca ilk kurulum içindir). IP'niz değişiyorsa VPN/sabit IP kullanın.
- Veritabanı portu yayınlanmaz. Yönetici parolası/TOTP sırrı diskte şifrelidir (`LICENSE_DATA_KEY`).

### 4.4 Yönetici hesabı (panel: parola + zorunlu TOTP)

```bash
docker compose -f deploy/license/docker-compose.yml --env-file deploy/license/.env exec license \
  node dist/cli.js admin:create --email=siz@ornek.com --name="Ad Soyad"
```

Çıktıdaki **parola** ve **TOTP sırrı** yalnızca bir kez görünür: sırrı Authenticator uygulamasına (Google/Microsoft Authenticator, Aegis…) elle ekleyin.
Giriş: e-posta + parola + 6 haneli kod. Kurallar: aynı kod iki kez kullanılamaz, 5 başarısız denemede (IP+e-posta) ve 15'te (yalnızca e-posta) kilitlenir,
oturum 8 saattir, değiştiren isteklerde CSRF başlığı ve köken denetimi vardır. Parola/TOTP kaybolursa: `admin:reset --email=…`.

### 4.5 Komut satırı (panelin eşi; SSH ile)

`docker compose … exec license node dist/cli.js <komut>`:

| Komut | Ne yapar |
|---|---|
| `license:issue --customer="Ad" --sectors=RETAIL_MARKET,COMMERCE --devices=3 [--companies=1] [--valid-until=2027-12-31] [--kind=commercial\|trial\|demo] [--lease-days=7] [--grace-days=14] [--activations=1] [--offline]` | Lisans verir; etkinleştirme kodunu **bir kez** yazar. Müşteri yoksa oluşturur. |
| `license:list` | Lisansları listeler. |
| `license:extend --id=… --valid-until=YYYY-MM-DD` | Süreyi uzatır. |
| `license:suspend / resume / revoke --id=…` | Askıya alır / devam ettirir / iptal eder (kurulumlar sonraki kalp atışında etkilenir, en geç ~12 saat). |
| `license:code --id=…` | Yeni etkinleştirme kodu üretir (eskisi geçersiz olur). |
| `admin:create / admin:reset` | Yönetici oluşturur / parola ve TOTP'yi yeniler. |
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

**Günlük kullanım.** Kira kendiliğinden yenilenir. Sarı bant "Lisans doğrulanamıyor" derse sunucunun internet erişimini kontrol edin; tolerans süresi içinde işiniz aksamaz.
Kırmızı bant "Salt-okunur mod" ise verilerinizi görüntüleyip dışa aktarabilirsiniz; yazma için satıcınızla iletişime geçin (süre yenileme ya da askının kaldırılması).

**Yeni şirket.** Şirket açarken sektör, lisansınızdaki sektörlerle sınırlıdır; şirket sınırına ulaşınca oluşturma kapanır.

**Sunucu taşıma.** §6'daki adımlar. **Yedek:** lisans durumu veritabanı yedeğine dahildir; yeni sunucuya geri yüklemek parmak izi nedeniyle salt-okunura düşürür, yeniden etkinleştirme açar.

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
(5) oturum açma/yenileme sırasında cihaz koltuğu, (6) erişim belirtecinde cihaz denetimi. Kira imza doğrulaması ve parmak izi değerlendirmesi saf işlevlerdedir (`packages/license-core`) ve birim testlidir.

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

- **Veritabanı:** `scripts/backup.sh` (lisans compose'u için `COMPOSE_FILE=deploy/license/docker-compose.yml`, `ERP_DB_NAME=erp_license`); günlük, ofis dışı, şifreli. Geri yükleme `scripts/restore.sh` (`docs/OPERATIONS.md` §6).
- **Anahtar dosyası + parola + `.env`** ayrı, çevrimdışı ve şifreli yedek: bunlar olmadan yeni lisans imzalanamaz.
- **İzleme:** `/healthz`; panelde *Özet* (30 gün içinde bitenler, klon şüphesi); günlükler JSON.
- **Kesinti:** lisans sunucusu kısa süre kapalı kalırsa müşteriler kira (7 gün) + tolerans (14 gün) boyunca etkilenmez. Uzun kesinti planlıyorsanız kira/tolerans sürelerini lisans bazında artırın.
- **Tek örnek varsayımı:** oran sınırı bellek içidir; lisans sunucusu tek örnek çalışır.

## 13. Geliştirme ve test

- Geliştirmede lisans denetimi **kapalıdır** (`NODE_ENV≠production`); açmak için `LICENSE_ENFORCEMENT_DEV=true` ve `LICENSE_DEV_KEYRING='{"keys":{…}}'`.
- Testler: `packages/license-core` (belirteç, durum makinesi, TOTP), `apps/license-server` (genel/yönetim uçları, panel sunumu; gerçek PostgreSQL), `apps/api/test/licensing*.test.ts`, `devices.test.ts` (sahte satıcıyla istemci sözleşmesi),
  e2e: `license-api`, `license-ui`, `license-admin` (gerçek lisans sunucusu + küçültülmüş üretim paketi). CI `scripts/ci-license-host.sh` / `scripts/ci-license-docker.sh` ile gerçek lisans sunucusu kurar.
- Ortam değişkenleri — **uygulama:** `LICENSE_SERVER_URL`, `LICENSE_ALLOW_INSECURE_URL`, `LICENSE_HOST_ID_FILE`, `LICENSE_ENFORCEMENT_DEV`, `LICENSE_DEV_KEYRING`. **Lisans sunucusu:** `DATABASE_URL`, `LICENSE_SIGNING_KEY_FILE`,
  `LICENSE_SIGNING_KEY_PASSPHRASE`, `LICENSE_DATA_KEY`, `TRUST_PROXY`, `ADMIN_COOKIE_SECURE`, `RATE_LIMIT_ENABLED`, `LOG_LEVEL`, `PANEL_DIST_DIR`, `SHUTDOWN_TIMEOUT_MS`, `APP_VERSION`.

## 14. Kapsam dışı (şimdilik)

Ödeme/fatura entegrasyonu, eklenti (modül) bazlı lisans, çok kiracılı barındırmada kiracı başına lisans, kurulum bazında uzaktan "kill switch" dışında uzaktan müdahale, çerez kopyalama tespiti.
Lisans metni/EULA ve sözleşme hukuki belgedir: avukata yazdırılmalıdır (`docs/LEGAL-NOTES.md` §11).
