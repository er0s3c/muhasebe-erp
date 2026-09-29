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

## Cari (müşteri/tedarikçi)

- Cari hareket ayrı bir defter değildir: **cari kontrol hesabı** (`accounts.party_control` = `receivable` için 120, `payable` için 320; alt hesaplar devralır) satırları bir cariye (`journal_lines.party_id`) bağlanır. Böylece tek doğruluk kaynağı yevmiye defteridir.
- Kural hem uygulamada (`prepareLines`: `PARTY_REQUIRED`, `PARTY_NOT_ALLOWED`, `PARTY_KIND_MISMATCH`, `PARTY_INACTIVE`) hem de veritabanında (`journal_lines_guard`) uygulanır; başka şirketin carisine bağlanmak bileşik yabancı anahtarla (`(party_id, company_id)`) imkânsızdır.
- **Bakiye** = borç − alacak (defter para birimi). Ekstre yürüyen bakiye ve para birimi bazında (orijinal tutar) bakiye verir; taslaklar hesaba girmez, ters kayıt aynı cariye işler.
- **Açık kalem ve yaşlandırma** (`modules/parties/aging.ts`, saf fonksiyon): alacak tarafında borç satırları, borç tarafında alacak satırları "kalem"dir; karşı taraf toplamı en eski **vadeden** (yoksa fiş tarihinden) başlayarak uygulanır (FIFO). Uygulanamayan fazla ödeme "avans" olarak ayrı gösterilir. Kovalar: vadesi gelmemiş, 1–30, 31–60, 61–90, 90+ gün. Fatura–tahsilat elle eşleştirme (M7) bu hesabın üstüne gelecek.
- **Türkçe sıralama/arama:** cari listesi `COLLATE "tr-TR-x-icu"` ile sıralanır ve arar (Ç, Ğ, İ, Ö, Ş, Ü doğru yerde; İ→i, I→ı). PostgreSQL'in ICU desteğiyle derlenmiş olması gerekir (resmî Docker imajı, Ubuntu/Debian paketleri ve EDB kurucusunda vardır).

## Stok

