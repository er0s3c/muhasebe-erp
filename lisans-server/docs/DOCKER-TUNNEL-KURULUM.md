# Docker ve Cloudflare Tunnel ile lisans merkezi

Üretim adresi **https://admin.er0s3c.com**. Uygulama, PostgreSQL, Caddy ve cloudflared Docker Compose içinde çalışır. Varsayılan kurulum hiçbir sunucu portunu yayımlamaz; HTTPS Cloudflare kenarında sonlanır. Caddy ile uygulama arasındaki HTTP aynı makinenin özel Docker ağı içindedir. İmza anahtarı, veritabanı ve sürüm dosyaları kalıcı saklanır.

## İlk kurulum

1. GitHub'da **Lisans sunucusunu dağıt** workflow'unu `deploy_now=false` ile çalıştırın. Aynı main commit'inin CI kontrolü başarılı olmalıdır. Özel GHCR imajının tam `ghcr.io/er0s3c/muhasebe-erp-license@sha256:…` adresini ve `lisans-vps-kurulum` artifact'ını alın. GHCR paket görünürlüğünün de **private** olduğunu kontrol edin.
2. Cloudflare panelinde yönetilen bir Tunnel oluşturun. **Published application route** alanında hostname `admin.er0s3c.com`, Service Type **HTTP**, URL **`caddy:80`** seçin. Docker container içindeki `localhost` Caddy değildir. İlgili DNS kaydı Tunnel'a bağlanmalı; sunucu IP'sine A kaydı ve 80/443 açılması gerekmez.
3. Kurulum arşivini Ubuntu/Debian sunucusuna aktarın; indirdiğiniz `SHA256SUMS` dosyasıyla `sha256sum -c SHA256SUMS` çalıştırın, arşivi açın. Açılan klasörde `sudo bash tools/setup-vps.sh` çalıştırın.
4. Alan adını ve e-postanızı girin. Depo adı `er0s3c/muhasebe-erp` ve sayısal depo kimliği `1395438415` otomatik doldurulur. İmaj alanı `docker pull ghcr.io/er0s3c/muhasebe-erp-license:SÜRÜM`, doğrudan etiketli adres veya tam `@sha256` adresini kabul eder. Varsayılan `docker pull` komutu paketin `RUNTIME_IMAGE` dosyasındaki yayımlanmış imajdan alınır; kurulum araçlarının COMMIT kimliğinden imaj etiketi türetilmez. Kurulum indirdiği etiketi sabit digest adresine çevirerek kaydeder. Normal alanlarda sağ/sol ok, Home/End ve silme tuşlarıyla düzenleme yapılır; hatalı alan yeniden sorulur. Tunnel sorusunda **1** seçin. Token'ı sadece sunucudaki gizli giriş istemine yapıştırın. Sohbete veya repoya yazmayın. Gerekirse özel imaj için yalnız `read:packages` yetkili GHCR anahtarı ayrı gizli istemde alınır. Gizli token alanları ekranda gösterilmez ve Readline geçmişine alınmaz.
5. Kurulumun verdiği tek kullanımlık kodla `https://admin.er0s3c.com/setup` sayfasını açın, yönetici hesabınızı ve zorunlu MFA'yı kurun. İmza anahtarının açık kısmını ERP üretim derlemesinin güvenilen anahtar halkasına alın; özel anahtar müşteriye gitmez.

Token, `/etc/muhasebe-lisans/tunnel-token` dosyasında yalnız container kullanıcısının okuyabildiği izinle tutulur. Komut argümanına veya container ortam değişkenine konmaz. Kurulum klasörü root erişimindedir. Token ile anahtarları içeren yedekleri şifreli, sunucu dışı depoya taşıyın.

Özel GHCR imajı için ilk indirmede `unauthorized` görülürse kurulum GitHub kullanıcı adını ve **Personal access token (classic)** ister. Anahtarı GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) üzerinden, yalnız **read:packages** yetkisiyle oluşturun. GitHub hesabı parolası, fine-grained token veya Cloudflare Tunnel token'ı bu alan için uygun değildir. Paket hesabınıza indirme yetkisi verilmiş olmalıdır. Ayrıntı: [GitHub Container registry kimlik doğrulaması](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-with-a-personal-access-token-classic).

