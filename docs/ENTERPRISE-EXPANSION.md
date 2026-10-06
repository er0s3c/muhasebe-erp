# İşletim ve kurumsal genişleme — 6 Ekim 2026

Bu çalışma önce mevcut 30 özelliklik inşaat paketini korur, sonra kullanıcının yeni taleplerini ekler. Gerçek pilot erişimi ve harici SMS/WhatsApp/OCR/AI servis anahtarları yoktur; yerel davranış ve otomasyon doğrulanır. Aşağıdaki durumlar ürün iddiası değil, uygulanacak işlerin takibidir.

| Paket | Kapsam | Kabul ölçütü | Durum |
|---|---|---|---|
| 1 | Bugünkü işlerim, bildirim merkezi, kapsam/öncelik/vade filtreleri | 390 px, koyu/açık tema, klavye, görev ve uyarı eylemleri | Uygulandı; tarayıcı testleri geçti |
| 2 | Çalışma sayaçları, kullanıcı/gün/modül denetim raporu, puantaj detayı | Süreler açık sayaçtan; olay sayısı çalışma saati değildir. Yetkisiz modüller ve sırlar görünmez | Uygulandı; gün sınırı ve erişim testleri geçti |
| 3 | Yükleme sınırları, ek belgeler, şirket MFA zorunluluğu | Sınır sunucuda uygulanır; eski arşivler okunur; yabancı işçi belgesi ayrı yetkiye tabidir | Uygulandı; API testleri geçti |
| 4 | Günlük KKTCMB XML kur indirme | Yayın tarihi saklanır, elle girilen kur korunur, bağlantı hatası ve tekrar deneme geçmişi gösterilir | Uygulandı; XML örnekleri doğrulandı, canlı bağlantı doğrulanamadı |
| 5 | Yedekleme, geri yükleme, otomatik politika, saklama, dosya bütünlüğü | Veritabanı ve özel dosyalar birlikte; ayrı hedefe test geri yükleme; çok kiracılı kurulumda sahip yetkisi kuruluma özgüdür | Uygulandı; gerçek pg_dump/pg_restore testi geçti; kurulum ayarı gerekir |
| 6 | Lot/parti ve emanet stok | Miktar ve sahip stok defterine bağlanır, fazla çıkış ve mükerrer hareket önlenir | Planlandı |
| 7 | Kampanya/promosyon ve dövizli çek/senet | Tarihli teklif fiyatı sabit; para birimi ve kur farkı mevcut muhasebe motorundan geçer | Uygulandı; KDV dahil indirim, tekrar engeli ve kur farkı testleri geçti |
| 8 | Tekrarlayan ajanda/fatura ve hatırlatma | Takvim ve son tarih; aynı dönem bir kez; taslak fatura; belge vade uyarısı zaten mevcut | Uygulandı; takvim, taslak ve tarayıcı testleri geçti |
| 9 | Masraf iadesi/avans mahsubu | Yetkili gider fişi, mevcut personel avansı, kalan tutarın ödemesi, iptalde geri alma | Uygulandı; eşzamanlı işlem, iptal ve mobil arayüz testleri geçti |
| 10 | Şirket/departman bütçesi, kıymet/amortisman | Sürümlü bütçe ve sapma; parametreli amortisman ve doğrulanan yevmiye taslağı | Uygulandı; bütçe onayı/revizyonu, kaynak, dışa aktarma ve amortisman testleri geçti |
| 11 | Araç/makine yakıt/bakım/proje dağılımı | Mevcut ekipman rezervasyon, sayaç, bakım ve gider kaydına bağlanır | Mevcut altyapı; genişletilecek |
| 12 | Saha PWA: puantaj, fotoğraf, satın alma talebi | Kalıcı kuyruk, şirket/çıkış temizliği, çakışma, tek kez eşitleme | Fotoğraf/rapor mevcut; genişletilecek |
| 13 | E-posta/SMS/WhatsApp, zamanlanmış rapor | Yetkili alıcı ve izinli kaynaklar; teslim/retry geçmişi; kanal yapılandırılmadan göndermez | E-posta mevcut; genişletilecek |
| 14 | Müşteri/taşeron portalı | Kendi sözleşme/hakediş/ekstresine erişim; karar geçmişi | Müşteri servis portalı mevcut; genişletilecek |
| 15 | Pano, kaydedilmiş rapor, dış API ve webhook | Şirket kapsamı, dar izinli anahtar, iptal, paylaşılan oran sınırı, idempotency | Kişisel/paylaşılan rapor panosu uygulandı; dış API anahtarı/webhook planlandı |
| 16 | OCR/hesap önerisi/doğal dil rapor | Kaynaklı öneri, insan doğrulaması, otomatik mali kayıt yok | Proje OCR/asistan mevcut; genişletilecek |
| 17 | Konsolide biçim, azınlık ve eliminasyon | Kullanıcı tanımlı tablo eşlemesi, sahiplik oranı, kanıtlı eliminasyon taslağı; resmi biçim diye etiketlenmez | Planlandı |
| 18 | İngilizce, paket bölme, ortak limiter, akışlı XLSX | Sözlük anahtar denetimi, üretim boyutu, çok süreçli limit, yüksek satırlı export | Paket bölme/PostgreSQL limiter/XLSX akışı uygulandı; İngilizce planlandı |