- **Stok defteri ayrı bir alt defterdir:** `stock_documents` (başlık) + `stock_movements` (belge başına etki satırları: işaretli miktar ve şirket para biriminde işaretli değer). Eldeki miktar/değer **ayrı bakiye tablosunda tutulmaz**, hareket toplamından türetilir; böylece sapma olmaz. Depo bazında yalnızca miktar izlenir, ürün maliyeti şirket geneli tek ortalamadır (depo değeri = miktar × ürün ortalaması).
- **Maliyet: hareketli ağırlıklı ortalama** (`modules/inventory/costing.ts`, saf fonksiyonlar). Çıkış değeri: tamamı boşaltılıyorsa kalan değerin tamamı (kuruş artığı kalmaz), aksi halde `round2(değer × çıkış / eldeki)`. Bakiye ≤ 0 iken referans maliyet `değer/miktar`, yoksa son alış maliyeti, yoksa 0.
- **Negatif stok** şirket ayarıdır (`companies.allow_negative_stock`; varsayılan kapalı, RETAIL_MARKET'ta açık). Kapalıyken çıkış uygulamada (`STOCK_INSUFFICIENT`) ve `stock_movements_insert_guard` tetikleyicisinde reddedilir. Açıkken eksi bakiye son maliyetle değerlenir; alış eksik bakiyeyi kapatırken maliyet farkı ayrı bir `cost_adjust` satırıyla (miktar 0) yazılır, böylece envanter değeri hep miktar × yeni ortalama kalır. Fark satılan mal maliyetine (621) gider: elle girilen belgede ve faturada kendiliğinden yevmiyeye yansır.
- **Çoklu para birimi:** giriş/devir satırında maliyet EUR/GBP/TL girilir, hareket tarihindeki kurla (`requireRate`) ya da elle kurla şirket para birimine çevrilir; orijinal para birimi, birim maliyet ve kur satırda kalır (tarihsel maliyet). Kartta alış ve satış fiyatı ayrı para birimlerinde tutulur.
- **Değiştirilemez:** hareket satırlarında `erp_app`'in UPDATE/DELETE yetkisi yoktur ve tetikleyici de reddeder; belge başlığında yalnızca `reversed_by_id` (boş → dolu) değişebilir. Düzeltme **ters belge** ile olur ve yalnızca ilgili ürünlerde belgeden sonra hareket yoksa yapılır (`STOCK_DOC_HAS_LATER_MOVEMENTS`); böylece durum tam eski haline döner. Belgeden sonra girilip yine belgeden sonra **tümüyle ters çevrilmiş** belge çiftleri (örn. iptal edilen fatura) ürünün durumunu değiştirmediği için hareket sayılmaz; sondan başa doğru iptal bu sayede mümkündür. Belge tarihi açık mali dönemde olmalıdır (uygulama ve tetikleyici).
- **Eşzamanlılık:** belge işlenirken ilgili ürün satırları `SELECT … FOR UPDATE` ile (id sırasıyla) kilitlenir, ardından numara alınır; tetikleyici de ürün satırını kilitler (ikinci savunma). Paralel iki çıkış testi bunu sınar.
- **Sayım:** taslak → işlendi. Fark, işleme anındaki depo bakiyesine göre hesaplanır; fazla ortalama maliyetle giriş, eksik çıkış olur; tek `count` belgesi üretilir. İşlenen sayım değişmez.
- **Muhasebe bağı (M6):** elle girilen stok belgeleri ve sayım, hesap eşlemesine göre **otomatik yevmiye** üretir (bkz. "Fatura ve otomatik yevmiye"); faturadan doğan belge kendi yevmiyesini faturadan alır. **Stok durumu** raporu, stok defteri değerini 150–157 hesaplarının defter bakiyesiyle karşılaştırır; iki kaynak da otomatik yazıldığı için fark baştan 0'dır (yalnızca M6 öncesi belgeler ve elle yevmiye farkı yaratır).
- Geriye dönük tarihli hareket geçmişi yeniden değerlemez (hareket, girildiği andaki ortalamayla maliyetlenir); raporlar hareket tarihine göre tarih anı değeri verir.

## Fatura ve otomatik yevmiye (M6)

- **Fatura türleri:** satış (`SF`), alış (`AF`), gider (`GF`, stoksuz), satış iadesi (`SIF`), alış iadesi (`AIF`). Numara kaydetme anında, türe ve yıla göre **boşluksuz** verilir (`INV:<tür>` sayacı); taslakta numara yoktur. Alış/gider/alış iadesinde tedarikçi fatura no zorunludur ve (cari, no) kaydedilmiş faturalarda tekildir.
- **Durum:** `draft → posted → cancelled`. Kaydedilmiş fatura değiştirilemez ve silinemez (`invoices_guard`, ERRCODE `ERP03` → `INVOICE_RULE_VIOLATION`); tek geçiş iptaldir. İptal = ters kayıt: stok belgesi ters çevrilir, yevmiye ters çevrilir, numara serinin parçası olarak kalır. Faturadan sonra aynı ürünlerde (ters çevrilmemiş) stok hareketi ya da faturaya kesilmiş iade varsa iptal engellenir; iade faturası kesilir.
- **Kaydetme tek işlemdir** (`invoices/posting.ts`): faturayı kilitle → KDV ve tutarları yeniden hesapla → stoku **saf planlayıcıyla** planla → fatura numarası → stok belgesi → yevmiye → satır maliyetleri → fatura durumu. Kilit sırası ürünler → numaralar. Paralel iki satış aynı stoğu aşamaz; aynı taslak iki kez kaydedilemez (testli).
- **Yevmiye kalıbı:** cari satırın defter tutarı, gövde satırlarının (satır başına yuvarlanmış `net_base`/`vat_base`) toplamıdır; böylece kur yuvarlaması fişi bozmaz. Satış: B cari (120) / A gelir (600) / A KDV (391); stoklu kalemlerde B 621 / A stok. Alış: B stok (150/153) + B gider + B KDV (191) / A cari (320); eksi bakiye kapanışındaki `cost_adjust` toplamı B 621 / A stok. Gider: B gider + B KDV / A cari. Satış iadesi cari/gelir/KDV'yi tersler, mal orijinal satırın **maliyetiyle** girer (kalan miktar tamamlanınca kalan maliyet: kuruş artığı kalmaz). Alış iadesi stoktan ortalama maliyetle çıkar; iade tutarıyla farkı 621'e gider.
- **KDV:** satırda `vat_code` → şirketin `tax_rates` kaydı (fatura tarihinde geçerli) → `vat_rate` anlık görüntü. Hesap `packages/shared/src/invoice-calc.ts` içindedir (API ve web aynı fonksiyon): KDV hariç modda satır başına yuvarlanır; KDV dahil modda net = brüt ÷ (1 + oran), fark KDV'ye yazılır. Oranlar **doğrulanmamıştır**; KDV özeti doğrulanmamış kodları ayrıca bildirir.
- **Hesap eşlemesi** (`account_mappings`, 13 anahtar): cari (120/320), gelir (600/610), maliyet (621), stok (150/153; inşaatta 150), KDV (391/191), varsayılan gider (632), stok fazlası (649), fire/noksanlık (659), sarf (710), devir karşı hesabı (500). Şirket kurulurken ve migration ile varsayılanlar yüklenir; Ayarlar'dan değişir. Cari eşlemeleri yalnızca kontrol hesabı olabilir, diğerleri kontrol/dövizli olamaz. Eksik eşleme `ACCOUNT_MAPPING_MISSING` ile açık hata verir. **Varsayılanlar mali müşavirce doğrulanmamıştır.**
- **Elle girilen stok belgeleri** aynı eşlemeyle otomatik yevmiye üretir: devir → B stok / A devir karşı hesabı; giriş → B stok / A stok fazlası; sarf → B sarf / A stok; fire → B zarar / A stok; sayım fazlası/eksiği ayrı hesaplara; transferde fiş yoktur. Ters belge, orijinal yevmiyenin ters kaydını yazar. M6 öncesi belgelerin yevmiyesi geriye dönük üretilmez.
- **Kaynak bağı:** `journal_entries.source_type/source_id` (`invoice`, `stock_document`); kaynak başına tek asıl yevmiye kısmi tekil indeksle zorlanır. Kaynaklı yevmiye API'den tek başına ters çevrilemez (`ENTRY_HAS_SOURCE`), faturadan doğan stok belgesi de (`STOCK_DOC_HAS_SOURCE`); ters kayıt kaynak belgeden yapılır. Fatura kaydedilirken tetikleyici satır toplamlarını, yevmiye kaynağını ve cari tutarın brüt tutara eşitliğini de denetler.
- **Kapsam dışı:** irsaliye (M6b), tevkifat/stopaj/damga, e-Fatura ve yasal fatura biçimi (Faz C), tahsilat/ödeme ve kur farkı (M7), kategoriye göre ayrı stok hesabı.

## Kur içe aktarma

`POST /api/exchange-rates/import`: `{ source: 'kktcmb', date? }` resmî adresten indirir, `{ source: 'xml', xml }` yüklenen dosyayı kullanır. İndirme fonksiyonu (`app.rateFetcher`) test için değiştirilebilir. Ayrıntı ve güvenlik notları: [LEGAL-NOTES.md](LEGAL-NOTES.md) §6.

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

React 19 + Vite + Tailwind v4. Renk/yüzey belirteçleri CSS değişkenidir (açık/koyu); tasarım kuralları ve belirteç tablosu [DESIGN.md](DESIGN.md)'dedir (tek vurgu rengi, tek yazı ağırlığı, gölgesiz hairline yüzeyler). Sunucu durumu TanStack Query'dedir; sorgu anahtarları şirket kimliği içerir (şirket değişince önbellek karışmaz). Formlar react-hook-form + paylaşılan zod şemaları. Tüm metinler i18next üzerinden; anahtarlar derleme zamanında tip denetimlidir.

## Test stratejisi

- `packages/shared`: saf birim testleri (para, modül kaydı, izinler, şemalar).
- `apps/api`: `app.inject` ile **gerçek PostgreSQL** üzerinde entegrasyon testleri; her çalıştırmada test şeması sıfırlanır. RLS, değiştirilemezlik, dönem kilidi, eş zamanlı numaralama, rol izinleri ve modül yalıtımı doğrudan ham SQL ile de sınanır.
- `e2e/`: Playwright ile kayıt → kurulum → kur → dövizli yevmiye → mizan; cari akışı; stok akışı (kart → giriş → çıkış → kritik seviye → sayım).

## Bilinen sınırlar

- Ana JS paketi ~580 kB (gzip ~187 kB); `manualChunks` ile bölünebilir.
- `company_modules` istisnalarını yönetecek arayüz henüz yok (kod ve testler var).
- Sunucu tsx ile çalışır; üretim derlemesi (bundle) ve dağıtım hattı yol haritasındadır.