Bir düzeltme arşivi tam kurulum paketinin içine uygulanır; tek başına kurulmaz. `deploy/` ve tüm bakım araçları eksikse kurulum, sistemde değişiklik yapmadan önce anlaşılır hata ile durur.

Cloudflare Tunnel'ın `--token-file` desteği kullanılır. [Resmî Tunnel parametreleri](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/).

## Cloudflare kuralları

- Bu host için **cache bypass** uygulayın; API cevapları ve indirmeler önbelleğe alınmamalı. Caddy ayrıca `Cache-Control: no-store` gönderir.
- `/v1/*`, `/v2/time`, `/ci/api/*`, `/downloads/*`, `/healthz` uçlarına interaktif Access giriş ekranı veya tarayıcı challenge koymayın: ERP ve CI tarayıcı oturumu kullanmaz. Bu uçlar lisans imzası, GitHub OIDC veya süreli indirme token'larıyla kendi yetkisini denetler. `/healthz` yalnız sağlık bilgisini verir.
- Yönetim paneli kendi parola + MFA + CSRF denetimini sürdürür. Ek Cloudflare Access koruması kullanacaksanız yalnız panel ve `/admin/api/*` yollarını kapsayın; yukarıdaki makine uçlarını engellemeyin. Caddy `LICENSE_ADMIN_ALLOW` ile panel IP kısıtlaması da destekler.
- Büyük müşteri paketlerinin indirilmesi ve CI yüklemesi için Cloudflare planınızın istek boyutu/zaman sınırlarını doğrulayın. CI yüklemeleri 8 MB parçalar kullanır.

## Güncelleme ve bakım

Sunucu kodu main'e gönderilip CI geçince lisans imajı güncellenebilir; müşterilerin ERP sürümü bu işlemle değişmez. Mevcut Tunnel kimliği ve kalıcı veriler korunur. GitHub için kısıtlı SSH dağıtım hesabını `sudo erp-license-configure-deploy /tam/yol/deploy.pub` ile hazırlayın; ayrı anahtar kullanın. `LICENSE_DEPLOY_HOST`, `LICENSE_DEPLOY_USER`, `LICENSE_DEPLOY_SSH_KEY`, `LICENSE_DEPLOY_KNOWN_HOSTS` değerlerini GitHub Actions secrets'a girin. SSH host anahtarını güvenilir ayrı kanaldan doğrulayın.

Tunnel web erişimini taşır; mevcut workflow'un SSH dağıtım bağlantısını kendiliğinden sağlamaz. GitHub runner'ın ulaşabildiği ayrı kısıtlı SSH bağlantısı gerekir. SSH erişimi kurulmadan otomatik canlı dağıtım hazır değildir; imaj hazırlama `deploy_now=false` ile kullanılabilir.

```bash
sudo erp-license-backup
sudo erp-license-restore /tam/yol/license-YYYYMMDDTHHMMSSZ.tar.gz
sudo docker compose --project-directory /etc/muhasebe-lisans \
  --env-file /etc/muhasebe-lisans/.env \
  -f /etc/muhasebe-lisans/compose.yml \
  -f /etc/muhasebe-lisans/compose.tunnel.yml ps
```

Yedekleme her gün 02:15'te çalışır. Tutarlı veritabanı ve paket yedeği için lisans HTTP hizmeti kısa süre durdurulur, işlem sonunda yeniden açılır; Tunnel açık kalır. Yedek veritabanı, imza anahtarı, sürüm deposu, ayarlar ve Tunnel token'ını içerir. Normal veri geri yüklemesi mevcut Tunnel token'ını korur; döndürülmüş token eski yedekle değiştirilmez. Yeni sunucuda önce yeni Tunnel token'ıyla kurulum, ardından veri geri yükleme yapılır.

Cloudflared imajı değişmez digest ile sabitlenir; ERP lisans sunucusu dağıtımı Tunnel imajını sessizce değiştirmez. Token döndürürken root olarak korunan dosyayı yenileyip yalnız cloudflared container'ını yeniden oluşturun. Cloudflare panelindeki Tunnel bağlantısını ve `https://admin.er0s3c.com/healthz` yanıtını denetleyin.

Mevcut sunucu cloudflared hizmetini kullanmak için kurulumda **2** seçilebilir; o durumda hedef `http://127.0.0.1:4080` olur ve port yalnız loopback üzerinde açılır. Varsayılanınız Docker içindeki Tunnel'dır.
