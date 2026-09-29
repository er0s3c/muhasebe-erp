# Muhasebe ERP

KKTC işletmeleri için sade ve güçlü, web tabanlı muhasebe/ERP. İlk hedef sektör inşaat ve taahhüt; market ve ticaret modülleri aynı çekirdeğin üstüne eklenecek şekilde tasarlandı.

**Durum:** Çekirdek ERP'nin ilk dilimi hazır (kiracılık, kimlik doğrulama, ayarlar, genel muhasebe, cari, stok, fatura). İrsaliye ve kasa/banka sıradaki adımlar: bkz. [docs/ROADMAP.md](docs/ROADMAP.md).

## Neler var?

- **Çok şirketli, yalıtılmış veri:** her satır bir şirkete aittir; PostgreSQL satır düzeyi güvenlik (RLS) uygulama hatası olsa bile başka şirketin verisini göstermez.
- **Değiştirilemez defter:** kaydedilen yevmiye değiştirilemez ve silinemez; düzeltme ters kayıtla yapılır. Borç=alacak, dönem kilidi ve hesap kuralları veritabanında da denetlenir.
- **Çoklu para birimi:** TL, GBP, EUR, USD. Dövizli satırlar işlem tarihindeki kurdan çevrilir; yönetim raporlaması için ikinci bir para birimi tutulabilir.
- **Cari hesaplar:** müşteri/tedarikçi kartı, ekstre, vadeye göre yaşlandırma, açık kalemler; cari kontrol hesabına (120/320) cari olmadan kayıt atılamaz.
- **Stok:** stok kartı, çoklu depo, giriş/çıkış/fire/transfer/devir, sayım, hareketli ağırlıklı ortalama maliyet, kritik seviye uyarısı, tarih anı stok değeri. Alış maliyeti EUR/GBP/TL girilebilir, hareket günü kuruyla çevrilir. Stok defteri değiştirilemez (düzeltme ters belgeyle); negatif stok şirket ayarıyla açılır.
- **Fatura:** satış, alış, gider, satış iadesi, alış iadesi. Kayıt; stok hareketini, cari alacak/borcu ve yevmiyeyi **tek işlemde** yazar; numara boşluksuzdur, kaydedilmiş fatura değiştirilemez (iptal = ters kayıt). KDV hariç/dahil fiyat, iskonto, dövizli fatura, orijinale bağlı iade, KDV özeti. **Hesap eşlemesi** ile elle girilen stok belgeleri de otomatik yevmiye üretir; stok değeri ile 150–157 hesapları baştan mutabıktır. Varsayılan hesaplar ve KDV oranları mali müşavirce doğrulanmamıştır.
- **Kur:** elle giriş ya da KKTC Merkez Bankası XML'inden içe aktarma (resmî adres veya dosya yükleme).
- **Rol bazlı yetki, sektöre göre menü, denetim izi, Türkçe arayüz** (çoklu dil altyapılı), açık/koyu tema, `Ctrl+K` komut paleti.

## Hızlı başlangıç

Gereksinimler: Node.js 22+, PostgreSQL 16 (ya da Docker). PostgreSQL'in ICU desteği gerekir (Türkçe sıralama için `tr-TR-x-icu`); resmî Docker imajı ve yaygın paketlerde vardır.

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
| `npm run db:seed` | Demo verisi yükler (üretimde çalışmaz) |
| `npm run tour` | Demo verisiyle tüm ekranların ekran görüntüsünü alır, mobilde yatay taşmayı denetler |
| `npm run licenses` | Bağımlılık lisanslarını denetler |

## Yapı

```
apps/api        Fastify API, Drizzle şeması ve SQL migration'ları (RLS, tetikleyiciler)
apps/web        React + Vite + Tailwind arayüzü
packages/shared Para hesabı, izinler, modül/sektör kaydı, doğrulama şemaları
docs/           Mimari, kapsam, hukuki notlar, yol haritası
e2e/            Playwright senaryoları
```

## Belgeler

- [Mimari](docs/ARCHITECTURE.md)
- [Tasarım sistemi](docs/DESIGN.md)
- [Kapsam ve işlev kontrol listesi](docs/SCOPE.md)
- [Hukuki notlar ve doğrulanması gerekenler](docs/LEGAL-NOTES.md) — ticari kullanımdan önce mutlaka okuyun
- [Yol haritası](docs/ROADMAP.md)

## Önemli uyarı

Hesap planı şablonu, KDV oranları ve kapsam belgesindeki tüm yasal parametreler **resmi kaynaktan doğrulanmamıştır**. Uygulama bunları sabit kodlamaz; mali müşavir/avukat onayıyla girilir. Ayrıntı: [docs/LEGAL-NOTES.md](docs/LEGAL-NOTES.md).
