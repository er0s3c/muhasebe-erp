# Ada Muhasebe — 122 öneri için uygulama fazları

10 Ekim 2026. Önceki 1–22 ve devamındaki 23–122 önerileri bu dosyada tek bir uygulama planına bağlanmıştır. Her önerinin bir ana fazı vardır. Faz sırası bağımlılıkları anlatır; ortak temelden sonra sektör fazları birbirini beklemeden ilerler. Plan, önerilerin tamamının bugün eksik olduğu iddiasını taşımaz: önce mevcut kod/kabul kaydıyla karşılaştırılır, sonra yalnız gerekli genişletme uygulanır.

Bir kişi veya küçük ekiple, aynı anda bir ana teslimat üzerinde ilerleme varsayılmıştır. Takvim taahhüdü verilmemiştir; her teslimat kapsamı netleştirilip ilk işlerden elde edilen gerçek hızla tahmin edilir. Dış hesap, fiziksel cihaz veya mali uzman bekleyen iş **paralel dış hat** olarak izlenir ve bir fazın ilk kapsamını kilitlemez.

## İçindekiler

- [Pilot kapsamı](#pilot-kapsamı)
- [Önce izlenecek yol](#önce-izlenecek-yol)
- [İlk beş teslimat](#ilk-beş-teslimat)
- [Faz envanteri](#faz-envanteri)
- [Her teslimatın çalışma düzeni](#her-teslimatın-çalışma-düzeni)
- [Detaylı uygulama kapsamı](#detaylı-uygulama-kapsamı)
- [Paralel dış hat](#paralel-dış-hat)
- [İş kartı şablonu](#iş-kartı-şablonu)
- [Kapsam kontrolü](#kapsam-kontrolü)
- [Değişiklik kaydı](#değişiklik-kaydı)

## Pilot kapsamı

Pilot dört sektörü birlikte kapsar: **ticaret/muhasebe, üretim, inşaat ve deri**. Bu nedenle:

- F0–F4 sektörden bağımsız ortak temel olarak tutulur; sektöre özgü iş bu fazlara sızdırılmaz.
- F0'da her sektör için bir, ayrıca bir ortak görev seçilir (toplam beş görev). Görev kartları, hazırlık verisi ve kayıt formu: [PILOT-OLCUM-PROTOKOLU.md](PILOT-OLCUM-PROTOKOLU.md).

| Sektör | Pilot görevi | İlgili fazlar |
|---|---|---|
| Ortak | Kullanıcının kayıtlı görünümüyle günlük listesini açıp engellenen bir işlemi çözmesi | F2a, F3 |
| Ticaret/muhasebe | Muhasebecinin banka hareketini bulup mutabakatı tamamlaması | F4, F5, F6 |
| Üretim | Üretim sorumlusunun geciken sipariş için uygulanabilir plan hazırlaması | F7 |
| İnşaat | Şantiye sorumlusunun telefondan saha kaydı gönderip sonucunu takip etmesi | F9, F10 |
| Deri | Kesimcinin bir kalıp için uygun kalan parçayı bulup rezerve etmesi | F8 |

- Sektör fazları (F6, F7, F8, F9) F3/F4'ün ilk teslimlerinden sonra birbirine kilitlenmeden sırayla yürütülür. Sıra, F0 ölçümünde en çok zaman kaybettiren göreve göre belirlenir.

## Önce izlenecek yol

- **Ön koşul:** Teslimat 0 — main CI yeşil, açık PR'lar karara bağlanmış.
- **Ortak başlangıç:** F0 → F1'in ilk teslimi → F2a → F3'ün ilk teslimi → F4'ün ilk teslimi.
- **Ticaret:** ortak başlangıç → F5 / F6 (birbirinden bağımsız) → F2b genişletmeleri.
- **Üretim:** ortak başlangıç → F7. (Yalnız 37 numaralı ürün yapılandırma F7 temelini bekler.)
- **Deri:** ortak başlangıç → F8'in 73–76 işleri; 77–79 için F7'nin ilgili operasyon/kalite teslimatı.
- **İnşaat:** ortak başlangıç → F9; saha mobil görevi için F10.
- **Mobil:** seçilen görev akışı F2a'dan sonra başlatılabilir; puantaj/ücret işleri F4'ü bekler.
- **AI ve bağlantılar:** F1 + F3 sonrası F11; kanal eşleme (108–109) F5'in stok temelini, olağan dışı işlem (105) F4'ü bekler.
- **Büyüme kabulü:** seçilen sektör fazıyla birlikte F12.

Bağımlılıkta belirtilen fazın ilgili ortak temeli yeterlidir; o fazdaki bütün genişletmelerin bitmesi beklenmez. Her ilk kapsam da tek sürümde değil küçük teslimatlarla yürütülür.

F1'deki güvenlik, kurtarma, yetki ve değişmez kural testleri bütün fazlar için geçerlidir; her yeni akış bu testlere senaryo ekler. Mali veya ülkeye özgü yeni hesaplar, doğrulanmış yöntem ve referanslar hazır olduğunda yayına alınır.

## İlk beş teslimat

| Teslimat | Yapılacak iş | Somut çıktı | Bitiş ölçütü |
|---|---|---|---|
| 0 | Ön koşul: main CI ve açık PR'lar | Lint, tip, test, geri yükleme tatbikatı ve E2E işleri main'de yeşil; #12–#22 PR'ları birleştirilmiş veya gerekçeyle kapatılmış; [PR-REVIEW-2026-10-09](PR-REVIEW-2026-10-09.md) P2 bulguları (#16 pencere durumu, #17 atlanan rol erişim testleri, #19 sıra/404/lint) çözülmüş | main üzerindeki son CI çalışması tüm işlerde başarılı; atlanan (`test.skip`) güvenlik testi yok |
| 1 | F0: mevcut durum envanteri, beş pilot görevi, ölçüm protokolü | Öneri tablolarında "Mevcut temel" ve "Durum" sütunları doğrulanmış; dar backlog | Beş görevin başlangıç süresi, hata ve yardım kaydı ile kabul senaryosu yazılı |
| 2 | F1: AI işlem sınırı (19), güvenlik/kurtarma kabulü (21), değişmez kural ve tekrar istek test altyapısı (120, 121) | Yetkiyi koruyan kısa DB işlemleri; mali/stok değişmezleri için ortak test yardımcıları | Yavaş sağlayıcıyla bağlantı havuzu tükenmiyor; değişmez testleri CI'da koşuyor |
| 3 | F2a: sunucu kayıtlı görünüm, engel açıklaması, birim ve temel/ayrıntılı form | Seçilen iki ekranda kullanılabilir küçük sürüm | Başka cihazda görünüm açılıyor; yanlış birim ve işlem engeli açıklanıyor |
| 4 | F3: bir satış belge zinciri, kalıcı e-posta outbox'ı ve gönderim geçmişi | Kaynaklara inen zaman çizgisi; üretim kanalı outbox'ından genelleştirilmiş ortak sözleşme | Tekrarlı olay aynı kayıt/etkiyi çoğaltmıyor; sunucu yeniden başlasa da gönderim kaybolmuyor; belge sürümü ve sonuç görülebiliyor |

Sonraki teslimat F4'ün ilk kapsamıdır (kapanış kontrolü, departman boyutu alanı, cari/banka mutabakatı); ardından F0 ölçümüne göre ilk sektör fazı seçilir.

## Faz envanteri

| Faz | Amaç | Öneri sayısı | Bağımlılık |
|---|---|---|---|
| F0 — Kapsam ve pilot hazırlığı | Mevcut kodun üzerine uygulanacak işleri ve ölçülebilir kabul senaryolarını seçmek. | 2 | Teslimat 0 |
| F1 — Güven, test altyapısı ve temel işletim | Güvenlik, gizlilik ve kurtarma kurallarını korurken erken teknik darboğazları ve tutarlılık testlerini kurmak. | 9 | F0 |
| F2a — Ortak kullanıcı deneyimi: temel | Günlük ekranlarda görünüm, giriş doğrulaması ve engel açıklamasını tamamlamak. | 4 | F1'in ilk teslimi |
| F2b — Başlangıç düzenleri ve gelişmiş giriş | Sektör/rol paketleri, hızlı giriş, hesap açıklaması, taslak sürümü ve geçiş araçları. | 10 | F2a; rol kartları için F3/F4'ün ilgili kaynakları |
| F3 — Kayıt bağlantıları, belge ve ortak iş akışları | Modüller arasındaki izleri ve görev/onay/iletişim süreçlerini ortak temele bağlamak. | 8 | F1, F2a |
| F4 — Finans, ülke doğrulaması ve yönetim muhasebesi | Kapanış, mutabakat, ödeme ve yönetim raporlarını güvenilir çalışma süreçlerine çevirmek. | 14 | F1, F3'ün ilk teslimi |
| F5 — Depo ve satın alma | Fiziksel yerleştirme, toplama, sayım, tedarik ve iade süreçlerini birbirine bağlamak. | 10 | F3, F4'ün ilk teslimi |
| F6 — Satış ve ticari kararlar | Fiyat, maliyet, müşteri riski ve satış sorumluluğunu işlem kararına bağlamak. | 11 | F3, F4'ün ilk teslimi; 37 için F7 |
| F7 — Ortak üretim motorunun derinleştirilmesi | Mevcut MES/kapasite/WIP/kalite altyapısını daha doğru plan ve gerçekleşen analizine taşımak. | 11 | F3, F4'ün ilk teslimi |
| F8 — Deri atölyesi | Parça, kalıp, kusur, ton ve operasyon izini özel ürün maliyetiyle birleştirmek. | 11 | F4'ün ilk teslimi; 77–79 için F7'nin operasyon/kalite teslimatı |
| F9 — İnşaat ve gayrimenkul | Mevcut Proje 360 kayıtlarından daha uygulanabilir saha ve ticari kararlar üretmek. | 11 | F3, F4'ün ilk teslimi |
| F10 — Mobil kullanım ve personel | Telefon, atölye ve personel işlemlerini kısa görev akışlarıyla tamamlamak. | 7 | F1, F2a, F3; puantaj/ücret için F4 |
| F11 — AI, OCR ve dış bağlantılar | Açıklanabilir veri yardımı ve kontrollü bağlantıları gerçek kullanımda doğrulamak. | 9 | F1, F3; 105 için F4, 108–109 için F5 |
| F12 — Büyük veri ve sürüm işletimi | Pilot sonrası büyüyen veri, rapor ve güncellemelerde işletim sınırlarını doğrulamak. | 5 | F1, F3, seçilen sektör fazı |

## Her teslimatın çalışma düzeni

1. Mevcut davranışı ve kabul kanıtını kontrol et; tablodaki "Mevcut temel" sütununu doğrula. Kullanılabilir bir özellik için tekrar motor yazma.
2. Tek kullanıcı görevi ve görünür sonucu seç; öneri numarasıyla takip et.
3. Ortak hesap, stok, yetki ve belge kaynaklarını kullan; gereken migration ve eski veri geçişini aynı kapsamda ele al.
4. Değişikliğe uygun hesap/DB/izin/eşzamanlılık kontrollerini ve F1'deki değişmez kural testlerine yeni senaryoları ekle; ilgili ekranı gerçek API ile kontrol et.
5. Kaynak miktar ve mali tutarlılığı, mobil/masaüstü ve gerekiyorsa açık/koyu görünümü doğrula.
6. main CI'ın yeşil kaldığını doğrula; sürüm/kabul kaydını ve bu dosyadaki "Durum" sütununu güncelle; gözlenen sonuç ile henüz denenmemiş dış kabulü ayır.
7. Pilot görevini F0 protokolüyle tekrar ölç; bir sonraki teslimatın önceliğini eldeki sonuca göre belirle.

**Durum değerleri:** Bekliyor · Devam ediyor · Uygulandı · Yerel kabulden geçti · Pilotta doğrulandı · Canlı bağlantıda doğrulandı.

## Detaylı uygulama kapsamı

"Sınıf" ve "Mevcut temel" sütunları F0 envanterinde (11 Ekim 2026) kod, şema ve kabul kayıtlarıyla karşılaştırılarak dolduruldu. **Genişletilecek:** temel kodda var, öneri onu tamamlıyor (83). **Yeni:** karşılık gelen model veya akış yok (38). **Dış erişim bekliyor:** uzman, hesap veya cihaz gerekiyor (1). Kodda eksiksiz bulunan öneri olmadı.

### F0 — Kapsam ve pilot hazırlığı

Mevcut kodun üzerine uygulanacak işleri ve ölçülebilir kabul senaryolarını seçmek.

Bağımlılık: Teslimat 0. Göreli büyüklük: Küçük.

İş sırası:

1. ~~Öneri envanteri~~ — tamamlandı (11 Ekim 2026): her öneri sınıflandırıldı, "Mevcut temel" sütunu dolduruldu.
2. [Pilot kapsamındaki](#pilot-kapsamı) beş görev için ölçüm protokolü — yazıldı: [PILOT-OLCUM-PROTOKOLU.md](PILOT-OLCUM-PROTOKOLU.md). Başlangıç ölçümü pilot kullanıcılarla yapılacak: görev başlangıç/bitiş zamanı, hata, yardım ihtiyacı, tamamlanamayan adım. `/reports/activity` olay sayısını çalışma süresi olarak kullanmaz; bu yüzden ilk ölçüm gözlemle yapılır, gerekiyorsa görev başlangıç/bitişi için hafif bir ölçüm kaydı eklenir.
3. Başlangıç ölçümünü kaydet; modül sınırları ve güncel kabul belgeleri için tek izleme kaydı oluştur.

Tamamlanma ölçütü: Beş görev için başlangıç kaydı, kabul senaryosu ve ilk teslimat kapsamı hazır; tablolardaki "Mevcut temel" sütunu boş satır içermiyor.

| Öneri | İş | Teslimat | Sınıf | Mevcut temel | Durum |
|---|---|---|---|---|---|
| 22 | Kod sınırları, özellik durumları ve dokümantasyon | İlk kapsam | Genişletilecek | Kabul kayıtları `docs/` altında dağınık; `LeatherPages.tsx` ~3.100 satır | Devam ediyor — öneri envanteri bu dosyada tamamlandı |
| 122 | Geliştirmenin gerçek kullanım etkisi | İlk kapsam | Yeni | `/reports/activity` olay kaydı var, süre ölçümü yok | Devam ediyor — protokol yazıldı, başlangıç ölçümü pilot kullanıcı bekliyor |

**F0 envanter özeti (11 Ekim 2026)**

| Faz | Genişletilecek | Yeni (öneri no) |
|---|---|---|
| F0 | 1 | 122 |
| F1 | 7 | 116, 117 |
| F2a | 4 | — |
| F2b | 8 | 23, 27 |
| F3 | 6 | 98, 100 |
| F4 | 8 | 11, 53, 54, 56, 61 |
| F5 | 5 | 43, 44, 47, 49, 50 |
| F6 | 5 | 34, 35, 36, 39, 40, 41 |
| F7 | 8 | 63, 64, 70 |
| F8 | 10 | 77 |
| F9 | 9 | 86, 91 |
| F10 | 3 | 93, 95, 96, 97 |
| F11 | 7 | 105, 106 |
| F12 | 2 | 113, 114, 115 |

Dış erişim bekleyen: 10 (Türkiye/KKTC uzman doğrulaması). Yeni önerilerin çoğu depo (raf, toplama, son kullanma), satış (teklif revizyonu, itiraz, set ürün), üretim kaynakları (hazırlık süresi, takım/aparat, sayısal kalite) ve personel akışlarındadır; bunlar şema değişikliği gerektirir ve ilk teslimlerde migration planıyla birlikte ele alınmalıdır.

### F1 — Güven, test altyapısı ve temel işletim

Güvenlik, gizlilik ve kurtarma kurallarını korurken erken teknik darboğazları ve tutarlılık testlerini kurmak.

Bağımlılık: F0. Göreli büyüklük: Orta–büyük; ilk teslim dar kapsamlı.

İş sırası:

1. Mevcut şirket/şube/işlem yetkileri, kritik klavye akışları ve ayrı hedefe geri yükleme davranışını doğrula; bulunan sorunları düzelt.
2. AI sağlayıcı beklemesini uzun DB işleminden ayır: bağlam/yetki kontrolü kısa işlemde yapılır, her araç okuması kendi kısa kiracı işlemini açar ve güncel yetki/şubeyi yeniden doğrular. Yavaş sağlayıcı altında bağlantı havuzu kullanımını ölç.
3. Değişmez kural test yardımcılarını kur (borç–alacak dengesi, tahsis sınırı, kaynak maliyetin tekrar kullanılmaması) ve tekrar istek/kayıp cevap senaryolarını ekle. Sonraki fazlar bu altyapıya senaryo ekler; sektör uçtan uca genişletmesi F12 ile yapılır.
4. Destek verisi önizleme/maskeleme ve kayıt türüne göre saklama politikasını gizlilik kurallarına bağla.
5. Dosya için bekleyen/uygun/reddedildi durumlarını ve içerik doğrulamasını tamamla; anahtar sürümü ve belge paketi bütünlüğünü ayrı küçük teslimatlar halinde genişlet.

Tamamlanma ölçütü: Şirket/şube sınırı, kritik görev erişilebilirliği, dosya erişimi ve kurtarma senaryosu korunuyor; yavaş AI sağlayıcısı günlük işlemleri bloke etmiyor; değişmez ve tekrar istek testleri CI'da koşuyor.

İlk teslimata alınacak öneriler: 19, 21, 120, 121.

| Öneri | İş | Teslimat | Sınıf | Mevcut temel | Durum |
|---|---|---|---|---|---|
| 19 | AI dış çağrılarını uzun DB işlemlerinden ayırma | İlk kapsam | Genişletilecek | `ai/routes.ts` sağlayıcı çağrısına `c.tx` veriyor; işlem cevap boyunca açık | İlk kapsam tamam: AI oturumu her araç çağrısında kısa salt okunur işlem açar (`tenantReadSessionRoute`); sağlayıcı beklerken yazma kilitlenmez, yetki değişikliği sohbet içinde uygulanır |
| 21 | Güvenlik, kurtarma ve erişilebilirlik kabul koşulları | İlk kapsam | Genişletilecek | RLS, MFA, denetim izi, CI'da geri yükleme tatbikatı | İlk kapsam tamam: kritik akışın yalnız klavyeyle tamamlandığı E2E (`keyboard-flow.spec.ts`); kurtarma tatbikatı CI'da |
| 120 | İş kuralları için değişmez doğrulama koşulları | İlk kapsam | Genişletilecek | Mali regresyon testleri var; özellik tabanlı/değişmez test altyapısı yok | İlk kapsam tamam: `test/invariants.ts` (defter dengesi, stok, cari kapatma, tahsis) ve tohumlu karışık işlem dizileri |
| 121 | Ağ kesintisi ve eşzamanlılık kabulü | İlk kapsam | Genişletilecek | Komut tekrarına karşı `requestKey` + içerik özeti (üretim, deri, POS, çevrimdışı taslak; 36 dosya); ağ kesintisi kabul senaryosu yok | İlk kapsam tamam: fatura, yevmiye ve kasa/banka kayıtlarında `Idempotency-Key` + komut makbuzu (`command_receipts`); aynı anahtarla farklı içerik 409. Makbuz saklama süresi 101 ile |
| 101 | Kayıt türüne göre veri saklama politikası | Genişletme | Genişletilecek | `hr/privacy.ts` kişisel veri envanteri (amaç, hukuki dayanak); yedeklerde 30 gün saklama; kayıt türü bazlı saklama/anonimleştirme yok | Bekliyor |
| 102 | Destek verisini önizleme ve maskeleme | Genişletme | Genişletilecek | `system/feedback.ts` geri bildirim ekranı | Bekliyor |
| 116 | Sürümlü şifreleme anahtarı yenileme | Genişletme | Yeni | Yok; `BACKUP_SIGNING_KEY` tek anahtar | Bekliyor |
| 117 | Dosyayı açmadan içerik/zararlı yazılım kontrolü | Genişletme | Yeni | Yok | Bekliyor |
| 118 | Onaylı belge paketinde bütünlük kontrolü | Genişletme | Genişletilecek | `approvals/document-hash.ts` | Bekliyor |

### F2a — Ortak kullanıcı deneyimi: temel

Günlük ekranlarda görünüm, giriş doğrulaması ve engel açıklamasını tamamlamak.

Bağımlılık: F1'in ilk teslimi. Göreli büyüklük: Orta.

İş sırası:

1. Kişisel kayıtlı görünümü mevcut `user_ui_preferences` / `preferences` rotasına yeni bir anahtar olarak ekle; yerel depodaki görünümleri ilk açılışta sunucuya taşı. Ekip görünümleri için ayrı tablo kur; sonuçlar her kullanıcının güncel yetkisiyle hesaplanır.
2. Pasif işlem düğmelerine sebep ve çözüm bağlantısı ekle; önce iki yoğun ekranda uygula.
3. Formlarda temel/ayrıntılı görünüm ve birim/hassasiyet doğrulaması ekle.

Tamamlanma ölçütü: Aynı kullanıcı başka cihazda görünümünü açabiliyor; paylaşılan görünüm yetkisiz kayıt göstermiyor; yanlış birim ve işlem engeli açıklanıyor.

| Öneri | İş | Teslimat | Sınıf | Mevcut temel | Durum |
|---|---|---|---|---|---|
| 5 | Sunucuda kayıtlı filtreler ve ortak görünümler | İlk kapsam | Genişletilecek | `SavedViews.tsx` localStorage; `preferences/routes.ts` favori, pano düzeni ve tablo yoğunluğunu sunucuda tutuyor | İlk kapsam tamam: `saved_views` tablosu (kişisel/ekip, şube kapsamı, RLS), yerel görünümler bir kez sunucuya taşınır; lisans paneli tarayıcıda saklamaya devam eder |
| 24 | Temel ve ayrıntılı form girişi | İlk kapsam | Genişletilecek | Bazı ekranlarda katlanır `<details>` bölümleri (12 dosya); formlarda temel/ayrıntılı ayrımı ve şirket bazlı zorunlu alan yok | İlk kapsam tamam: `form.detail` tercihi; fatura ve cari formlarında Temel görünüm boş ikincil alanları gizler. Şirket bazlı zorunlu alan ve rol varsayılanı F2b ile |
| 28 | Kullanılamayan işlemin sebebi ve çözüm bağlantısı | İlk kapsam | Genişletilecek | Nedenli pasif işlem yalnız modül erişimi ekranında (`MemberAccessSheet`); ortak bileşen yok | İlk kapsam tamam: engel hataları ilgili kaydı taşır (dönem, iade, kapatan hareket, banka hesabı); ortak `ErrorCallout`/`BlockedHint`; fatura ve kasa/banka ekranlarında yetkisiz işlem nedeniyle pasif |
| 31 | Birim ve sayı girişinde tutarlılık kontrolü | İlk kapsam | Genişletilecek | Deri alanında dm²/ft² → m² sabit dönüşüm; genel birim dönüşümü, hassasiyet tanımı ve olağan dışı miktar uyarısı yok | İlk kapsam tamam: birim hassasiyeti ve `quantityIssues` (fazla ondalık, g→kg/kg→ton, olağan dışı büyüklük); fatura ve stok hareketi satırında uyarı. Sunucuda zorunlu kılma ve şirket bazlı hassasiyet sonraki teslimatta |

### F2b — Başlangıç düzenleri ve gelişmiş giriş

Sektör/rol paketleri, hızlı giriş, hesap açıklaması, taslak sürümü ve geçiş araçları.

Bağımlılık: F2a. Rol panosu kartları F3/F4'ün ilgili kaynaklarına (bağlantılı liste, banka/kapanış verisi) bağlanır. Göreli büyüklük: Büyük; ekran gruplarıyla teslim.

İş sırası:

1. Dört pilot sektörü için başlangıç paketi tanımla (modül, pano, rol önerisi, kurulum adımları); mevcut kurulum kontrol listesi ve modül açma/kapama üzerine kur.
2. Rol bazlı başlangıç panolarını mevcut `dashboard.layout` tercihi ve iş uyarıları üzerinden sun; kartlar ilgili listeye ve işleme götürür.
3. Hızlı giriş şablonu ve tutar hesaplama açıklamasını ekle.
4. Veri aktarımı sonrası mutabakatı (kaynak dosya toplamı ↔ ERP sonucu) ilk pilot şirketinde uygula.
5. Taslak sürümü ve çakışma çözümünü önce teklif üzerinde tamamla; arama, karşılaştırma ve eğitim senaryolarını ortak bileşenle genişlet.

Tamamlanma ölçütü: Yeni şirket sektör paketiyle kurulduğunda yalnız ilgili menü ve pano görünüyor; açılış aktarım toplamları açıklanabilir; iki kullanıcının değişikliği kaybolmuyor.

İlk teslimata alınacak öneriler: 1, 2, 8, 23, 29.

| Öneri | İş | Teslimat | Sınıf | Mevcut temel | Durum |
|---|---|---|---|---|---|
| 1 | Ürünü sektör ve kullanıcı görevine göre paketleme | İlk kapsam | Genişletilecek | Modül açma/kapama; `workspace/setup.ts` kurulum kontrol listesi | İlk kapsam tamam: sektör paketleri (`start-packages.ts`) kurulum adımlarına ve panodaki başlangıç kartına bağlı |
| 2 | Rol bazlı başlangıç panoları | İlk kapsam | Genişletilecek | `dashboard.layout` tercihi; `workspace/alerts.ts` iş uyarıları ve bekleyen onaylar | İlk kapsam tamam: rol bazlı varsayılan pano yerleşimi ve başlangıç kartı; kayıtlı yerleşim varsa o kullanılır |
| 8 | Kurulum, veri aktarımı ve mutabakat | İlk kapsam | Genişletilecek | `imports` modülü: sütun eşleme, önizleme, atomik yazma | İlk kapsam tamam: açılış aktarımlarında dosya ↔ kayıt mutabakat tablosu (cari, defter, stok) |
| 23 | Kullanıcıya özel hızlı giriş şablonları | İlk kapsam | Yeni | Kullanıcı şablonu yok; yakın temel `/settings/recurring` takvimli belge taslakları | İlk kapsam tamam: kullanıcıya özel fatura şablonları (`invoice.templates` tercihi); diğer belgeler genişletmede |
| 29 | Tutar hesaplama açıklamaları | İlk kapsam | Genişletilecek | Ülke bordrosu (`CountryPayrollBreakdown`) ve üretim kontrolünde hesap dökümü; fatura/stok/hakediş için ortak döküm yok | İlk kapsam tamam: fatura satırı için "Tutar nasıl hesaplandı" dökümü (`explainLine`); stok/hakediş genişletmede |
| 25 | Yazım hatası ve alternatif isimle arama | Genişletme | Genişletilecek | `workspace/search`; bulanık eşleşme (pg_trgm vb.) yok | Bekliyor |
| 26 | Taslak sürüm geçmişi | Genişletme | Genişletilecek | Çevrimdışı taslaklar (`workspace/offline-drafts.ts`) | Bekliyor |
| 27 | Eşzamanlı düzenlemede alan bazlı çakışma çözümü | Genişletme | Yeni | Sunucuda iyimser sürüm denetimi yok; çevrimdışı kuyrukta revizyon çakışması açıklamayla bekletiliyor | Bekliyor |
| 30 | Kayıtları yan yana karşılaştırma | Genişletme | Genişletilecek | Çizim revizyonlarını üst üste karşılaştırma, fizibilite senaryoları, bütçe revizyonları; genel kayıt karşılaştırma bileşeni yok | Bekliyor |
| 32 | İş üstünde eğitim senaryoları | Genişletme | Genişletilecek | Demo şirketleri ve roller | Bekliyor |

### F3 — Kayıt bağlantıları, belge ve ortak iş akışları

Modüller arasındaki izleri ve görev/onay/iletişim süreçlerini ortak temele bağlamak.

Bağımlılık: F1, F2a. Göreli büyüklük: Büyük; önce tek belge türü.

İş sırası:

1. Teklif → sipariş → sevkiyat → fatura → tahsilat zaman çizgisini ve ortak kayıt görünümünü mevcut kayıt bağlantıları üzerine tamamla.
2. Üretim kanallarındaki outbox'ı ortak sözleşmeye genelleştir; e-postayı bu sözleşmeye taşı. Şu an `queueMail` iletiyi bellekte gönderiyor ve sunucu yeniden başlarsa kaybediyor. Belge paketi/sürümü, alıcı, deneme ve sonuç geçmişi aynı kayıtta tutulur.
3. Mevcut toplu fatura önizlemesini genel toplu işlem bileşenine dönüştür; süreli onay vekâleti ve gecikme yönlendirmesini küçük teslimatlarla ekle.
4. Otomasyon için önce yalnız görev/bildirim/taslak eylemleri, deneme modu ve çalışma geçmişi uygula.

Tamamlanma ölçütü: Tekrarlı gönderim aynı iş kaydını çoğaltmıyor; dış gönderimin sonucu açık; vekâlet bitince erişim bitiyor; deneme otomasyonu mali kayıt üretmiyor.

İlk teslimata alınacak öneriler: 3, 4, 6, 7, 98, 99, 111.

| Öneri | İş | Teslimat | Sınıf | Mevcut temel | Durum |
|---|---|---|---|---|---|
| 3 | Uçtan uca işlem geçmişi | İlk kapsam | Genişletilecek | `workspace/records.ts` kayıt erişimi ve bağlantı görünürlüğü; satın alma/satış temel bağlantıları | İlk kapsam tamam: `GET /api/sales-chain` teklif → sipariş → irsaliye → fatura/iade → tahsilat yalnız kayıtlı bağlardan; yetkisiz aşama gizli; fatura, satış belgesi ve irsaliyede Belge zinciri |
| 4 | Cari, ürün ve proje ortak kayıt görünümü | İlk kapsam | Genişletilecek | `workspace/records.ts`; kayıt detay sayfaları | İlk kapsam tamam: `GET /api/related` cari, ürün ve proje için modüller arası ilişkili kayıtlar; detay ekranlarında İlişkili kayıtlar sekmesi |
| 6 | Önizlemeli toplu işlemler | İlk kapsam | Genişletilecek | `sales/batch.ts` önizlemeli toplu fatura | İlk kapsam tamam: genel önizlemeli toplu işlem çalıştırıcısı (savepoint; önizleme dener ve geri alır, numara harcanmaz) ve taslak faturaları toplu kaydetme |
| 7 | Belge gönderimi ve gönderim geçmişi | İlk kapsam | Genişletilecek | `mail/` (mailer, şablonlar, bellek içi kuyruk); PDF şablonları ve arşiv | İlk kapsam tamam: satış faturası e-postayla kalıcı outbox'tan; belge sürümü, deneme ve sonuç geçmişi; teslim edilemeyen ileti yeniden denenir. PDF eki ve diğer belge türleri genişletmede |
| 98 | Süre/kapsam sınırlı onay vekâleti | İlk kapsam | Yeni | Yok; `approvals` modülü onay akışı | İlk kapsam tamam: `approval_delegations` süre/tür/tutar sınırlı vekâlet; karar adımda "adına" kaydedilir; süresi dolan ya da geri alınan vekâlet hak vermez |
| 99 | Onay süreleri ve yönlendirme | İlk kapsam | Genişletilecek | `approvals` modülü | İlk kapsam tamam: kuralda adım başına karar süresi ve gecikme yönlendirme rolü; onay kutusunda süre/gecikme gösterimi. Gecikme bildirimi genişletmede |
| 111 | Ortak outbox sözleşmesi | İlk kapsam | Genişletilecek | `manufacturing/channels.ts` outbox (0111/0112 migration'ları) | İlk kapsam tamam: ortak outbox sözleşmesi (`modules/outbox/contract`: durum, kira, bekleme takvimi); webhook ve e-posta bu sözleşmede. Üretim stok kanalı outbox'ı genişletmede taşınacak |
| 100 | Deneme modunda kullanıcı otomasyonları | Genişletme | Yeni | Kural motoru yok; yakın temel tekrarlayan taslaklar ve bildirim taraması | Bekliyor |

### F4 — Finans, ülke doğrulaması ve yönetim muhasebesi

Kapanış, mutabakat, ödeme ve yönetim raporlarını güvenilir çalışma süreçlerine çevirmek.

Bağımlılık: F1, F3'ün ilk teslimi. Göreli büyüklük: Büyük.

İş sırası:

1. Kapanış kontrol listesini ve kaynak raporlarını dönem kilidi/yıl sonu üzerine kur.
2. Defter, fatura, gider ve bordro satırlarına isteğe bağlı departman/maliyet merkezi alanını şimdi ekle; sonraki fazların ürettiği yeni kayıtlar baştan bu boyutu taşır. Raporlar ve dağıtım anahtarları genişletmede gelir.
3. Cari mutabakat ve çoktan bire banka eşleştirmesini mevcut açık kalem/muhasebe servisleriyle tamamla.
4. Banka hesabı değişiklik kontrolü ve toplu ödeme hazırlama ekle; banka sonucu gelmeden başarı kabul etme.
5. Nakit senaryoları, döviz görünümü, demirbaş elden çıkarma, varlık kullanım maliyeti ve grup içi mutabakatı doğrulanmış yöntemlerle ayrı teslim et.

Tamamlanma ölçütü: Fatura–cari–stok–yevmiye tutarlılığı ve geçmiş belge tutarları korunuyor; kapanış farkları kaynağa iniyor; departman alanı geçmiş kayıtlarda "bilinmiyor" olarak kalıyor ve tahmin edilmiyor.

İlk teslimata alınacak öneriler: 9, 11 (yalnız boyut alanı), 53, 55, 59. Öneri 10 [paralel dış hatta](#paralel-dış-hat) yürür.

| Öneri | İş | Teslimat | Sınıf | Mevcut temel | Durum |
|---|---|---|---|---|---|
| 9 | Muhasebe kapanış çalışma süreci | İlk kapsam | Genişletilecek | Dönem kilidi (`settings/periods.ts`), `yearend` modülü | İlk kapsam tamam: dönem kapanış kontrol listesi (otomatik kontroller kaynağına bağlı) ve elle tamamlanan kapanış görevleri |
| 11 | Departman ve maliyet merkezi boyutu | İlk kapsam (alan) + Genişletme (rapor/dağıtım) | Yeni | Yok; departman bütçesi hesap/proje süzgeciyle çalışıyor (ENTERPRISE-EXPANSION) | İlk kapsam (alan) tamam: `cost_centers`; yevmiye ve fatura satırında isteğe bağlı merkez, faturadan gelir/gider satırına taşınır. Bordro/gider taslağı alanı, raporlar ve dağıtım anahtarları genişletmede |
| 53 | Tedarikçi banka bilgisi değişiklik kontrolü | İlk kapsam | Yeni | Yok | İlk kapsam tamam: cari banka hesabı (şifreli IBAN, mod-97), dört göz doğrulama ve teyit yöntemi, aynı IBAN başka caride uyarısı; tam IBAN yalnız doğrulanmış hesapta |
| 55 | Banka eşleştirmesinde çoktan bire ilişki | İlk kapsam | Genişletilecek | `bank-statements/matching.ts` birebir öneri puanlaması | İlk kapsam tamam: bir ekstre satırı toplamı eşit birden çok defter satırıyla eşleşir (veritabanı denetler); iptal/ters kayıt korumaları grubu da görür. Otomatik grup önerisi genişletmede |
| 59 | Cari mutabakat mektubu ve cevap takibi | İlk kapsam | Genişletilecek | Cari açık kalemler (`parties/service.ts`) | İlk kapsam tamam: tarihli bakiye görüntüsüyle mutabakat mektubu, isteğe bağlı e-posta, cevap ve fark takibi; gecikme işareti. Karşı tarafın çevrimiçi cevabı genişletmede |
| 10 | Türkiye/KKTC doğrulanmış ülke kapsamı | Paralel dış hat | Dış erişim bekliyor | Ülke profili, tarihli vergi kuralları; mali pilot bekliyor (COUNTRY-IMPLEMENTATION) | Bekliyor |
| 12 | Karar karşılaştırmalı nakit projeksiyonu | Genişletme | Genişletilecek | Sözleşme vadesi ve ödeme geçmişine dayalı projeksiyon | Bekliyor |
| 54 | Toplu ödeme hazırlama | Genişletme | Yeni | Toplu ödeme/ödeme paketi ve banka dosyası yok; tekil ödeme ve çek/senet toplu tahsil var | Bekliyor |
| 56 | Banka masraflarının hizmet bazında analizi | Genişletme | Yeni | Banka masrafı ayrı izlenmiyor; gider kartları ve banka ekstresi eşleştirmesi temel olabilir | Bekliyor |
| 57 | Düzenli mali yükümlülük takvimi | Genişletme | Genişletilecek | `/settings/recurring` takvimli taslaklar | Bekliyor |
| 58 | Kaynakları açıklanan döviz pozisyonu | Genişletme | Genişletilecek | Döviz pozisyonu raporu var (`consolidation/fx-position.ts`); varsayımsal kur senaryosu yok | Bekliyor |
| 60 | Demirbaş satış ve elden çıkarma | Genişletme | Genişletilecek | Demirbaş kartı ve amortisman var; elden çıkarma yok | Bekliyor |
| 61 | Varlık kullanımının gerçek maliyetle ilişkisi | Genişletme | Yeni | Kullanım bazlı maliyet yok; temel: demirbaş kartı, inşaat ekipman rezervasyonu ve bakım kayıtları | Bekliyor |
| 62 | Şirketler arası mutabakat ve mahsuplaşma | Genişletme | Genişletilecek | `consolidation` modülü | Bekliyor |

### F5 — Depo ve satın alma

Fiziksel yerleştirme, toplama, sayım, tedarik ve iade süreçlerini birbirine bağlamak.

Bağımlılık: F3, F4'ün ilk teslimi. Göreli büyüklük: Büyük; depo pilotu gerekir.

İş sırası:

1. Raf kapasitesi/uyumluluğu ve yönlendirmeli yerleştirmeyi pilot depoda uygula.
2. Toplama işi, parti seçimi ve mevcut sayıma kör sayım/bağımsız yeniden sayımı aynı stok kaynaklarıyla ekle.
3. İade kabulü → kalite kararı → kullanılabilirlik zincirini ve alış ek maliyet mutabakatını genişlet.
4. Tedarikçi ağırlıkları, çerçeve sipariş ve teslim randevusu ekle; talep değişkenliği önerilerini yeterli veriyle aç.

Tamamlanma ölçütü: Yerleştirme/toplama ikinci stok hareketi oluşturmuyor; kalite bekleyen miktar satışa açılmıyor; sayım farkı onaylı düzeltmeyle işleniyor.

İlk teslimata alınacak öneriler: 43, 44, 45, 51, 52.

| Öneri | İş | Teslimat | Sınıf | Mevcut temel | Durum |
|---|---|---|---|---|---|
| 43 | Yönlendirmeli depo yerleştirme | İlk kapsam | Yeni | Raf/lokasyon modeli yok (yalnız depo); üretimde konum/sahiplik kayıtları var | İlk kapsam tamam: raf uyumluluğu (kart kısıtı), kapasite ve aynı kart önceliğiyle yerleştirme önerisi |
| 44 | Sipariş toplama sırası ve güzergâhı | İlk kapsam | Yeni | Toplama işi/listesi yok; satış tahsisi ve kısmi sevk var | İlk kapsam tamam: sevk irsaliyesinden raf sırasına göre toplama listesi ve raf dışı eksik |
| 45 | Döngüsel sayım ve bağımsız yeniden sayım | İlk kapsam | Genişletilecek | `inventory/counts.ts`, `stockCounts` tabloları | İlk kapsam tamam: kör sayım, toleranslı bağımsız yeniden sayım, döngüsel sayım ön doldurması |
| 51 | Alış ek maliyetleri ve fark mutabakatı | İlk kapsam | Genişletilecek | `landed` modülü | İlk kapsam tamam: dosya maliyeti ↔ fatura ↔ aktarım hesabı mutabakatı (ithalat ekranında sekme) |
| 52 | İade kabulünden son karara iş akışı | İlk kapsam | Genişletilecek | İade akışları (returns testleri) | İlk kapsam tamam: kalite kararı beklenen satış iadesi satışa ve üretim kullanılabilirliğine kapalı; satışa aç / hurda kararı |
| 46 | Talep değişkenliğine göre stok önerileri | Genişletme | Genişletilecek | `procurement/replenishment.ts` min–hedef önerisi | Bekliyor |
| 47 | Son kullanma ve raf ömrü riski | Genişletme | Yeni | Son kullanma/raf ömrü alanı yok; lot statüleri (serbest/hasarlı/bloke) var | Bekliyor |
| 48 | Açık ağırlıklarla tedarikçi değerlendirme | Genişletme | Genişletilecek | Malzeme bazında tedarikçi kabul geçmişi (örnek sayısı, ortalama süre/fiyat), inşaat firma performansı; ağırlıklı puan yok | Bekliyor |
| 49 | Çerçeve satın alma anlaşmaları | Genişletme | Yeni | Çerçeve anlaşma yok; `procurement/commitments.ts` proje taahhüdüdür | Bekliyor |
| 50 | Tedarik teslimat randevuları | Genişletme | Yeni | Tedarik teslim randevusu yok; inşaatta garanti/servis randevusu var | Bekliyor |

### F6 — Satış ve ticari kararlar

Fiyat, maliyet, müşteri riski ve satış sorumluluğunu işlem kararına bağlamak.

Bağımlılık: F3, F4'ün ilk teslimi. Öneri 37 için F7 temeli. Göreli büyüklük: Büyük.

İş sırası:

1. Gerçek satış sorumlusu ve teklif revizyon/taviz geçmişini kur; sorumlu değişikliklerini geçmişiyle sakla.
2. Maliyet görüntüsü, katkı sınırı ve mevcut kredi limiti kontrolünü fatura aşamasından teklif/sipariş onayına taşı.
3. İtiraz dosyası ve yenileme fırsatlarını müşteri kaydına bağla.
4. Set/paket ve ürün seçeneklerini stok/malzeme etkisiyle tamamla; prim ve sadakati açık kurallarla daha sonra aç.

Tamamlanma ölçütü: Teklif maliyet kaynağı açıklanıyor; iade/iptal ticari ve prim hesaplarına tutarlı yansıyor; set bileşenleri stokta tekrar tüketilmiyor.

İlk teslimata alınacak öneriler: 13, 33, 34, 35, 38, 39.

| Öneri | İş | Teslimat | Sınıf | Mevcut temel | Durum |
|---|---|---|---|---|---|
| 13 | Satış sorumlusu, hedef ve ticari kârlılık | İlk kapsam | Genişletilecek | Satış raporunda şube ve kaydı oluşturan kullanıcı kırılımı; sorumlu modeli yok | İlk kapsam tamam: cari ve belge sorumlusu, gerekçeli değişiklik geçmişi, aylık hedef, sorumlu bazında kazanma/sipariş/satış/katkı raporu (`/sales/reps`) |
| 33 | Teklif geçerliliği ve güncel maliyet farkı | İlk kapsam | Genişletilecek | Teklifte `validUntil` var; maliyet/kur görüntüsü ve güncel fark yok | İlk kapsam tamam: gönderim/onay anındaki maliyet ve kur görüntüsü; bugünkü maliyet farkı ve geçerlilik süresi teklif ekranında |
| 34 | Müzakere ve ticari taviz geçmişi | İlk kapsam | Yeni | Satış teklifi revizyonu yok; inşaat ihale tekliflerinde revizyon ve karar gerekçesi var | İlk kapsam tamam: her gönderim bir revizyon; satır fiyat/iskonto değişikliği, taviz tutarı ve geri alma gerekçeleri |
| 35 | Asgari katkı kontrolü | İlk kapsam | Yeni | Onay kapısı yok; satış kârlılık analizi (`invoices/analytics.ts`) temel olabilir | İlk kapsam tamam: şirket politikası (asgari katkı, kapalı/uyar/engelle); engel onay yetkilisinin gerekçesiyle geçilir ve saklanır |
| 38 | Müşteri risk limiti kontrolü | İlk kapsam | Genişletilecek | `parties.creditLimit`; satış faturası kaydında uyarı (`invoices/posting.ts`) | İlk kapsam tamam: teklif gönderimi ve sipariş onayında alacak bakiyesi + faturalanmamış onaylı siparişler + belge ile limit kontrolü |
| 39 | Ticari itiraz ve anlaşmazlık dosyası | İlk kapsam | Yeni | İtiraz/anlaşmazlık kaydı yok | İlk kapsam tamam: belgeye bağlanabilen itiraz dosyası; atama, inceleme, çözüm/ret, değişmez olay geçmişi (cari ekranında) |
| 36 | Set, paket ve birleşik ürün yönetimi | Genişletme | Yeni | Set/paket ürün modeli yok | Bekliyor |
| 37 | Müşteri seçenekleriyle ürün yapılandırma | Genişletme (F7 temeli) | Genişletilecek | Deri varyant ve kişiselleştirme, inşaat alıcı seçenekleri; genel yapılandırıcı yok | Bekliyor |
| 40 | Sözleşme ve müşteri yenileme fırsatları | Genişletme | Yeni | Yenileme fırsatı yok; temel: tekrarlayan faturalar ve gayrimenkul sözleşmeleri | Bekliyor |
| 41 | Açıklanabilir satış primi hesabı | Genişletme | Yeni | Yok | Bekliyor |
| 42 | Sadakat ve müşteri avantajı geçmişi | Genişletme | Genişletilecek | `/sales/campaigns` yüzdelik promosyon | Bekliyor |

### F7 — Ortak üretim motorunun derinleştirilmesi

Mevcut MES/kapasite/WIP/kalite altyapısını daha doğru plan ve gerçekleşen analizine taşımak.

Bağımlılık: F3, F4'ün ilk teslimi. Fason ve kalite genişletmeleri F5'in iade–kalite zincirinden yararlanır ama onu beklemez. Göreli büyüklük: Büyük; üretim pilotu gerekir.

İş sırası:

1. Planlanan–gerçekleşen karşılaştırmasını mevcut plan sürümleri üzerine kur.
2. Sıraya bağlı hazırlık süresi, takım/aparat ve operatör becerisini kapasite kısıtına ekle.
3. Yakın dönem plan koruması ve acil sipariş etkisini sürümlü senaryolarla tamamla.
4. Fason kapsam, sayısal kalite ve fiziksel üretim dengesini mevcut batch/rework kaynaklarına bağla.
5. Sayaç esaslı bakım ve malzeme/işçilik/fason/gider sapma analizini gerçek kaynaklarla genişlet.

Tamamlanma ölçütü: Deneme planı gerçek stok/takvimi değiştirmiyor; uygun olmayan kaynakta iş başlamıyor; WIP/mamul/gerçek gider aynı maliyeti tekrar taşımıyor.

İlk teslimata alınacak öneriler: 14, 63, 64, 65, 66, 72.

| Öneri | İş | Teslimat | Sınıf | Mevcut temel | Durum |
|---|---|---|---|---|---|
| 14 | Üretim planı ile gerçekleşen sonuçların karşılaştırılması | İlk kapsam | Genişletilecek | ATP/CTP, sonlu kapasite, plan sürümleri, müdahale listesi (MANUFACTURING-ACCEPTANCE) | İlk kapsam tamam: yayımlı plan işleri çalışma oturumlarıyla eşleşir; başlangıç/bitiş gecikmesi, dakika farkı, zamanında bitme oranı (Planlama > Planlanan–gerçekleşen) |
| 63 | Üretimde sıraya bağlı hazırlık süreleri | İlk kapsam | Yeni | Yok | İlk kapsam tamam: kaynakta aileler arası hazırlık matrisi; ileri planlamada önceki işin ailesine göre hazırlık eklenir (geri planlamada yalnız varsayılan) |
| 64 | Kalıp, takım ve aparat kapasitesi | İlk kapsam | Yeni | Takım/aparat kaynağı yok; kaynaklar makine/istasyon | İlk kapsam tamam: `tool` kaynak türü; eş takım sayısı kadar eşzamanlı kullanım, bakım/arıza kapatır |
| 65 | Operatör becerisi ve iş ataması | İlk kapsam | Genişletilecek | Canlı iş başlangıcında operatör kontrolü var; beceri/sertifika tanımı yok | İlk kapsam tamam: operatör becerisi ve sertifika geçerliliği; kaynağın gerektirdiği beceri yoksa canlı iş başlamaz, uygun operatör listesi |
| 66 | Yakın dönem üretim planını sabitleme | İlk kapsam | Genişletilecek | Plan sürümleri; yayımlanmış plan düzenlenmez; dondurma penceresi yok | İlk kapsam tamam: yayımlı planın sürümü yerine geçer; dondurma penceresindeki taşıma/çıkarma/ekleme gerekçe ister ve saklanır |
| 72 | Üretim maliyet sapmasının bileşenleri | İlk kapsam | Genişletilecek | Maliyet kapanışında standart malzeme sapması; fiyat/miktar/işçilik/fason ayrımı yok | İlk kapsam tamam: maliyet kapanışında malzeme fiyat/miktar sapması ve saatlik maliyetle işçilik verimlilik sapması; fason/genel gider yalnız gerçekleşen |
| 67 | Acil siparişin diğer işlere etkisi | Genişletme | Genişletilecek | What-if senaryosu ve plan sürüm ağacı; acil sipariş etki raporu yok | Bekliyor |
| 68 | Fason kapsam ve sonuç doğrulama | Genişletme | Genişletilecek | Fason miktar/maliyet izi (`subcontracts`) | Bekliyor |
| 69 | Ağırlık/hacim esaslı üretim dengesi | Genişletme | Genişletilecek | Malzeme mutabakatı (teslim/iade/sarf), normal fire ve onaylı anormal kayıp; ağırlık/hacim dengesi yok | Bekliyor |
| 70 | Sayısal kalite ölçümlerinin analizi | Genişletme | Yeni | Kalite kabul/ret ve yeniden işleme var; sayısal ölçüm ve kalibrasyon yok | Bekliyor |
| 71 | Sayaç ve durum bilgisine dayalı bakım | Genişletme | Genişletilecek | Takvimli bakım | Bekliyor |

### F8 — Deri atölyesi

Parça, kalıp, kusur, ton ve operasyon izini özel ürün maliyetiyle birleştirmek.

Bağımlılık: F4'ün ilk teslimi. 77–79 için F7'nin operasyon/kalite teslimatı. Göreli büyüklük: Büyük; fiziksel ölçüm pilotu gerekir.

İş sırası:

1. `LeatherPages.tsx` dosyasını iş akışı sınırlarına göre böl (öneri 22 ile birlikte); yeni ekranlar bölünmüş yapıya eklenir.
2. Kalıp ölçek/revizyon doğrulaması, kusur kullanım koşulları ve ton gruplarını birlikte ele al.
3. Kalan parça görsel aramasını rezervasyon ve alan hesabıyla tamamla.
4. Yapıştırma/dikiş/aksesuar izini ortak operasyon ve kalite motoruna bağla.
5. Prototip, sezon ve özel ölçü kabulünü ayrı sipariş/üretim durumlarıyla genişlet.

Tamamlanma ölçütü: Alan hesabı tutarlı; kalan parça ikinci stok değeri oluşturmuyor; kabul edilen kalıp/ölçü revizyonu üretimde korunuyor.

İlk teslimata alınacak öneriler: 15, 73, 74, 75, 76, 79.

| Öneri | İş | Teslimat | Sınıf | Mevcut temel | Durum |
|---|---|---|---|---|---|
| 15 | Deri malzemesinden ürün maliyetine görünüm | İlk kapsam | Genişletilecek | Parça alanı, kullanılabilir alan, kusur bölgesi, damar yönü, kesim planı (LEATHER-FASHION) | İlk kapsam tamam: emir bazında verilen/dönen/net deri alanı, kalıp alanına göre verim, birim mamule düşen deri ve diğer maliyet |
| 73 | Dijital kalıp ölçü ve revizyon doğrulaması | İlk kapsam | Genişletilecek | Kesim planı kalıp/model revizyonuna bağlı; ölçek ve geometri doğrulaması yok | İlk kapsam tamam: ölçü kutusuyla ölçek denetimi; aynı kodla yeni revizyon öncekinin yerine geçer, emirde kullanılan revizyon korunur |
| 74 | Sipariş/set bazında ton uyumu | İlk kapsam | Genişletilecek | Deri malzemesinde renk/ton kaydı; set/sipariş bazında ton eşleştirme yok | İlk kapsam tamam: kesim planında ve emrin tüm kesimlerinde aynı ton grubu; karışım gerekçe ister |
| 75 | Kusur bölgelerinin kullanım alanına etkisi | İlk kapsam | Genişletilecek | Kusur bölgesi kaydı var | İlk kapsam tamam: delik her parçada, çizik/ton görünür parçada kullanılamaz; kesim planı görünür/gizli alanı ayrı denetler |
| 76 | Kalan deri parçalarını görsel bulma | İlk kapsam | Genişletilecek | Kalan parça ve maliyet izi | İlk kapsam tamam: serbest alan (kalan − kusur sınıfı − rezervasyon), açık kesim planı hariç, çizimli arama |
| 79 | Aksesuar partilerinin ürün izi | İlk kapsam | Genişletilecek | Lot ve batch izi; aksesuar lotundan mamule geriye iz raporu yok | İlk kapsam tamam: partiden üretim emri, mamul partisi ve müşteri sevkine ileri iz (transferler dahil) |
| 77 | Yapıştırma ve kaplama işlem koşulları | Genişletme | Yeni | Yardımcı malzeme işlem koşulu kaydı yok | Bekliyor |
| 78 | Dikiş hatası ve neden analizi | Genişletme | Genişletilecek | Yeniden işleme hata koduyla izleniyor; neden analizi raporu yok | Bekliyor |
| 80 | Numune ve prototip maliyeti | Genişletme | Genişletilecek | Model/reçete/numune ve revizyon onayı var; numune maliyeti ayrı izlenmiyor | Bekliyor |
| 81 | Sezon ve ürün yaşam döngüsü | Genişletme | Genişletilecek | Koleksiyon bilgisi var; yaşam döngüsü aşaması yok | Bekliyor |
| 82 | Özel ölçü siparişinde müşteri kabulü | Genişletme | Genişletilecek | `/leather/custom-orders` özel ölçü, müşteri onayı ve termin; sürümlü ölçü ve değişiklik etkisi yok | Bekliyor |

### F9 — İnşaat ve gayrimenkul

Mevcut Proje 360 kayıtlarından daha uygulanabilir saha ve ticari kararlar üretmek.

Bağımlılık: F3, F4'ün ilk teslimi. Göreli büyüklük: Büyük; IFC/geometri ayrı teknik teslimat.

İş sırası:

1. İş cephesi hazırlığı, ekip/ekipman kısıtı ve saha koşulu etkisini programla birleştir.
2. Ölçüm/kabul farkını hakedişe, değişikliği maliyet/süre/tahsilat dosyasına bağla.
3. İhale kararı, güvenlik takip ve teslim kontrol süreçlerini kaynak belgelerle genişlet.
4. IFC revizyon farkını önce tamamla; çakışma incelemesini sonraki bağımsız teslimat yap.
5. Taksit yeniden yapılandırmasını eski plan/tahsilat/muhasebe izini koruyarak uygula.

Tamamlanma ölçütü: Onaylanmamış değişiklik kesin gelir sayılmıyor; aynı saha miktarı iki kez hakedişe girmiyor; yeniden yapılandırmada tahsilat geçmişi değişmiyor.

İlk teslimata alınacak öneriler: 16, 84, 87, 88, 91, 92.

| Öneri | İş | Teslimat | Sınıf | Mevcut temel | Durum |
|---|---|---|---|---|---|
| 16 | İnşaat değişikliklerinde maliyet/süre/tahsilat etkisi | İlk kapsam | Genişletilecek | Proje 360: risk, çizim revizyonu, saha değişikliği, süre uzatımı, hakediş bağlantıları (CONSTRUCTION-360) | İlk kapsam tamam: değişiklik etki dosyası; onaylı etki kesin, onay bekleyen olası (maliyet, gelir, katkı, gün) |
| 84 | Şantiye iş cephesi hazırlığı | İlk kapsam | Genişletilecek | Proje 360 üç haftalık hazırlık: çizim, malzeme, ekip, onay engeli ve sorumlusu | İlk kapsam tamam: üç haftalık hazırlık; eksik kısıtlar, kritiklik, yedi gün içinde hazır olmayan iş riski |
| 87 | İnşaat ekip ve ekipman dengeleme | İlk kapsam | Genişletilecek | Ekipman rezervasyonu ve çakışma engeli; kaynak dengeleme algoritması yok | İlk kapsam tamam: takvimde ekip kapasitesi, işte ekip ihtiyacı; bollukla sınırlı dengeleme önerisi (programı değiştirmez) |
| 88 | Taşeron ölçüm ve kabul farkları | İlk kapsam | Genişletilecek | Proje 360 üretim → hakediş: kontrol/onay ve tekrar tahsis engeli; yeniden ölçüm farkı yok | İlk kapsam tamam: üretim onayında ölçümle kabul edilen miktar; hakedişe yalnız kabul edilen girer, fark raporu |
| 91 | Teslim öncesi aşamalı kontrol | İlk kapsam | Yeni | Aşamalı teslim kontrolü yok; temel: garanti/servis ve daire pasaportu | İlk kapsam tamam: ön kontrol → eksik giderme → yeniden kontrol → müşteriyle gezi; başlatılmış kontrol tamamlanmadan teslim yok |
| 92 | Gayrimenkul taksit planını yeniden yapılandırma | İlk kapsam | Genişletilecek | `realestate` modülü taksit planları | İlk kapsam tamam: kalan yeni vadelere aynı toplam ve defter tutarıyla devredilir; tahsilat ve eski taksitler korunur |
| 83 | İhalede katılım kararı | Genişletme | Genişletilecek | Proje 360 ihale/teklif: fırsat, keşif, revizyon ve karar gerekçesi; katılım değerlendirme ölçütleri yok | Bekliyor |
| 85 | IFC revizyonları arasında eleman/miktar farkı | Genişletme | Genişletilecek | IFC görünümü (`construction-control`) | Bekliyor |
| 86 | Model çakışmalarını saha aksiyonuna bağlama | Genişletme | Yeni | IFC görünümü var; çakışma analizi yok | Bekliyor |
| 89 | İş güvenliği olayında neden/takip dosyası | Genişletme | Genişletilecek | Çalışma izinleri ve risk radarında güvenlik; olay/temel neden dosyası yok | Bekliyor |
| 90 | Hava ve saha koşullarının program etkisi | Genişletme | Genişletilecek | Saha raporu ve süre uzatımı dosyası; hava/saha koşulu kaydı yok | Bekliyor |

### F10 — Mobil kullanım ve personel

Telefon, atölye ve personel işlemlerini kısa görev akışlarıyla tamamlamak.

Bağımlılık: F1, F2a, F3. Puantaj ve ücretle ilgili işler F4'ü bekler. Göreli büyüklük: Orta–büyük.

İş sırası:

1. İnşaat pilot görevi (telefondan saha kaydı) için bir mobil görev akışı ve görünür eşitleme kuyruğu tamamla; ardından depo ve atölye akışlarını aynı kalıpla ekle.
2. Puantaj düzeltme talebi, izin/vardiya ve personel portalını güncel ay/ücret yetkileriyle uygula.
3. İşe giriş/ayrılış kontrol listesi ve açık hedef görüşmelerini ekle.
4. PDKS ham olay → eşleme → inceleme → puantaj akışını ayrı bağlantı pilotuyla tamamla.

Tamamlanma ölçütü: Ağ kesintisi sonrası taslak korunuyor; tekrar eşitleme çift kayıt oluşturmuyor; çalışan yalnız kendi izinli belgesine erişiyor; kapalı ay kuralı korunuyor.

İlk teslimata alınacak öneriler: 17, 93, 94, 97.

| Öneri | İş | Teslimat | Sınıf | Mevcut temel | Durum |
|---|---|---|---|---|---|
| 17 | Göreve göre mobil ve çevrimdışı deneyim | İlk kapsam | Genişletilecek | PWA, kamera barkodu, şifreli çevrimdışı taslak | İlk kapsam tamam: çevrimdışı taslak ve saha kuyrukları bağlantı gelince kendiliğinden eşitlenir, bağlantı durumu görünür; istemci kimliğiyle tekrar eşitleme çift kayıt yapmaz |
| 93 | Çalışan kişisel belge ve ücret portalı | İlk kapsam | Yeni | Yok; `workspace/portal.ts` müşteri portalı | İlk kapsam tamam: personel–kullanıcı bağı; portalda yalnız kendi bordro pusulası (onaylı/ödenmiş), son iki ay puantajı ve talepler; erişim kaydı tutulur |
| 94 | Puantaj düzeltme talepleri | İlk kapsam | Genişletilecek | `hr/attendance.ts` | İlk kapsam tamam: portaldan ya da İK'dan talep; onayda puantaja yazılır; kapalı ayda açılmaz/onaylanmaz; karar verilmiş talep değişmez |
| 97 | İşe giriş/ayrılış kontrol listeleri | İlk kapsam | Yeni | İşe giriş/ayrılış kontrol listesi yok | İlk kapsam tamam: şirket şablonundan işe giriş/ayrılış listesi; madde kim/ne zaman; tüm maddelerle kapanır ve değişmez |
| 95 | İzin/vardiya talebinde ekip kapasitesi | Genişletme | Yeni | İzin talebi akışı yok; puantajda izin günleri var | Bekliyor |
| 96 | Çalışan hedefi ve değerlendirme geçmişi | Genişletme | Yeni | Yok | Bekliyor |
| 112 | PDKS/cihaz aktarım doğrulaması | Genişletme | Genişletilecek | PDKS dosya aktarımı (`/api/integrations/connections/:id/attendance-file`); ham olay–eşleme–inceleme yok, canlı cihaz bağlantısı dış erişim ister | Bekliyor |

### F11 — AI, OCR ve dış bağlantılar

Açıklanabilir veri yardımı ve kontrollü bağlantıları gerçek kullanımda doğrulamak.

Bağımlılık: F1, F3. Öneri 105 için F4; öneri 108 ve 109 için F5. Göreli büyüklük: Büyük; canlı hesap ve sağlayıcı kabulü gerekir.

İş sırası:

1. AI yanıtlarına kaynak/dönem/kapsam ekle (F1'deki kısa işlem yapısı üzerine); doğal dil filtresini açık seçimlerle uygula.
2. OCR alan kaynakları ve belge tekrar kontrolünü insan doğrulamalı taslak akışına bağla.
3. Onaylı bilgi araması ve olağan dışı işlem önerilerini ayrı değerlendirme setleriyle aç.
4. SKU/lokasyon eşleme, kanal fark çözümü ve hata senaryolarını canlı bağlantı öncesi dene; dış stok gönderimini elle başlatma tercihini koru.

Tamamlanma ölçütü: AI/OCR doğrudan mali kesinleştirme yapmıyor; yetki kaynak ve yanıt aşamasında korunuyor; eski dış olay mali belgeyi değiştirmiyor; canlı sağlayıcı sonucu ayrıca kabul edilmiş.

İlk teslimata alınacak öneriler: 18, 103, 104, 108, 109, 110.

| Öneri | İş | Teslimat | Sınıf | Mevcut temel | Durum |
|---|---|---|---|---|---|
| 18 | Kaynak ve kapsam açıklayan AI yanıtları | İlk kapsam | Genişletilecek | `ai` modülü kontrollü araçlarla veri okuyor (ADA-AI) | İlk kapsam tamam: her araç sonucu ekran, tarih, kapsam ve liste sınırı taşır; yanıt altında kaynak olarak gösterilir, model sınırlı listeyi tam sunmaz |
| 103 | Alan kaynaklı OCR doğrulaması | İlk kapsam | Genişletilecek | Proje 360 OCR yardımcısı (PDF/görüntü, insan doğrulamalı taslak); alan bazında kaynak işareti yok, genel fatura OCR ertelendi | İlk kapsam tamam: OCR alanları bulunduğu satır ve metinle döner; tutar sayıya çevrilir; insan doğrulamalı taslak korunur |
| 104 | İçerik üzerinden belge tekrar kontrolü | İlk kapsam | Genişletilecek | Dosya hash kontrolü | İlk kapsam tamam: aynı belge no, aynı tarih+toplam ya da aynı içerikli başka OCR işi bulunursa fatura taslağı bilerek onay ister |
| 108 | Kanallar arası stok farkı çözümü | İlk kapsam | Genişletilecek | `platform-integrations`, elle stok gönderimi | İlk kapsam tamam: Shopify'da kanal miktarı okunup Ada ile karşılaştırılır; istenirse Ada miktarı kuyruğa alınır, otomatik gönderim yok |
| 109 | SKU/lokasyon eşleme yaşam döngüsü | İlk kapsam | Genişletilecek | Kanal eşlemeleri | İlk kapsam tamam: etkin/duraklatıldı/emekli yaşam döngüsü, gerekçeli geçmiş ve eşleme sağlığı (pasif kart/depo, son gönderim, stok farkı) |
| 110 | Entegrasyon hata ve yetki senaryoları | İlk kapsam | Genişletilecek | Shopify HMAC, olay kimliği/sürümü, backoff, dead-letter ve elle tekrar; sistematik hata senaryosu seti yok | İlk kapsam tamam: hata türü sınıflaması (yetki hatası tekrar beklemeden incelemeye), sahte bağlantıyla senaryo test seti |
| 105 | Açıklanabilir olağan dışı işlem incelemesi | Genişletme | Yeni | Olağan dışı işlem analizi yok | Bekliyor |
| 106 | Doğal dilden rapor filtresi | Genişletme | Yeni | Doğal dilden filtre yok; Ada AI yalnız okuma araçlarıyla yanıtlıyor | Bekliyor |
| 107 | Onaylı işletme içi bilgi araması | Genişletme | Genişletilecek | Proje 360 kaynaklı yerel asistan (kayıt/belge/OCR arama); şirket geneli onaylı bilgi kaynağı yok | Bekliyor |

### F12 — Büyük veri ve sürüm işletimi

Pilot sonrası büyüyen veri, rapor ve güncellemelerde işletim sınırlarını doğrulamak.

Bağımlılık: F1, F3, seçilen sektör fazı. Göreli büyüklük: Orta–büyük; ölçülen veri hacmine bağlı.

İş sırası:

1. Uçtan uca teknik izleri ve DB eğilimlerini ölç; önce kanıtlanan darboğazı düzelt.
2. Büyük raporu kuyruk, tutarlı veri görünümü, ilerleme, iptal ve süreli indirmeyle tamamla.
3. Dosya/işlem kapasitesi ve güncelleme öncesi deneme kurulumunu gerçek paketle doğrula.
4. F1'de kurulan değişmez kural ve tekrar istek testlerini her pilot sektörün uçtan uca görevine genişlet.

Tamamlanma ölçütü: Tanımlı veri hacminde süre/bellek hedefi sağlanıyor; bozuk/uyumsuz güncelleme canlı veriyi bozmuyor; kayıp cevap ve tekrar istek dört sektör akışında da çift mali/stok etkisi oluşturmuyor.

İlk teslimata alınacak öneriler: 20, 113, 114, 119.

| Öneri | İş | Teslimat | Sınıf | Mevcut temel | Durum |
|---|---|---|---|---|---|
| 20 | Arka planda büyük rapor hazırlama | İlk kapsam | Genişletilecek | XLSX akışla yazılıyor; rapor sorguları belleğe alınıyor (ENTERPRISE-EXPANSION) | İlk kapsam tamam: kuyruk, REPEATABLE READ tek görüntü, ilerleme, iptal, 24 saatlik indirme; dışa aktarma menüsünden başlatılır |
| 113 | Uçtan uca teknik izleme | İlk kapsam | Yeni | Yok (OpenTelemetry yok) | İlk kapsam tamam: W3C traceparent, server-timing, yol şablonuyla yavaş istek kaydı (kurulum sahibi görür); tam OpenTelemetry dışa aktarımı yok |
| 114 | Veritabanı performans eğilimleri | İlk kapsam | Yeni | Yok (pg_stat_statements kullanılmıyor); PERFORMANCE kaydı | İlk kapsam tamam: veritabanı büyüklüğü, tablo tarama/ölü satır, pg_stat_statements varsa sorgu özeti, anlık görüntü eğilimi |
| 119 | Güncelleme öncesi uyumluluk/deneme kurulumu | İlk kapsam | Genişletilecek | `system/updates.ts` | İlk kapsam tamam: başka güncelleme, PostgreSQL sürümü, boş disk ve veritabanı yoğunluğu ön denetimi; host üzerinde deneme kurulumu güncelleyicide |
| 115 | Dosya ve işlem kapasitesi bütçesi | Genişletme | Yeni | Kullanım/kota takibi yok | Bekliyor |

## Paralel dış hat

Dış kişi, hesap veya cihaz bekleyen işler bu hatta izlenir. Bağlı oldukları fazın ilk kapsamını kilitlemezler; hazır olduklarında ilgili faza teslimat olarak eklenirler.

| İş | Beklenen dış girdi | Bağlı faz |
|---|---|---|
| 10 — Türkiye/KKTC mali referans senaryoları | Mali uzman incelemesi, referans hesaplar | F4 |
| Canlı Gemini hesabı ile AI kabulü | Sağlayıcı hesabı | F11 |
| Resmî e-belge, e-imza, banka ödeme dosya biçimleri | Servis/banka hesapları | F4, F3 |
| PDKS cihaz bağlantısı (112) | Fiziksel cihaz | F10 |
| Dört sektör pilot şirketi ve kullanıcıları | Pilot müşteriler | F0, tüm sektör fazları |

## İş kartı şablonu

Her uygulama kartı şu bilgileri içerir: faz/öneri numarası, tek kullanıcı görevi, mevcut temel (dosya/modül), mevcut davranış, beklenen davranış, kapsam, kaynak kayıtlar, bağımlılıklar, eski veri etkisi, uygun doğrulama (değişmez testi dahil), pilot kabul sonucu. Faz tamamlanması, yalnız ekranın görünmesiyle değil yukarıdaki kabul ölçütüyle değerlendirilir.

## Kapsam kontrolü

122 öneri, 14 faza (F0, F1, F2a, F2b, F3–F12) birer kez atanmıştır: F0 2, F1 9, F2a 4, F2b 10, F3 8, F4 14, F5 10, F6 11, F7 11, F8 11, F9 11, F10 7, F11 9, F12 5 = 122. Öneri numaraları önceki yanıtlardaki numaralarla aynıdır. Teknik ve mali ortak kabul koşulları, ana fazı farklı olan işlerde de uygulanır.

## Değişiklik kaydı

**12 Ekim 2026 — F11 ve F12 ilk teslimi; tüm fazların ilk kapsamı tamam**

- F11 ilk kapsamı (18, 103, 104, 108, 109, 110) ve F12 ilk kapsamı (20, 113, 114, 119) `claude/f2b-baslangic` dalında. Planın on dört fazının ilk teslimat önerileri kod olarak tamamlandı; kalan işler "Genişletme" satırlarıdır.
- F10 E2E'si bir adlandırma çakışması yakaladı: "Personel portalım" menü öğesi "Personel" bağlantısını arayan akışlarla çakışıyordu; öğe "Çalışan portalım" oldu.
- Kanal yetki hatası (401/403) artık beş kez denenmez, doğrudan elle incelemeye düşer.
- Açık işler: canlı sağlayıcı kabulleri (Shopify/Ticimax, Gemini, OCR çalışma zamanı) pilotta ayrıca doğrulanmalı; OpenTelemetry dışa aktarımı ve dosya/işlem kotası (115) genişletmede.

**12 Ekim 2026 — F10 ilk teslimi**

- F10 ilk kapsamı (17, 93, 94, 97) `claude/f2b-baslangic` dalında.
- Çalışan portalı her üyeye açık bir menü öğesidir; yalnız oturumdaki kullanıcıya bağlı personel kaydını döndürür ve başka personele giden parametre almaz. İK modülü kapalı şirkette kapalıdır.
- F9 ölçüm farkı raporu CI'da gerçek bir hata yakaladı: hakediş aktarım miktarı metin sütunudur; toplamada sayıya çevrilir.
- Açık işler: F10 genişletmeleri (95, 96, 112); portalda kişisel belgeler; düzeltme talebinin çevrimdışı taslak türü olması.

**12 Ekim 2026 — F8 ve F9 ilk teslimi**

- F8 ilk kapsamı (15, 73, 74, 75, 76, 79) ve F9 ilk kapsamı (16, 84, 87, 88, 91, 92) `claude/f2b-baslangic` dalında. Sektör fazlarının (F5–F9) ilk kapsamları tamamlandı.
- Taksit yeniden yapılandırması mevcut kasasız kalem kapatmasını (fesih ile aynı tablo, yapılandırma bağıyla) kullanır; fesih hesabı yapılandırmada devredilen kalanı tahsilat saymaz.
- Aşamalı teslim kontrolü isteğe bağlıdır: birimde kontrol başlatılmışsa son aşama onaylanmadan teslim yapılmaz; başlatılmamış birimlerde teslim değişmez.
- Aralıklı E2E hatası (işveren sözleşmesi) bulundu: kayıt sonrası sorgu yenilenince form kaldırılıyor, React Query kaldırılmış bileşenin geri çağrısını çalıştırmadığından yönlendirme atlanıyordu. Form artık her iki görünümde bağlı kalır.
- Açık işler: F8 genişletmeleri (77, 78, 80–82) ve `LeatherPages.tsx` bölünmesi; F9 genişletmeleri (83, 85, 86, 89, 90); geri planlamada ekip dengeleme; değişiklik etkisinin işveren hakedişine bağlanması.

**12 Ekim 2026 — F7 ilk teslimi**

- F7 ilk kapsamı (14, 63, 64, 65, 66, 72) `claude/f2b-baslangic` dalında.
- Davranış değişikliği: yayımlı planın senaryosu yayımlanınca eski plan "yerine geçildi" durumuna alınır ve kapasiteden düşülür; önceden ikisi birlikte yayımlı kalıyordu.
- Toplama listesi (44) artık yalnız taslak satış irsaliyesi için hazırlanır: kayıt raf yerleşimlerini düştüğü için kayıttan sonraki liste kalanı gösteriyordu (CI yakaladı).
- Açık işler: F7 genişletmeleri (67–71), geri planlamada sıraya bağlı hazırlık, plan oluşturucuda birden çok kalıp seçimi, beceri gereğinin operasyon düzeyine indirilmesi.

**12 Ekim 2026 — F6 ilk teslimi**

- F6 ilk kapsamı (13, 33, 34, 35, 38, 39) `claude/f2b-baslangic` dalında.
- Ticari kontrol fatura aşamasından teklif gönderimi ve sipariş onayına taşındı; varsayılan politika "uyar" olduğu için mevcut akışlar değişmez, engel şirket ayarıyla açılır.
- Maliyet görüntüsü stok defteri ortalamasıdır (yoksa son alış); hizmet ve kartsız satırların maliyeti bilinmez ve açıkça işaretlenir. Kur bulunamazsa kontrol tahmin yapmaz, uyarı bırakır.
- F5 CI'ında WMS testi gerçek bir varsayımı yakaladı: yeni lot kalite karantinasında açılır ve satışa kapalıdır; test lotu serbest açacak şekilde düzeltildi.
- Açık işler: F6 genişletmeleri (36, 37, 40–42), prim hesabının sorumlu raporuna bağlanması, itiraz dosyasının fatura/irsaliye ekranlarından açılması.

**11 Ekim 2026 — F2b ve F5 ilk teslimi**

- F2b ilk kapsamı (1, 2, 8, 23, 29) ve F5 ilk kapsamı (43, 44, 45, 51, 52) `claude/f2b-baslangic` dalında; dal Teslimat 4 dalının üzerine yığılı.
- Envanterdeki "raf modeli yok" notu eskiydi: üretim WMS'inde raf ve lot yerleşimi vardı; yönlendirme ve toplama bu kayıtlar üzerine kuruldu, ikinci stok hareketi oluşturmaz.
- Kalite kararı iade irsaliyesinde isteğe bağlıdır (varsayılan kapalı); açılınca dönen miktar satış irsaliyesiyle çıkarılamaz, karar verilmiş iade iptal edilemez.
- Açık işler: F2b genişletmeleri (25–27, 30, 32), F5 genişletmeleri (46–50), iade kararında tedarikçiye iade ve onarım seçenekleri, kalite bekleyen miktarın stok listesinde ayrı sütun olarak gösterilmesi.

**11 Ekim 2026 — Teslimat 4 (F3) ve F4 ilk teslimi**

- F3 ilk kapsamı (3, 4, 6, 7, 98, 99, 111) ve F4 ilk kapsamı (9, 11, 53, 55, 59) `claude/t4-outbox` dalında; dal F2a dalının üzerine yığılı.
- E-posta artık kalıcı outbox'tan gider (belge gönderimi, bildirim özeti, mutabakat mektubu); parola sıfırlama ve doğrulama iletileri bağlantı jetonu taşıdığı için saklanmaz, doğrudan gönderilir.
- Belge zinciri kartı aynı belge numarasıyla ikinci bir bağlantı ekledi; bir E2E seçicisi tam adla daraltıldı.
- Çoktan bire eşleştirme testi gerçek bir eksik yakaladı: ekstre satırının eşleşme kısıtı birebir bağ istiyordu; kısıt grup eşleşmesine izin verecek şekilde güncellendi (toplam ve en az iki satır kuralı tetikleyicide).
- Açık işler: 100 (deneme modunda otomasyon), F4 genişletmeleri (10 paralel dış hat, 12, 54, 56–58, 60–62), maliyet merkezinin bordro/gider taslaklarına ve raporlara yayılması, üretim stok kanalı outbox'ının ortak sözleşmeye taşınması.

**11 Ekim 2026 — Teslimat 2 ve 3 durumu**

- Teslimat 2 (F1 ilk kapsamı: 19, 21, 120, 121) ve Teslimat 3 (F2a: 5, 24, 28, 31) `claude/f1-ai-islem` ve `claude/f2a-gorunumler` dallarında; dallar Teslimat 0 ve F0 dallarının üzerine yığılı, #24 birleşince PR olarak açılacak.
- Değişmez dizisi gerçek bir test hatası yakaladı: iptal edilen tahsilatın eşleştirmesi tabloda kalır, geçerliliği hareketin durumundan okunur; değişmez sorgusu buna göre düzeltildi (ürün davranışı doğruydu).
- Üretim demosundaki aralıklı "Uygun kaynak kapasitesi bulunamadı" hatasının nedeni bulundu: tohum kayıtları aynı işlemde oluştuğu için liste sırası rastgele UUID'ye kalıyor, plan penceresi bazen demo bakımı açık kalan MAK-01'i seçiyordu. Liste sırası kararlı hale getirildi, test kaynağı açıkça seçiyor. Demo bakım kaydının açık kalması (MAK-01'i 2. günden sonra kapatır) F7 demo verisi gözden geçirmesinde ele alınacak.
- Açık işler: komut makbuzu saklama süresi (101), miktar hassasiyetinin sunucuda zorunlu kılınması ve şirket bazlı tanımı, temel görünümün rol paketleriyle varsayılan yapılması (F2b), F0 başlangıç ölçümleri (pilot kullanıcı gerekir).

**11 Ekim 2026 — Teslimat 0 durumu**

- `claude/teslimat-0-ci` dalında CI'ın üç işi de yeşil: denetim ve testler (lint, tip, birim/entegrasyon, geri yükleme tatbikatı, lisans ve bağımlılık denetimi, derlemeler), Docker imajı ve compose duman testi, uçtan uca testler (88 geçti, 1 isteğe bağlı çevrimdışı üretim kontrolü atlandı).
- Bulunan ürün hataları da düzeltildi: sıkıştırılmış `index.html` 5 dk önbellekte kalıyordu; başarılı kayıttan sonra yanlış "kaydedilmemiş değişiklikler" sorusu (bordro, SGK, yabancı işçi, inşaat, kampanya, ülke bordro kuralı); MFA kapatma ve içe aktarma "Geri" adımı kapatma sayılıyordu; 320/390 px üst çubuk taşması; cihazlar sayfasında sonsuz yükleme; lisans sunucusu imajı derlenmiyordu.
- Bordro, SGK ve personel cari E2E senaryoları KKTC ülke motoruna göre yeniden yazıldı (TEST değerleri, resmî oran değildir).
- Kalan: dalın main'e birleştirilmesi ve açık PR'ların (#12–#22) karara bağlanması. Üretim demosunda bir kez görülen "Uygun kaynak kapasitesi bulunamadı" hatası tekrar etmedi; izlenecek.


**10 Ekim 2026 — kod karşılaştırmalı gözden geçirme**

- Teslimat 0 eklendi: main CI son push'ta lint ve E2E işlerinde başarısız. Lint durduğu için tip denetimi, testler ve geri yükleme tatbikatı çalışmadı. #12–#22 PR'ları açık.
- Pilot kapsamı dört sektöre genişletildi; her sektör için bir görev ve bir ortak görev tanımlandı.
- Sektör fazları arasındaki gereksiz bağımlılıklar kaldırıldı: F6, F7 ve F9 artık F5'i, F7 de F6'yı beklemiyor.
- F2 ikiye bölündü: F2a (5, 24, 28, 31) ve F2b (1, 2, 8, 23, 25–27, 29, 30, 32).
- 120 ve 121, F12'den F1'e taşındı; F3'ün tekrar etki ölçütü bu testlerle kanıtlanacak.
- 101 ve 102, F3'ten F1'e taşındı (gizlilik).
- 11'in boyut alanı F4'ün ilk kapsamına alındı; 10 paralel dış hatta yürüyecek.
- Mevcut altyapı tablolara işlendi: sunucu tercihleri (5), üretim outbox'ı (111), kredi limiti uyarısı (38), toplu fatura önizlemesi (6), kurulum listesi (1, 8), iş uyarıları (2), kayıt bağlantıları (3, 4), sayım tabloları (45).
- Başlıklar Markdown başlığına çevrildi; "Mevcut temel" ve "Durum" sütunları eklendi.