## Teknik kurallar

Yeni tablolar şirket RLS, etkili modül izinleri ve denetim iziyle korunur. Onaylı muhasebe hareketleri yeni ekranlardan doğrudan değiştirilmez. Kullanıcı üretkenliği için gizli tarayıcı gözetimi yapılmaz; açık çalışma sayaçları ve girilmiş puantaj raporlanır. Tam kurulum geri yüklemesi canlı şirket verisine kendiliğinden uygulanmaz; yüklenen yedek önce incelenir ve ayrı hedefte doğrulanır.

## Doğrulama kaydı

Önceki inşaat paketi için docs/CONSTRUCTION-360.md geçerlidir. Genel API regresyonu: 897 geçti, 31 atlandı (toplam 928); bu koşu yeni bütçe testleri eklenmeden başlatılmıştı. Bütçe/denetim/güvenlik/migration grubunda 42 test geçti. Güncel bütçe şemasıyla gerçek pg_dump/pg_restore ve özel dosya geri yükleme dahil mali entegrasyon grubunda 35 test geçti. Ortak hesaplama/şema testleri: 635 geçti; web birim testleri: 11 geçti. Bütçe, amortisman, masraf, kampanya, tekrar, pano ve inşaat akışları dahil 13 gerçek API tarayıcı senaryosu geçti. Tip kontrolü, lint ve üretim derlemesi doğrulandı. Gerçek kullanıcı pilotu ve canlı KKTCMB bağlantısı kabul edilmiş sayılmaz.

Son tarayıcı regresyonunda 12 senaryo geçti; çevrimdışı senaryonun ikinci şirket oluşturma isteği yerel Vite vekilinde `ETIMEDOUT`/502 aldı. Etkilenen senaryo ayrı koşuda geçti; bu ağ hatası test kayıtlarında korundu. Gerçek koyu tema `.dark` sınıfıyla, 390 px ekran ve bütçe formu taşma kontrolüyle sınandı. Son bütçe/rapor tavanı/dışa aktarma yoğunluğu/güvenlik grubunda 35 test geçti. Son Docker paketi oluşturuldu; root olmayan kullanıcı, PostgreSQL 16 istemcisi, yazılabilir özel dosya depoları ve 0104 bütçe migration'ı doğrulandı.

## Yeni ekranlar ve sınırlar

