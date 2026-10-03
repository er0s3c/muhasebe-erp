import type { FeatureSpec } from './scenes/FeatureScene';
import { sceneById } from './timing';

/**
 * Bölümlerin görsel kurgusu. Süreler saniye cinsindendir ve seslendirmenin gerçek ifade zamanlarına (timeline.json) bağlıdır;
 * konuşma metni değişip `npm run voice` yeniden çalıştırılınca vurgular da kayar. Dikdörtgenler ekran görüntüsünün kesirli
 * koordinatlarıdır: [x, y, genişlik, yükseklik]. Ekranlar `scripts/capture-shots.ts` ile demo verisinden alınır.
 */
const COUNT = 5;
/** Başlık kartı çıkışı bittikten (≈0,7 sn) sonra vurgular başlar. */
const afterTitle = (id: string) => sceneById(id).cues[0].end + 0.2 + 0.75;

export function buildSpecs(): Record<string, FeatureSpec> {
  const m = sceneById('muhasebe');
  const f = sceneById('fatura');
  const k = sceneById('kasa');
  const i = sceneById('insaat');
  const g = sceneById('guvenlik');
  const mT = afterTitle('muhasebe');
  const fT = afterTitle('fatura');
  const kT = afterTitle('kasa');
  const iT = afterTitle('insaat');
  const gT = afterTitle('guvenlik');

  return {
    muhasebe: {
      number: 1,
      count: COUNT,
      title: 'Muhasebe çekirdeği',
      subtitle: 'Değiştirilemez defter, çoklu para birimi',
      chapter: '01 Muhasebe',
      shots: [
        {
          src: 'journal.png',
          page: 'Yevmiye kayıtları',
          from: 0,
          to: m.cues[2].start - 0.1,
          cam: [
            { t: 0, s: 1, cx: 0.5, cy: 0.5 },
            { t: mT - 0.2, s: 1, cx: 0.5, cy: 0.5 },
            { t: mT + 0.9, s: 1.35, cx: 0.5, cy: 0.22 },
            { t: mT + 3.4, s: 1.35, cx: 0.5, cy: 0.22 },
            { t: mT + 4.6, s: 1.3, cx: 0.58, cy: 0.66 },
          ],
          callouts: [
            { rect: [0.225, 0.122, 0.275, 0.028], label: 'Kaydedilen yevmiye değiştirilemez', side: 'bottom', from: mT + 0.9, to: mT + 2.9 },
            { rect: [0.226, 0.752, 0.709, 0.046], label: 'Düzeltme: ters kayıt', side: 'top', from: mT + 3.4, to: m.cues[2].start - 0.1 },
          ],
        },
        {
          src: 'currencies.png',
          page: 'Para birimi ve kurlar',
          from: m.cues[2].start - 0.1,
          to: 99,
          cam: [
            { t: 0, s: 1, cx: 0.5, cy: 0.5 },
            { t: 0.9, s: 1.25, cx: 0.55, cy: 0.5 },
          ],
          callouts: [
            { rect: [0.238, 0.411, 0.684, 0.156], label: '₺ · £ · € · $ işlem günü kuruyla', side: 'bottom', from: m.cues[2].start + 0.7, to: m.cues[2].start + 2.9 },
            { rect: [0.519, 0.257, 0.131, 0.033], label: 'Merkez Bankası kurları', side: 'bottom', from: m.cues[2].start + 3, to: 99 },
          ],
        },
      ],
    },
    fatura: {
      number: 2,
      count: COUNT,
      title: 'Cari, stok ve fatura',
      subtitle: 'Tek kayıt, tüm defterlere işler',
      chapter: '02 Fatura',
      shots: [
        {
          src: 'invoice-detail.png',
          page: 'Satış faturası',
          from: 0,
          to: 99,
          cam: [
            { t: 0, s: 1, cx: 0.5, cy: 0.5 },
            { t: fT, s: 1, cx: 0.5, cy: 0.5 },
            { t: fT + 1.1, s: 1.2, cx: 0.62, cy: 0.62 },
          ],
          callouts: [{ rect: [0.803, 0.823, 0.132, 0.04], label: 'Kaydet ve muhasebeleştir', side: 'top', from: fT + 0.2, to: f.cues[1].start + 1.9 }],
        },
      ],
      overlay: {
        from: f.cues[1].start + 1.9,
        heading: 'Kaydet ve muhasebeleştir · tek işlemde',
        layout: 'row',
        cards: [
          { icon: 'stock', title: 'Stok hareketi', sub: 'Depodan çıkış, maliyetle', at: f.cues[1].start + 1.75 },
          { icon: 'party', title: 'Cari alacak', sub: 'Vadesiyle açık kalem', at: f.cues[1].start + 2.95 },
          { icon: 'ledger', title: 'Yevmiye', sub: 'Borç = alacak, KDV dahil', at: f.cues[1].start + 3.75 },
        ],
        tag: { text: 'Hepsi aynı anda', at: f.cues[1].start + 4.1 },
      },
    },
    kasa: {
      number: 3,
      count: COUNT,
      title: 'Kasa ve banka',
      subtitle: 'Çoklu para birimi, otomatik kur farkı',
      chapter: '03 Kasa & banka',
      shots: [
        {
          src: 'treasury.png',
          page: 'Kasa ve banka hesapları',
          from: 0,
          to: kT + 3.1,
          cam: [
            { t: 0, s: 1, cx: 0.5, cy: 0.5 },
            { t: kT, s: 1, cx: 0.5, cy: 0.5 },
            { t: kT + 1, s: 1.25, cx: 0.62, cy: 0.38 },
          ],
          callouts: [
            { rect: [0.706, 0.19, 0.229, 0.12], label: 'Çoklu para birimi', side: 'bottom', from: kT + 0.2, to: kT + 1.9 },
            { rect: [0.226, 0.37, 0.709, 0.235], label: 'Her hesap bir muhasebe hesabına bağlı', side: 'bottom', from: kT + 2, to: kT + 3.1 },
          ],
        },
        {
          src: 'treasury-tx.png',
          page: 'Kasa ve banka hareketleri',
          from: kT + 3.1,
          to: 99,
          cam: [
            { t: 0, s: 1, cx: 0.5, cy: 0.5 },
            { t: 0.9, s: 1.3, cx: 0.6, cy: 0.55 },
          ],
          callouts: [{ rect: [0.226, 0.5975, 0.709, 0.113], label: 'Kur farkı otomatik yazılır', side: 'bottom', from: kT + 3.9, to: 99 }],
        },
      ],
    },
    insaat: {
      number: 4,
      count: COUNT,
      title: 'İnşaat modülü',
      subtitle: 'Şantiyeden satışa tek çatı',
      chapter: '04 İnşaat',
      shots: [
        {
          src: 'project-detail.png',
          page: 'Güneş Sitesi · Proje özeti',
          from: 0,
          to: i.cues[1].start + 2.1,
          cam: [
            { t: 0, s: 1, cx: 0.5, cy: 0.5 },
            { t: iT, s: 1, cx: 0.5, cy: 0.5 },
            { t: iT + 0.9, s: 1.3, cx: 0.45, cy: 0.42 },
          ],
          callouts: [{ rect: [0.226, 0.382, 0.169, 0.1225], label: 'Şantiye bütçesi', side: 'bottom', from: iT + 0.1, to: i.cues[1].start + 2.1 }],
        },
        {
          src: 'subcontracts.png',
          page: 'Taşeron sözleşmeleri',
          from: i.cues[1].start + 2.1,
          to: i.cues[1].start + 3.5,
          cam: [
            { t: 0, s: 1.3, cx: 0.55, cy: 0.22 },
            { t: 1.4, s: 1.38, cx: 0.55, cy: 0.22 },
          ],
          callouts: [{ rect: [0.226, 0.226, 0.709, 0.08], label: 'Taşeron hakedişi', side: 'bottom', from: i.cues[1].start + 2.3, to: i.cues[1].start + 3.5 }],
        },
        {
          src: 'contracts.png',
          page: 'Satış sözleşmeleri',
          from: i.cues[1].start + 3.5,
          to: i.cues[2].start - 0.1,
          cam: [
            { t: 0, s: 1.25, cx: 0.55, cy: 0.3 },
            { t: 1.6, s: 1.33, cx: 0.55, cy: 0.3 },
          ],
          callouts: [{ rect: [0.226, 0.226, 0.709, 0.272], label: 'Gayrimenkul satışı · dövizli taksit', side: 'bottom', from: i.cues[1].start + 3.7, to: i.cues[2].start - 0.1 }],
        },
        {
          src: 'project-detail.png',
          page: 'Güneş Sitesi · Proje özeti',
          from: i.cues[2].start - 0.1,
          to: 99,
          cam: [
            { t: 0, s: 1.15, cx: 0.5, cy: 0.45 },
            { t: 1.0, s: 1.3, cx: 0.5, cy: 0.4 },
          ],
          callouts: [{ rect: [0.405, 0.382, 0.169, 0.1225], label: 'Gerçekleşen maliyet: defterden', side: 'bottom', from: i.cues[2].start + 0.2, to: 99 }],
        },
      ],
    },
    guvenlik: {
      number: 5,
      count: COUNT,
      title: 'Güvenlik ve yetki',
      subtitle: 'Verileriniz sizde, kontrol sizde',
      chapter: '05 Güvenlik',
      shots: [
        {
          src: 'members.png',
          page: 'Kullanıcılar ve yetkiler',
          from: 0,
          to: 99,
          cam: [
            { t: 0, s: 1, cx: 0.5, cy: 0.5 },
            { t: gT, s: 1, cx: 0.5, cy: 0.5 },
            { t: gT + 3, s: 1.25, cx: 0.6, cy: 0.3 },
          ],
          callouts: [],
        },
      ],
      overlay: {
        from: g.cues[1].start + 0.2,
        heading: '',
        layout: 'grid',
        cards: [
          { icon: 'shield', title: 'Satır düzeyi yalıtım', sub: 'Başka şirketin verisi görünmez', at: g.cues[1].start + 0.9 },
          { icon: 'roles', title: 'Rol bazlı yetki', sub: 'Sahip, muhasebeci, izleyici', at: g.cues[1].start + 2.5 },
          { icon: 'audit', title: 'Denetim izi', sub: 'Her işlem kayda geçer', at: g.cues[1].start + 4.1 },
          { icon: 'backup', title: 'Yedekleme', sub: 'Geri yükleme tatbikatıyla', at: g.cues[1].start + 5.0 },
        ],
      },
    },
  };
}
