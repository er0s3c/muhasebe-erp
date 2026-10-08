# Üretim ve nakit tahminleri

Üretim planındaki **Rotayı ekle**, seçilen ürün revizyonu ve operasyon için kaynak bazında süre tahmini getirir. Son 90 gündeki gerçekleşen süreler iyi adede bölünür. Yakın tarihli kayıtlar daha yüksek ağırlık alır; dört veya daha fazla örnekte belirgin uç değerler dışarıda bırakılır. Üçten az örnekte mevcut standart süreyle harmanlama yapılır. Süre, operasyonun henüz tamamlanmamış iyi adedi üzerinden hesaplanır.

Plan satırında gerçek/standart/karma/elle kaynak, örnek sayısı, güven ve gözlenen süre aralığı görünür. Bu aralık istatistiksel bir garanti değildir. Gerçek veya standart veri bulunmuyorsa süre uydurulmaz; kullanıcı pozitif bir süre girmeden senaryo oluşturamaz. Kaynak değişince tahmin yenilenir; kullanıcının elle girdiği pozitif süre korunur. Mevcut kaynak takvimi, bakım ve devamsızlık kısıtları termin hesabına uygulanmaya devam eder.

Nakit projeksiyonunda üç yöntem vardır:

- **Sözleşmedeki vadeler:** mevcut açık kalemlerin vadelerini kullanır.
- **Gerçek ödeme geçmişi:** son 180 günde tamamen kapatılmış cari kalemlerden, cari ve alacak/borç türü bazında medyan ödeme gecikmesini öğrenir.
- **İhtiyatlı ödeme geçmişi:** aynı geçmişteki gecikmelerin yüzde 80 noktasını kullanır.

Bir kaynak kalem bir örnektir; kısmi ödemeler örnek sayısını çoğaltmaz. En az üç tamamlanmış örnek yoksa sözleşme vadesi korunur. Öğrenilen gecikme 0–120 gün aralığındadır. **Ek tahsilat gecikmesi** yalnız alacakların beklenen tarihini öteler. Çek/senet ve elle girilmiş tarihler korunur. Vadesi geçmiş ve projeksiyon başlangıcından önce beklenen kalemler ilk haftaya alınır.

Beklenen tarih, özgün vade ve tahmin kaynağı kalemlerde görünür. Excel/PDF çıktısı seçilen yöntemi ve ek gecikmeyi kullanır. Tutarlar ve muhasebe kayıtları bu seçeneklerle değişmez; tahmin kesin tahsilat sözü değildir.

Doğrulama kaynakları: `packages/shared/src/forecasting.test.ts`, API'nin nakit ve üretim iş akışı testleri, `e2e/manufacturing-demo.spec.ts`, `e2e/ui-audit.spec.ts` ve `e2e/ui-details.spec.ts`.
