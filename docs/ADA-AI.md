# Ada AI — mevcut uygulama ve doğrulama

Kullanıcının eklediği asistan, sunucudaki `@google/genai` SDK'sı üzerinden Gemini'ye bağlanır. AI dışındaki ERP yol haritasından ayrı incelenmiştir. Asistan mali kayıt oluşturmaz, kesinleştirmez veya değiştirmez; cevapları mali doğrulama yerine geçmez.

## Yapılandırma

`GEMINI_API_KEY` yalnız API sunucusunda okunur. `GEMINI_MODEL` kullanılacak model kimliğini belirler; varsayılan yapılandırma `gemini-flash-lite-latest` değeridir. Sağlayıcıda erişilebilir bir model ve geçerli sunucu anahtarı gereklidir. Anahtar yoksa arayüz kontrollü bir yapılandırma hatası gösterir. Bu çalışma gerçek Google hesabı veya ücretli model çağrısıyla doğrulanmamıştır.

## Veri erişimi

Araçlar kritik stok, kasa/banka bakiyesi, kalan vadesi geçmiş alacak/borç, son faturalar, projeler, taşeron sözleşmeleri ve bekleyen onayları okur. Araç listesi her istekte etkin şirket modülleri, güncel okuma izinleri ve dışa aktarma haklarından oluşturulur. Bekleyen onaylar ayrıca belge türünün iznine göre süzülür. Araç çağrısında izin tekrar kontrol edilir; keyfi SQL veya model tarafından üretilmiş işlem yürütülmez.

Sorgular mevcut şirket ve şube kapsamındaki PostgreSQL/RLS oturumunu kullanır. Gecikmiş alacak/borç, ödemeler, iadeler ve silmeler sonrası kalan tutardır. Kritik stok en fazla 50, gecikmiş alacak/borç listesi toplam en fazla 15 satır döndürür; toplam sayı ve sınır cevap verisinde belirtilir. Kasa/banka özetinde IBAN aktarılmaz.

Kullanıcının yazdığı mesajlar, sohbet geçmişi, şirket bağlamı ve izin verilen araç özetleri Google'a gönderilir. Okuma ve dışa aktarma kapıları bu veri aktarımını sınırlar. Yönergeler kayıt açıklamalarını güvenilmeyen veri sayar; bu önlem, modelin hatasız cevap vermesini veya yönlendirme saldırılarının her durumda önlenmesini garanti etmez.

## İstek sınırları

- Kullanıcı başına dakikada 20 istek; mesaj en fazla 2.000 karakter.
- Sağlayıcı çağrısı başına 30 saniye zaman aşımı ve bir deneme; yanıt sınırı 2.048 token.
- Bir istekte en fazla sekiz araç yürütülür. Aynı veritabanı oturumundaki çağrılar sırayla çalışır.
- Araç sonucu için tek takip çağrısı yapılır; takip çağrısına yeniden araç yetkisi verilmez.
- Ham sağlayıcı veya SQL hataları kullanıcıya taşınmaz. Ortak HTTP istemcisinin ayarları değiştirilmez.

## Arayüz ve test kapsamı

Asistan üst çubuktan veya Ctrl/Cmd+J ile açılır. Sohbet şirket, kullanıcı ve şube kapsamına bağlıdır; kapsam değişince eski mesajlar kaldırılır ve açık istek iptal edilir. Temizle işlemi de bekleyen cevabın yeniden eklenmesini engeller. Geçmiş yalnız bileşen belleğinde tutulur.

API testleri izin ve dışa aktarma engellerini, şirket oturumunu, kalan alacak hesabını, geçersiz araç parametrelerini ve kontrollü hata cevaplarını sınar. Tarayıcı testi sahte API cevaplarıyla 390 px açık/koyu temayı, uzun metnin tek kaydırma alanında kalmasını ve şirket değişiminde geçmişin taşınmamasını kontrol eder. Sağlayıcı kotası, model erişimi ve gerçek cevap kalitesi ayrıca gerçek hesapla sınanmalıdır.
