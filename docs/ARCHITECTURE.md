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
- **Açık kalem ve yaşlandırma** (`modules/parties/aging.ts`, saf fonksiyon): alacak tarafında borç satırları, borç tarafında alacak satırları "kalem"dir; karşı taraf toplamı en eski **vadeden** (yoksa fiş tarihinden) başlayarak uygulanır (FIFO). Uygulanamayan fazla ödeme "avans" olarak ayrı gösterilir. Kovalar: vadesi gelmemiş, 1–30, 31–60, 61–90, 90+ gün. Kasa/banka tahsilat ve ödemeleri seçilen kalemi **açıkça** kapatabilir (`party_allocations`, aşağıda “Kasa ve banka”); açık kalem motoru önce bu eşleştirmeleri düşer, kalan havuza FIFO uygular. Ters çevrilmiş fiş çiftleri (orijinal + ters kayıt) açık kalemde nötrdür: iptal edilen fatura/tahsilat hayalet kalem bırakmaz (ekstre etkilenmez).
- **Türkçe sıralama/arama:** cari listesi `COLLATE "tr-TR-x-icu"` ile sıralanır ve arar (Ç, Ğ, İ, Ö, Ş, Ü doğru yerde; İ→i, I→ı). PostgreSQL'in ICU desteğiyle derlenmiş olması gerekir (resmî Docker imajı, Ubuntu/Debian paketleri ve EDB kurucusunda vardır).

## Stok