- `/settings/operations`: belge 1–100 MB, saha dosyası 1–25 MB sınırı; günlük kur, yedek politikası, şirket MFA zorunluluğu.
- `/settings/backups`: tam kurulum yedeği, imzalı paket içe aktarma ve ayrı kurtarma veritabanına geri yükleme. Yedekler özel dosya deposunu da kapsar. Web paketi sınırı 128 MB; büyük yedekler işletim betikleriyle aktarılır.
- `/reports/activity`: kullanıcı/gün/modül olayları, önceki/sonraki değerler, açık sayaç süreleri, puantaj. Sırlar ve yetkisiz kaynaklar filtrelenir. Olay adedi çalışma saati olarak yorumlanmaz.
- `/reports/insights`: kaynak rapor seçimi, kaydedilmiş kişisel veya paylaşılan grafik, kaynak tablo ve dışa aktarma. Birim/para birimi uyumsuz toplamlar reddedilir.
- `/sales/campaigns`: tarih, para birimi, müşteri, ürün, miktar ve minimum tutara bağlı yüzdelik promosyon. Fatura taslağı önce önizlenir; eski koşullar değişmez geçmişte tutulur. İlk sürüm tek fatura için tek kampanya uygular.
- `/settings/recurring`: takvimli ajanda veya stoksuz kira/abonelik fatura taslağı. Seri başına dönem tekildir; finansal kayıt otomatik onaylanmaz.
- `/treasury/expenses`: personel masrafı, seçilen açık avansın kısmi/tam mahsubu ve kalan tutarın kasa/bankadan iadesi. Yalnızca defter para biriminde çalışır; personel cari düzenleme ve ödeme izinleri birlikte gerekir.
- `/accounting/fixed-assets`: demirbaş, araç ve iş makinesi kartı; departman/konum/seri; kullanıcı maliyet/kalıntı/ömür varsayımıyla düz çizgi amortisman. Edinim yevmiyesi ayrıca girilir. Aylık tutar taslak yevmiye oluşturur; kayıt muhasebe ekranından yapılır. İptal edilen dönem geçmişte kalır; taslak tekrar kaydedilemez, kayıtlı dönem ters yevmiye ile nötrlenir. Geçmişi olan kartın mali bilgileri değişmez. Satış/elden çıkarma ve vergi mevzuatı hesabı bu sürümde yoktur.
- `/accounting/budgets`: şirket veya departman için 12 aylık gelir/gider planı, yetkili onayı, değişmez eski revizyon, tek açık taslak, aylık sapma grafiği, yevmiye kaynakları ve Excel/CSV/baskı. Gider yönü borç−alacak, gelir yönü alacak−borç olarak kullanıcı seçer. Gerçekleşen yalnız kayıtlı defter tutarlarıdır; ters kayıtlar dahil, yıl sonu kapanışları ve taslaklar hariçtir. Yıllık bütçeye kalan, gelecek ayların planını da içerir; aylık sapma ayrıca gösterilir. Sıfır bütçede yüzde boş kalır, henüz gelmeyen aylar gerçekleşmiş sayılmaz. Bütçe dışı gelir/gider hesapları uyarılır.

### Departman bütçesinin kapsamı

Mevcut defter satırlarında ayrı bir departman boyutu yoktur. Departman bütçesi bu nedenle açıkça seçilen muhasebe hesapları ve isteğe bağlı proje süzgeciyle tanımlanır. Departman adı tek başına kayıtları süzmez; personelin departmanından maliyet tahmini yapılmaz. Birden fazla bütçe aynı hareketi kapsayabileceği için bütçeler otomatik toplanmaz. Proje izni kaldırıldığında proje kapsamlı bütçe, dışa aktarma ve denetim ayrıntıları kapatılır. Bu sürümde genel giderlerin departmanlara otomatik paylaştırılması ve doğrudan departman kodlu yevmiye satırı yoktur.

### Yedek kurulum ayarı

`BACKUP_DATABASE_URL`, çalışma veritabanıyla aynı sunucu ve veritabanına işaret eden ayrı bir PostgreSQL bakım hesabıdır. Uygulama normal işlemlerde `erp_app` RLS hesabını kullanmaya devam eder. Bakım hesabı ve PostgreSQL 16 istemci araçları olmadan ekran gerekçeli olarak kapalıdır; mevcut `.env` için gizlice ayrıcalıklı erişim açılmaz. Tam kurulum yedeği yalnızca tek kuruluşa ayrılmış veritabanında sahip tarafından kullanılabilir.

`BACKUP_SIGNING_KEY` kalıcı ve özel saklanmalıdır; eski yedeği başka kuruluma taşırken aynı anahtar gerekir. Geri yükleme canlı veriyi ezmez: `erp_recovery_*` veritabanı ve ayrı dosya deposu hazırlanır, sayımlar gösterilir. Canlıya geçiş, uygulama durdurularak bağlantı ve depo ayarlarının değiştirilmesiyle işletim sorumlusu tarafından yapılır. Otomatik yedekler aynı kontrol ve saklama politikasını kullanır.

XLSX satırları ZIP/XML akışıyla yazılır; mevcut rapor sorguları hâlâ sonuç satırlarını belleğe alır. Bu değişiklik veritabanı cursor akışı iddiası taşımaz.
