# Lisans ve sürüm yönetim merkezi

Üretim profili: **Docker Compose + Docker içinde Cloudflare Tunnel**, adres **https://admin.er0s3c.com**. Host portu yayımlanmaz. VPS'e uygulama kaynak deposu kopyalanmaz; özel GHCR'dan derlenmiş imaj indirilir.

- [Kolay Docker/Tunnel kurulumu ve işletim](docs/DOCKER-TUNNEL-KURULUM.md)
- [Lisans protokolü, yönetim paneli ve güvenlik](docs/LICENSING.md)
- `server/`: API, CLI ve veritabanı migration'ları
- `panel/`: yönetim arayüzü
- `core/`: ortak imza/lisans protokolü
- `deploy/`: Docker ve ters vekil yapılandırmaları
- `tools/`: kurulum, dağıtım, yedekleme/geri yükleme, paket hazırlama ve Tunnel testi

Depo kökünden `npm run build:license`, `npm test -w @erp/license-server`, `npm test -w @erp/license-core` çalıştırılır. Docker HTTP/port güvenlik testi: `node lisans-server/tools/test-tunnel.mjs`. Üretim VPS paketi: `node lisans-server/tools/package-vps.mjs <tam-HEAD-commit> --image ghcr.io/er0s3c/muhasebe-erp-license@sha256:<yayımlanmış-digest>`; yalnız temiz checkout kabul edilir. Geliştirme denemesi için `--local-test` kullanılır ve paketin `build-info.json` dosyasında işaretlenir.
