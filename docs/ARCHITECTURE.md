# Mimari

## Genel görünüm

```
Tarayıcı (React) ──/api──▶ Fastify ──▶ PostgreSQL 16
                              │            ├─ RLS: company_id / organization_id
                              │            └─ tetikleyiciler: defter, denetim izi
                              └─ packages/shared (para, izin, modül kaydı, zod şemaları)
```

Tek veritabanı, tek API. Sektöre özgü davranış ayrı dağıtımlarla değil, **modül kaydı** ile açılıp kapanır.

## Kiracılık ve güvenlik

- `organizations` (lisans) → `companies` (tüzel kişi). Kullanıcı bir kuruluşa aittir; `memberships` ile şirket başına rol alır.
- Her istek **tek işlemde** çalışır. İşlemin başında `set_config('app.user_id' | 'app.org_id' | 'app.company_id', …, true)` çağrılır (işlem-yerel; havuza sızmaz).
- Tüm iş tablolarında `company_id` vardır ve RLS politikası `company_id = app_company_id()` şartını uygular. Bağlam yoksa hiçbir satır görünmez.
- Çalışma zamanı rolü `erp_app` **şema sahibi değildir** ve `BYPASSRLS` yoktur. Migration ve seed sahip rol (`erp`) ile çalışır.
- Kompozit yabancı anahtarlar (`(entry_id, company_id)`, `(account_id, company_id)`) başka şirketin kaydına bağlanmayı imkânsız kılar.
- Kimlik: argon2id, 15 dk'lık JWT (yalnızca bellekte), httpOnly refresh çerezi. Refresh her kullanımda döner; kullanılmış bir token'ın tekrar sunulması tüm oturumları kapatır. Giriş/kayıt hız sınırlıdır.
- Rol/izin eşlemesi `packages/shared/src/permissions.ts` içindedir (kod içi şablonlar). Özel rol tablosu gerçek ihtiyaç doğunca eklenecek.

## Defter kuralları (veritabanında)

`apps/api/drizzle/0001_rls_triggers_reference.sql`:

- Yevmiye yalnızca **taslak** olarak doğar; kaydedilirken tetikleyici şunları denetler: en az 2 satır, `Σ borç = Σ alacak` (defter para biriminde), tutar > 0, tarih döneme uyuyor, dönem açık.
- Kaydedilmiş yevmiye ve satırları `UPDATE`/`DELETE`'e kapalıdır. Tek istisnalar: `reversed_by_id` boşken doldurulabilir; boş raporlama tutarları doldurulabilir.
- Satır tetikleyicisi hesabın kayıt atılabilir, aktif ve para birimine uygun olduğunu doğrular.
- `audit_log` yalnızca ekleme alır (tetikleyici `SECURITY DEFINER`; uygulama rolünün tabloya yazma yetkisi yoktur).
- Düzeltme yalnızca **ters kayıt**la yapılır: borç/alacak yer değiştirir, orijinal kurlar kullanılır, iki kayıt birbirine bağlanır.
- Numara boşluksuzdur: `document_sequences` satırı işlemle birlikte kilitlenir; işlem geri alınırsa numara tüketilmez. Numara kaydetme anında atanır (taslakta yoktur).

## Para ve kur

- Tutarlar DB'de `numeric(19,4)`, kurlar `numeric(19,8)`; API'de string; TS'de `decimal.js`. `number` ile para hesabı yoktur.
- Satır tutarları küçük birime (2 basamak) yuvarlanarak defter para birimine çevrilir (`applyRate`).
- Kur arama: doğrudan → ters (1/kur) → defter para birimi üzerinden üçgenleme. Kayıtlı kur en fazla 10 gün eskiyse geçerlidir (hafta sonu/bayram payı); aksi halde `FX_RATE_MISSING`.
- **Raporlama para birimi tutarı türetilmiş yönetim verisidir:** kur yoksa kayıt engellenmez, tutar `NULL` kalır. Mizan eksik satır sayısını uyarır; kur girildikten sonra `POST /api/ledger/backfill-reporting` doldurur.

## Sektör/modül yalıtımı

`packages/shared/src/module-registry.ts` tek doğruluk kaynağıdır: her modül `{key, sectors, status}`; menü öğeleri `{module, permission}` taşır.

- `GET /api/navigation` menüyü şirketin sektörüne (`resolveEnabledModules`) ve kullanıcının rolüne göre süzer.
- `tenantRoute(app, { module, permission }, handler)` uç noktayı korur: modül etkin değilse `403 MODULE_DISABLED`.
- Web'de her sayfa `React.lazy` ile ayrı parçadır; `RequireModule` etkin olmayan modülün sayfasını hiç yüklemez.
- `status: 'planned'` modüller henüz hiçbir şirkete açılmaz.

### Yeni modül eklemek

1. `MODULES` ve `NAV_ITEMS` içine kayıt ekleyin (sektörler, izin, ikon).
2. `apps/api/src/modules/<ad>/` altında rotaları `tenantRoute` ile yazın; şemaya `company_id` ekleyin, migration'da RLS politikası ve gerekiyorsa denetim tetikleyicisi tanımlayın (mevcut `DO` bloklarındaki tablo listesine ekleyin).
3. `apps/web/src/features/<ad>/` altında sayfaları yazın, `router.tsx`'e lazy olarak `RequireModule` altında bağlayın, metinleri `i18n/tr.json`'a ekleyin.
4. Gerçek PostgreSQL üzerinde izolasyon ve yetki testlerini ekleyin.

## Arayüz

React 19 + Vite + Tailwind v4. Renk/yüzey belirteçleri CSS değişkenidir (açık/koyu). Sunucu durumu TanStack Query'dedir; sorgu anahtarları şirket kimliği içerir (şirket değişince önbellek karışmaz). Formlar react-hook-form + paylaşılan zod şemaları. Tüm metinler i18next üzerinden; anahtarlar derleme zamanında tip denetimlidir.

## Test stratejisi

- `packages/shared`: saf birim testleri (para, modül kaydı, izinler, şemalar).
- `apps/api`: `app.inject` ile **gerçek PostgreSQL** üzerinde entegrasyon testleri; her çalıştırmada test şeması sıfırlanır. RLS, değiştirilemezlik, dönem kilidi, eş zamanlı numaralama, rol izinleri ve modül yalıtımı doğrudan ham SQL ile de sınanır.
- `e2e/`: Playwright ile kayıt → kurulum → kur → dövizli yevmiye → mizan akışı.

## Bilinen sınırlar

- Ana JS paketi ~580 kB (gzip ~187 kB); `manualChunks` ile bölünebilir.
- `company_modules` istisnalarını yönetecek arayüz henüz yok (kod ve testler var).
- Sunucu tsx ile çalışır; üretim derlemesi (bundle) ve dağıtım hattı yol haritasındadır.