- **Stok defteri ayrı bir alt defterdir:** `stock_documents` (başlık) + `stock_movements` (belge başına etki satırları: işaretli miktar ve şirket para biriminde işaretli değer). Eldeki miktar/değer **ayrı bakiye tablosunda tutulmaz**, hareket toplamından türetilir; böylece sapma olmaz. Depo bazında yalnızca miktar izlenir, ürün maliyeti şirket geneli tek ortalamadır (depo değeri = miktar × ürün ortalaması).
- **Maliyet: hareketli ağırlıklı ortalama** (`modules/inventory/costing.ts`, saf fonksiyonlar). Çıkış değeri: tamamı boşaltılıyorsa kalan değerin tamamı (kuruş artığı kalmaz), aksi halde `round2(değer × çıkış / eldeki)`. Bakiye ≤ 0 iken referans maliyet `değer/miktar`, yoksa son alış maliyeti, yoksa 0.
- **Negatif stok** şirket ayarıdır (`companies.allow_negative_stock`; varsayılan kapalı, RETAIL_MARKET'ta açık). Kapalıyken çıkış uygulamada (`STOCK_INSUFFICIENT`) ve `stock_movements_insert_guard` tetikleyicisinde reddedilir. Açıkken eksi bakiye son maliyetle değerlenir; alış eksik bakiyeyi kapatırken maliyet farkı ayrı bir `cost_adjust` satırıyla (miktar 0) yazılır, böylece envanter değeri hep miktar × yeni ortalama kalır. Fark satılan mal maliyetine (621) gider: elle girilen belgede ve faturada kendiliğinden yevmiyeye yansır.
- **Çoklu para birimi:** giriş/devir satırında maliyet EUR/GBP/TL girilir, hareket tarihindeki kurla (`requireRate`) ya da elle kurla şirket para birimine çevrilir; orijinal para birimi, birim maliyet ve kur satırda kalır (tarihsel maliyet). Kartta alış ve satış fiyatı ayrı para birimlerinde tutulur.
- **Değiştirilemez:** hareket satırlarında `erp_app`'in UPDATE/DELETE yetkisi yoktur ve tetikleyici de reddeder; belge başlığında yalnızca `reversed_by_id` (boş → dolu) değişebilir. Düzeltme **ters belge** ile olur ve yalnızca ilgili ürünlerde belgeden sonra hareket yoksa yapılır (`STOCK_DOC_HAS_LATER_MOVEMENTS`); böylece durum tam eski haline döner. Belgeden sonra girilip yine belgeden sonra **tümüyle ters çevrilmiş** belge çiftleri (örn. iptal edilen fatura) ürünün durumunu değiştirmediği için hareket sayılmaz; sondan başa doğru iptal bu sayede mümkündür. Belge tarihi açık mali dönemde olmalıdır (uygulama ve tetikleyici).
- **Eşzamanlılık:** belge işlenirken ilgili ürün satırları `SELECT … FOR UPDATE` ile (id sırasıyla) kilitlenir, ardından numara alınır; tetikleyici de ürün satırını kilitler (ikinci savunma). Paralel iki çıkış testi bunu sınar.
- **Sayım:** taslak → işlendi. Fark, işleme anındaki depo bakiyesine göre hesaplanır; fazla ortalama maliyetle giriş, eksik çıkış olur; tek `count` belgesi üretilir. İşlenen sayım değişmez.
- **Muhasebe bağı (M6):** elle girilen stok belgeleri ve sayım, hesap eşlemesine göre **otomatik yevmiye** üretir (bkz. "Fatura ve otomatik yevmiye"); faturadan doğan belge kendi yevmiyesini faturadan alır. **Stok durumu** raporu, stok defteri değerini 150–157 hesaplarının defter bakiyesiyle karşılaştırır; iki kaynak da otomatik yazıldığı için fark baştan 0'dır. Tek beklenen istisna faturalanmamış irsaliyedir (bkz. "İrsaliye"): rapor bunu ayrı satır olarak gösterir. M6 öncesi belgeler ve elle yevmiye farkı yaratır.
- Geriye dönük tarihli hareket geçmişi yeniden değerlemez (hareket, girildiği andaki ortalamayla maliyetlenir); raporlar hareket tarihine göre tarih anı değeri verir.

## Fatura ve otomatik yevmiye (M6)

- **Fatura türleri:** satış (`SF`), alış (`AF`), gider (`GF`, stoksuz), satış iadesi (`SIF`), alış iadesi (`AIF`). Numara kaydetme anında, türe ve yıla göre **boşluksuz** verilir (`INV:<tür>` sayacı); taslakta numara yoktur. Alış/gider/alış iadesinde tedarikçi fatura no zorunludur ve (cari, no) **kaydedilmiş** (iptal edilmemiş) faturalarda tekildir; iptal edilen kayıt numarayı tutmaz, çünkü düzeltme iptal + yeniden girişle yapılır.
- **Durum:** `draft → posted → cancelled`. Kaydedilmiş fatura değiştirilemez ve silinemez (`invoices_guard`, ERRCODE `ERP03` → `INVOICE_RULE_VIOLATION`); tek geçiş iptaldir. İptal = ters kayıt: stok belgesi ters çevrilir, yevmiye ters çevrilir, numara serinin parçası olarak kalır. Faturadan sonra aynı ürünlerde (ters çevrilmemiş) stok hareketi ya da faturaya kesilmiş iade varsa iptal engellenir; iade faturası kesilir.
- **Kaydetme tek işlemdir** (`invoices/posting.ts`): faturayı kilitle → KDV ve tutarları yeniden hesapla → stoku **saf planlayıcıyla** planla → fatura numarası → stok belgesi → yevmiye → satır maliyetleri → fatura durumu. Kilit sırası ürünler → numaralar. Paralel iki satış aynı stoğu aşamaz; aynı taslak iki kez kaydedilemez (testli).
- **Yevmiye kalıbı:** cari satırın defter tutarı, gövde satırlarının (satır başına yuvarlanmış `net_base`/`vat_base`) toplamıdır; böylece kur yuvarlaması fişi bozmaz. Satış: B cari (120) / A gelir (600) / A KDV (391); stoklu kalemlerde B 621 / A stok. Alış: B stok (150/153) + B gider + B KDV (191) / A cari (320); eksi bakiye kapanışındaki `cost_adjust` toplamı B 621 / A stok. Gider: B gider + B KDV / A cari. Satış iadesi cari/gelir/KDV'yi tersler, mal orijinal satırın **maliyetiyle** girer (kalan miktar tamamlanınca kalan maliyet: kuruş artığı kalmaz). Alış iadesi stoktan ortalama maliyetle çıkar; iade tutarıyla farkı 621'e gider.
- **KDV:** satırda `vat_code` → şirketin `tax_rates` kaydı (fatura tarihinde geçerli) → `vat_rate` anlık görüntü. Hesap `packages/shared/src/invoice-calc.ts` içindedir (API ve web aynı fonksiyon): KDV hariç modda satır başına yuvarlanır; KDV dahil modda net = brüt ÷ (1 + oran), fark KDV'ye yazılır. Oranlar **doğrulanmamıştır**; KDV özeti doğrulanmamış kodları ayrıca bildirir.
- **Hesap eşlemesi** (`account_mappings`, 15 anahtar): cari (120/320), gelir (600/610), maliyet (621), stok (150/153; inşaatta 150), KDV (391/191), varsayılan gider (632), stok fazlası (649), fire/noksanlık (659), sarf (710), devir karşı hesabı (500), kambiyo kârı/zararı (646/656; M7). Şirket kurulurken ve migration ile varsayılanlar yüklenir; Ayarlar'dan değişir. Cari eşlemeleri yalnızca kontrol hesabı olabilir, diğerleri kontrol/dövizli olamaz. Eksik eşleme `ACCOUNT_MAPPING_MISSING` ile açık hata verir. **Varsayılanlar mali müşavirce doğrulanmamıştır.**
- **Elle girilen stok belgeleri** aynı eşlemeyle otomatik yevmiye üretir: devir → B stok / A devir karşı hesabı; giriş → B stok / A stok fazlası; sarf → B sarf / A stok; fire → B zarar / A stok; sayım fazlası/eksiği ayrı hesaplara; transferde fiş yoktur. Ters belge, orijinal yevmiyenin ters kaydını yazar. M6 öncesi belgelerin yevmiyesi geriye dönük üretilmez.
- **Kaynak bağı:** `journal_entries.source_type/source_id` (`invoice`, `stock_document`); kaynak başına tek asıl yevmiye kısmi tekil indeksle zorlanır. Kaynaklı yevmiye API'den tek başına ters çevrilemez (`ENTRY_HAS_SOURCE`), faturadan doğan stok belgesi de (`STOCK_DOC_HAS_SOURCE`); ters kayıt kaynak belgeden yapılır. Fatura kaydedilirken tetikleyici satır toplamlarını, yevmiye kaynağını ve cari tutarın brüt tutara eşitliğini de denetler.
- **Kapsam dışı:** tevkifat/stopaj/damga, e-Fatura ve yasal fatura biçimi (Faz C), kategoriye göre ayrı stok hesabı. İrsaliye ve tahsilat/ödeme/kur farkı için aşağıya bakın.

## İrsaliye (M6b)

- **Türler ve numara:** satış/sevk irsaliyesi (`SIR`, stoktan çıkış) ve alış/mal kabul irsaliyesi (`AIR`, stoğa giriş); iade irsaliyesi yoktur (iade faturası stok hareketini kendi yapar). Numara kaydetme anında, türe ve yıla göre boşluksuz verilir (`DLV:<tür>`). Alış irsaliyesinde tedarikçi irsaliye no zorunludur, (cari, no) kaydedilmişlerde tekildir. Durum: `draft → posted → cancelled`; kaydedilmiş irsaliye değiştirilemez (`delivery_notes_guard`, ERRCODE `ERP04` → `DELIVERY_RULE_VIOLATION`).
- **İrsaliye yevmiye yazmaz.** Kayıt yalnızca stok defterini hareket ettirir (stok belgesi kaynağı `delivery_note`; satışta ortalama maliyetle çıkış, alışta giriş). Muhasebe fatura kesilince oluşur. Bu yüzden faturalanmamış irsaliye stok defteri ile 150–157 hesapları arasında **beklenen bir fark** doğurur (satış: −kalan maliyet, alış: +kalan değer). Stok durumu mutabakatı bunu ayırır: `fark − bekleyen irsaliyeler = açıklanamayan fark`; yalnızca açıklanamayan fark bir sorundur. Tarih anı doğrudur (iptaller iptal tarihine kadar geçerli sayılır).
- **Faturaya bağlama:** satış/alış fatura satırında `deliveryLineId`. Aynı cari, aynı yön, aynı kart, kaydedilmiş irsaliye şarttır. **Bağlı satır stok hareketi yapmaz** (çift çıkış/giriş yok). Bir fatura birden çok irsaliyeden satır alabilir, bir irsaliye satırı birden çok faturaya bölünebilir (kısmi faturalama). Kalan miktar, irsaliye satırları `FOR UPDATE` ile kilitlenerek kayıtta yeniden doğrulanır; son pay kalan değerin tamamını alır (kuruş artığı kalmaz). Faturalanan değer ve miktar depolanmaz, kaydedilmiş faturalardan türetilir (`invoice_lines.delivery_line_id`, `delivery_value`, `delivery_adjust`); fatura iptali irsaliyeyi yeniden faturalanabilir yapar.
- **Satış:** yevmiye 621/stok tutarı, irsaliye satırının maliyet payıdır (`cost_value` da buradan gelir, bu yüzden satış iadesi doğru maliyetle girer).
- **Alış ve fiyat farkı:** irsaliyede birim maliyet isteğe bağlıdır (yoksa değer 0). Fatura bağlanınca `P = fatura net (defter para birimi) − irsaliye değeri payı`. Elde kalan miktar payı (`min(q, max(eldeki, 0)) / q`) kadarı `cost_adjust` satırıyla stok maliyetine eklenir (yevmiyede zaten stok hesabındadır), kalanı satılan mal maliyetine (621) gider. İrsaliyenin kendi eksi bakiye kapanış düzeltmesi (`adjust_value`) de faturada 621'e aktarılır. Yalnızca düzeltme satırı taşıyan stok belgesi (`direction: adjust`) ters çevirme kuralına aynen tabidir.
- **İptal:** irsaliye ters stok belgesiyle iptal edilir; kaydedilmiş bir faturaya bağlıysa `DELIVERY_INVOICED`, sonradan aynı ürünlerde hareket varsa `DELIVERY_CANCEL_BLOCKED`. Faturalama ve iptal aynı satır kilitlerinden geçer (paralel yarış testli).
- **Veritabanı:** `invoices_guard` bağlı satırlarda irsaliyenin kaydedilmiş, aynı cari/tür/kart olduğunu ve toplam faturalanan miktarın irsaliye miktarını aşmadığını kilit altında denetler; `delivery_notes_guard` kayıtta satır miktar/değerinin stok defteriyle eşitliğini ve stok belgesinin kaynağını doğrular.
- **Yetki:** `deliveries.read/manage/post`; satış rolü taslak hazırlar, şantiye sorumlusu mal kabul ve sevki işler ama faturaya erişmez. Menü grubu "Fatura ve irsaliye".
- **Kapsam dışı:** iade irsaliyesi, e-İrsaliye ve yasal biçim (doğrulanmadı), sipariş/teklif, seri no.

## Kasa ve banka (M7)

- **Hesaplar** (`treasury_accounts`): tür `cash|bank`, ad, para birimi, banka bilgisi; her biri **bir muhasebe yaprak hesabına** (100.x kasa / 102.x banka) bağlıdır ve o hesap tekildir. Oluştururken ya yeni alt hesap açılır (`nextSubCode`: 102.001, 102.002…, dövizli hesapta para birimi hesaba yazılır) ya da mevcut hesaba bağlanır (o gruba doğrudan hareket işlenmiş şirkette alt hesap açılamaz: `PARENT_ACCOUNT_HAS_MOVEMENTS`). Yeni şirkete hesap tohumlanmaz. Tür, para birimi ve bağlı hesap sonradan değişmez (`treasury_accounts_guard`). **Bakiye bağlı muhasebe hesabından okunur** (hesap para biriminde tutar + defter tutarı [tarihsel maliyet] + güncel kurla karşılık); kasa/banka ile genel muhasebe bu yüzden ayrışamaz.
- **Hareket türleri** (`treasury_transactions`; taslak yok, doğrudan kaydedilir, durum `posted|cancelled`): tahsilat `TAH`, ödeme `ODE`, virman `VRM` (aynı para birimi), döviz alım-satım `DVZ` (farklı para birimi), diğer tahsilat/ödeme `DTH`/`DOD` (banka masrafı, faiz; karşı hesap seçilir: kayıt atılabilir, aktif, cari/dövizli/kasa-banka olmayan hesap). Numara `TRS:<tür>` sayacından boşluksuz verilir. **İptal = yevmiye ters kaydı**; numara serinin parçası kalır, kaydedilmiş hareket yalnızca iptal alanlarıyla değişir, silinemez (`treasury_transactions_guard`, ERRCODE `ERP05` → `TREASURY_RULE_VIOLATION`).
- **Tahsilat/ödeme ve kalem eşleştirme:** kullanıcı carinin açık kalemlerinden seçer; her kalem için `{lineId, amount (kalem para birimi), settleAmount (kasa/banka para birimi)}` girilir. Seçilmeyen kalan **avans**tır: cari satırı kasa para biriminde, işlem kuruyla yazılır ve FIFO havuzuna girer. Bir harekette birden çok kalem ve para birimi olabilir. Eşleştirmeler `party_allocations`'ta tutulur (yalnızca eklenir; hareket iptal edilince **hesaba katılmaz**, satırlar silinmez). Açık kalem hesabında eşleştirilmiş kapatan satırlar FIFO havuzundan çıkar.
- **Yevmiye kalıbı ve gerçekleşen kur farkı** (`treasury/journal.ts`, saf): tahsilat `B kasa/banka (CT, T, defter = karşı satırların toplamı) / A 120 (kalem başına: kalem para birimi, kalemin taşıdığı defter payı) / A 120 avans (kalan × işlem kuru) / A kambiyo kârı (646) ya da B kambiyo zararı (656)`; ödeme aynısının tersi. Kalemin taşıdığı defter payı: tamamı kapanıyorsa kalan defter tutarının tamamı (kuruş artığı yok), kısmiyse `round2(kalanDefter × amount / kalan)` (`proportionalBase`, `packages/shared/src/treasury-calc.ts`; web önizlemesi aynı fonksiyonları kullanır). Kur farkı = `settleBase − taşınan` (tahsilatta + kâr; ödemede işaret ters, `settlementFxDiff`). Kasa/banka satırının defter tutarı karşı satırların toplamıdır, bu yüzden fiş kur yuvarlamasından bağımsız her zaman dengelidir. Örnek: 100 GBP fatura @40 (4.000 TL), tahsilat günü @45 → `B 102.00x GBP 100 (defter 4.500) / A 120 GBP 100 (4.000) / A 646 500`.
- **Kur:** kasa/banka para birimi için işlem kuru elle verilen ya da hareket tarihindeki kayıtlı kurdur; yevmiye motoru sessizce farklı kura düşmesin diye her zaman açık `fxRate` ile yazılır (kayıtlı kur `buy` alanıdır). Yoksa `FX_RATE_MISSING`.
- **Döviz alım-satım ve virman:** kaynak hesaptan çıkan tutarın defter değeri hesabın **ortalama maliyetidir** (`Σdefter/Σtutar`; tüm bakiye çıkıyorsa kalan defter tutarının tamamı). Hedef TL ise `fark = alınan TL − maliyet` (646/656); TL ile döviz alımında maliyet ödenen TL'dir (fark yok); yabancıdan yabancıya değer hedef para birimi kuruyla (elle/kayıtlı) bulunur. Virman maliyeti olduğu gibi taşır (fark yok).
- **Kasa eksiye düşmez, banka düşebilir** (KMH): kasa çıkışlarında (ödeme, virman, döviz, diğer ödeme) işlem tarihine kadarki kayıtlı bakiye denetlenir (`CASH_INSUFFICIENT`); iptalin ters kaydı kasadan çıkış yaratıyorsa (tahsilat, diğer tahsilat, virman ve döviz iptali) iptal tarihindeki bakiye de denetlenir. Geriye dönük tarihli çıkışta o tarihten **sonraki** hareketler yeniden denetlenmez (bilinen sınır).
- **Eşzamanlılık ve kilit sırası:** kasa/banka hesapları (id sırasıyla `FOR UPDATE`) → cari satırı → kapatılan kalem satırları (id sırasıyla) → hareket numarası → yevmiye numarası. `party_allocations_guard` kalem satırını yine kilitleyip toplam eşleşmenin kalemi aşmadığını doğrular (ikinci savunma; uygulama kilitleri kapatılınca çift kapama yine veritabanında reddedilir). Testler: aynı kalemi farklı iki hesaptan kapatan paralel tahsilat, aynı kasadan paralel iki ödeme.
- **İzin/modül:** modül `core.treasury` (tüm sektörler); `treasury.read/manage/post` (manage = hesap kartı, post = hareket ve iptal); muhasebeci hepsi, izleyici okur, satış ve şantiye sorumlusunun erişimi yoktur. Menü grubu “Kasa ve banka”.
- **Kapsam dışı / bilinen sınırlar:** çek/senet portföyü; banka ekstresi içe aktarma ve eşleştirme (M8); **dönem sonu kur değerlemesi ve sonradan avans mahsubu (M7b)**: yalnızca-defter-tutarı düzeltme satırı gerektirir ve yasal kural doğrulanmamıştır. Bu yüzden (1) yabancı hesabın defter bakiyesi ortalama maliyetten sapabilir: tahsilat/ödemede kasa/banka satırı işlem kuruyla yazılır, döviz satışında ise ortalama maliyetle çıkar; (2) aynı para birimli avans sonradan farklı kurlu faturaya FIFO ile kapanınca oluşan defter farkı cari hesapta kalır. Değerleme (M7b) ikisini de temizler.

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
- `e2e/`: Playwright ile kayıt → kurulum → kur → dövizli yevmiye → mizan; cari akışı; stok akışı (kart → giriş → çıkış → kritik seviye → sayım); fatura akışı (alış → satış → iade → iptal); irsaliye akışı (mal kabul → fiyat farklı fatura → sevk → kısmi fatura); kasa/banka akışı (dövizli fatura → farklı kurlu tahsilat + kur kârı → ekstre → iptal → kalem geri gelir).

## Bilinen sınırlar

- Ana JS paketi ~580 kB (gzip ~187 kB); `manualChunks` ile bölünebilir.
- `company_modules` istisnalarını yönetecek arayüz henüz yok (kod ve testler var).
- Sunucu tsx ile çalışır; üretim derlemesi (bundle) ve dağıtım hattı yol haritasındadır.
