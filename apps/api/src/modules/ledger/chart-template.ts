/**
 * Tekdüzen Hesap Planı başlangıç şablonu (sınıf > grup > hesap).
 *
 * ÖNEMLİ: Bu şablon genel Tekdüzen yapıya dayanır ve KKTC'de resmi olarak
 * doğrulanmamıştır. Şirket kurulumunda yüklenir, sonrasında şirkete özgü
 * düzenlenebilir. Ticari kullanımdan önce mali müşavirle gözden geçirin (bkz. docs/LEGAL-NOTES.md).
 *
 * 1 haneli = sınıf, 2 haneli = grup (kayıt atılamaz); 3 haneli = hesap (kayıt atılabilir).
 */
const RAW = `
1|DÖNEN VARLIKLAR
10|Hazır Değerler
100|Kasa
101|Alınan Çekler
102|Bankalar
103|Verilen Çekler ve Ödeme Emirleri (-)
108|Diğer Hazır Değerler
11|Menkul Kıymetler
110|Hisse Senetleri
118|Diğer Menkul Kıymetler
119|Menkul Kıymetler Değer Düşüklüğü Karşılığı (-)
12|Ticari Alacaklar
120|Alıcılar
121|Alacak Senetleri
122|Alacak Senetleri Reeskontu (-)
126|Verilen Depozito ve Teminatlar
127|Diğer Ticari Alacaklar
128|Şüpheli Ticari Alacaklar
129|Şüpheli Ticari Alacaklar Karşılığı (-)
13|Diğer Alacaklar
131|Ortaklardan Alacaklar
136|Diğer Çeşitli Alacaklar
15|Stoklar
150|İlk Madde ve Malzeme
151|Yarı Mamuller
152|Mamuller
153|Ticari Mallar
157|Diğer Stoklar
158|Stok Değer Düşüklüğü Karşılığı (-)
159|Verilen Sipariş Avansları
18|Gelecek Aylara Ait Giderler ve Gelir Tahakkukları
180|Gelecek Aylara Ait Giderler
181|Gelir Tahakkukları
19|Diğer Dönen Varlıklar
190|Devreden KDV
191|İndirilecek KDV
192|Diğer KDV
193|Peşin Ödenen Vergiler ve Fonlar
195|İş Avansları
196|Personel Avansları
198|Diğer Çeşitli Dönen Varlıklar
2|DURAN VARLIKLAR
25|Maddi Duran Varlıklar
250|Arazi ve Arsalar
252|Binalar
253|Tesis, Makine ve Cihazlar
254|Taşıtlar
255|Demirbaşlar
257|Birikmiş Amortismanlar (-)
258|Yapılmakta Olan Yatırımlar
259|Verilen Avanslar
26|Maddi Olmayan Duran Varlıklar
260|Haklar
264|Özel Maliyetler
268|Birikmiş Amortismanlar (-)
3|KISA VADELİ YABANCI KAYNAKLAR
30|Mali Borçlar
300|Banka Kredileri
303|Uzun Vadeli Kredilerin Anapara Taksitleri ve Faizleri
32|Ticari Borçlar
320|Satıcılar
321|Borç Senetleri
326|Alınan Depozito ve Teminatlar
329|Diğer Ticari Borçlar
33|Diğer Borçlar
331|Ortaklara Borçlar
335|Personele Borçlar
336|Diğer Çeşitli Borçlar
34|Alınan Avanslar
340|Alınan Sipariş Avansları
349|Alınan Diğer Avanslar
36|Ödenecek Vergi ve Diğer Yükümlülükler
360|Ödenecek Vergi ve Fonlar
361|Ödenecek Sosyal Güvenlik Kesintileri
368|Vadesi Geçmiş, Ertelenmiş veya Taksitlendirilmiş Vergi ve Diğer Yükümlülükler
37|Borç ve Gider Karşılıkları
370|Dönem Kârı Vergi ve Diğer Yasal Yükümlülük Karşılıkları
372|Kıdem Tazminatı Karşılığı
38|Gelecek Aylara Ait Gelirler ve Gider Tahakkukları
380|Gelecek Aylara Ait Gelirler
381|Gider Tahakkukları
39|Diğer Kısa Vadeli Yabancı Kaynaklar
391|Hesaplanan KDV
392|Diğer KDV
4|UZUN VADELİ YABANCI KAYNAKLAR
40|Mali Borçlar
400|Banka Kredileri
42|Ticari Borçlar
420|Satıcılar
421|Borç Senetleri
5|ÖZKAYNAKLAR
50|Ödenmiş Sermaye
500|Sermaye
501|Ödenmemiş Sermaye (-)
54|Kâr Yedekleri
540|Yasal Yedekler
542|Olağanüstü Yedekler
57|Geçmiş Yıllar Kârları
570|Geçmiş Yıllar Kârları
58|Geçmiş Yıllar Zararları
580|Geçmiş Yıllar Zararları (-)
59|Dönem Net Kârı (Zararı)
590|Dönem Net Kârı
591|Dönem Net Zararı (-)
6|GELİR TABLOSU HESAPLARI
60|Brüt Satışlar
600|Yurt İçi Satışlar
601|Yurt Dışı Satışlar
602|Diğer Gelirler
61|Satış İndirimleri (-)
610|Satıştan İadeler (-)
611|Satış İskontoları (-)
62|Satışların Maliyeti (-)
620|Satılan Mamuller Maliyeti (-)
621|Satılan Ticari Mallar Maliyeti (-)
622|Satılan Hizmet Maliyeti (-)
63|Faaliyet Giderleri (-)
630|Araştırma ve Geliştirme Giderleri (-)
631|Pazarlama, Satış ve Dağıtım Giderleri (-)
632|Genel Yönetim Giderleri (-)
64|Diğer Faaliyetlerden Olağan Gelir ve Kârlar
642|Faiz Gelirleri
646|Kambiyo Kârları
649|Diğer Olağan Gelir ve Kârlar
65|Diğer Faaliyetlerden Olağan Gider ve Zararlar (-)
656|Kambiyo Zararları (-)
659|Diğer Olağan Gider ve Zararlar (-)
66|Finansman Giderleri (-)
660|Kısa Vadeli Borçlanma Giderleri (-)
661|Uzun Vadeli Borçlanma Giderleri (-)
67|Olağan Dışı Gelir ve Kârlar
671|Önceki Dönem Gelir ve Kârları
679|Diğer Olağan Dışı Gelir ve Kârlar
68|Olağan Dışı Gider ve Zararlar (-)
689|Diğer Olağan Dışı Gider ve Zararlar (-)
69|Dönem Net Kârı veya Zararı
690|Dönem Kârı veya Zararı
7|MALİYET HESAPLARI
70|Maliyet Muhasebesi Bağlantı Hesapları
71|Direkt İlk Madde ve Malzeme Giderleri
710|Direkt İlk Madde ve Malzeme Giderleri
72|Direkt İşçilik Giderleri
720|Direkt İşçilik Giderleri
73|Genel Üretim Giderleri
730|Genel Üretim Giderleri
74|Hizmet Üretim Maliyeti
740|Hizmet Üretim Maliyeti
76|Pazarlama, Satış ve Dağıtım Giderleri
760|Pazarlama, Satış ve Dağıtım Giderleri
77|Genel Yönetim Giderleri
770|Genel Yönetim Giderleri
78|Finansman Giderleri
780|Finansman Giderleri
`;

export interface ChartRow {
  code: string;
  name: string;
  /** Üst hesap kodu (sınıf için null). */
  parentCode: string | null;
  isPostable: boolean;
}

export const CHART_TEMPLATE: readonly ChartRow[] = RAW.trim()
  .split('\n')
  .map((line) => {
    const [code, name] = line.split('|') as [string, string];
    return {
      code,
      name,
      parentCode: code.length === 1 ? null : code.slice(0, code.length === 3 ? 2 : 1),
      isPostable: code.length === 3,
    };
  });
