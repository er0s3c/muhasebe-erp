# Yerel doğrulama — 6 Ekim 2026

Docker ve Cloudflare Tunnel düzeni için yapılan kontroller:

| Kontrol | Sonuç |
| --- | --- |
| Ortak lisans çekirdeği | 4 dosya, 34 test başarılı |
| Lisans sunucusu: lisans, yönetim, OIDC, parçalı taslak yükleme, imzalı kurulum indirmesi | 10 dosya, 70 test başarılı; gerçek yerel PostgreSQL |
| ERP uzaktan güncelleme akışı ve bakım kilidi | 5 test başarılı |
| Çalışma alanı tip denetimi | Başarılı |
| ESLint | Başarılı |
| Üretim lisans Docker imajı | Yerelde derlendi; ortak lisans kaynaklarının yeni dizinden kopyalanması doğrulandı |
| Tunnel Docker Compose | Docker içindeki profilde hiçbir host portu yok; alternatif host profili yalnız 127.0.0.1:4080 |
| Gerçek Caddy HTTP akışı | Doğru istemci IP'si, HTTPS başlığı, no-store, panel IP kısıtı, yanlış Host reddi, CI/zaman/indirme yolu erişimi doğrulandı |
| VPS shell araçları | Docker içindeki Bash ile söz dizimi kontrolü başarılı |
| Kaynak kodsuz VPS kurulum arşivi | İzinli dosya listesinden üretildi, içeriği kontrol edildi; yerel deneme build-info.json içinde localTest/dirty olarak işaretlendi |
| VPS giriş ve kurtarma regresyonları | 14 test; etiket/digest doğrulaması, eksik paket, ortam parolası aktarımı, mevcut anahtar, güvenli ayar okuma, mevcut yöneticiyle başarılı tekrar çalıştırma ve gerçek hata durumlarının korunması |
| Gerçek Docker anahtar üretimi | Mühürlü anahtar üretildi; ikinci çalıştırmada aynı anahtar korundu |
| PostgreSQL ilk kurulum ve kurtarma | Linux volume üzerinde eski 0700 izin hatası tekrarlandı; eksik roller tamamlandı; mevcut kayıt ve parolalar korundu; 0644 ile temiz kurulum doğrulandı |
| Veritabanından sunucuya zincir | Gerçek migration, uygulama rolüyle sunucu sağlık kontrolü ve ilk yönetici kurulum kodu üretimi doğrulandı |
| Açık onayla parola onarımı | Gerçek PostgreSQL 16 üzerinde iki farklı parola eşitlendi; salt okunur teşhis, yanlış konteyner/veri birimi/rol yetkisi/ayar izni reddi, yedekleme hatasında değişmeme, başarısız girişte eski parola doğrulayıcılarının aynen geri gelmesi ve eşzamanlı işlem kilidi doğrulandı |
| Onarım yedeği ve tekrar çalıştırma | Döküm ayrı test veritabanına geri yüklendi; kayıt, rol yetkileri, ayarlar, anahtar ve token korundu; ikinci çalıştırma parolaları değiştirmedi |
| Onarım sonrası hizmet | Eşitlenen parolalarla gerçek migration, uygulama rolüyle sunucu sağlık kontrolü ve yönetici kurulum kodu üretimi başarılı |
| Mevcut yöneticiyle kurulum sonu | Gerçek PostgreSQL ve lisans CLI ile oluşturulan yöneticide tekrar kurulum kontrolü `/login` adresini verdi; hesap kaydı değişmedi, yeniden kurulum kodu istenmedi |

Tekrarlamak için depo kökünde:

```bash
npm test -w @erp/license-core
npm test -w @erp/license-server
npm test -w @erp/api -- test/updates.test.ts
npm run typecheck
npm run lint
docker build -f lisans-server/server/Dockerfile -t muhasebe-lisans:test .
LICENSE_TEST_IMAGE=muhasebe-lisans:test node lisans-server/tools/test-tunnel.mjs
node --test lisans-server/tools/setup-input.test.mjs
LICENSE_TEST_IMAGE=muhasebe-lisans:test node lisans-server/tools/test-setup-keygen.mjs
LICENSE_TEST_IMAGE=muhasebe-lisans:test node lisans-server/tools/test-setup-database.mjs
LICENSE_TEST_IMAGE=muhasebe-lisans:test node lisans-server/tools/test-repair-db-credentials.mjs
```

Parola onarım testi, üretim root CLI betiğini izole Linux PostgreSQL konteynerinde çalıştırır. Docker taşıma çağrıları test adaptörüyle aynı gerçek PostgreSQL araçlarına yönlendirilir; son kurtarma çağrısı işaret dosyasıyla izlenir. Kilitler, yedekleme, SQL, parolalı TCP bağlantısı ve geri dönüş gerçek işlemlerdir. Migration ve sunucu sağlığı ayrıca gerçek lisans imajı ile sınanır. `LICENSE_TEST_IMAGE` verilmezse migration/sağlık/kod adımları çalıştırılmaz; CI bu değişkeni verir.

**Henüz doğrulanmayan canlı adımlar:** Cloudflare hesabında gerçek Tunnel/route oluşturma, gerçek token ile bağlantı, hedef VPS'te ilk kurulum ve dosyaları içeren geri yükleme tatbikatı, GitHub Actions secrets ile canlı otomatik dağıtım. Tunnel testi yerel Docker ağı üzerinde yapıldı; Cloudflare'a bağlı canlı uç testi olarak değerlendirilmemelidir.

Windows kurulumunun temiz makine pilotu bu raporun kapsamı değildir. Yerel kaynak değişikliklerinin GitHub'a push edilmesi ve yeni workflow'ların GitHub üzerinde çalıştırılması bu doğrulamayla yapılmış sayılmaz.
