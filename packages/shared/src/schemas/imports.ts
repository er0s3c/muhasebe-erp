import { z } from 'zod';
import { isoDate, uuid } from './common';

/** İçe aktarılabilen veri türleri. */
export const IMPORT_KINDS = ['parties', 'items', 'party_openings', 'stock_openings', 'ledger_openings'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const IMPORT_KIND_LABELS: Record<ImportKind, string> = {
  parties: 'Cari kartları',
  items: 'Stok kartları',
  party_openings: 'Cari açılış bakiyeleri',
  stock_openings: 'Stok açılışı',
  ledger_openings: 'Genel mizan açılışı',
};

/** Sınırlar (API ve arayüz aynı değerleri kullanır). */
export const IMPORT_LIMITS = {
  /** Yüklenen dosyanın en büyük boyutu (bayt). */
  maxFileBytes: 5 * 1024 * 1024,
  maxRows: 5000,
  maxCols: 60,
  maxCellChars: 2000,
} as const;

/** Sayı biçimi: `auto` belirsiz biçimleri (örn. "1.234") reddeder ve kullanıcıdan seçmesini ister. */
export const NUMBER_FORMATS = ['auto', 'tr', 'en'] as const;
export type NumberFormat = (typeof NUMBER_FORMATS)[number];

export interface ImportFieldDef {
  key: string;
  /** Şablon başlığı ve eşleme ekranındaki ad. */
  label: string;
  required: boolean;
  /** Eşleme ekranında kısa açıklama. */
  hint?: string;
  /** Sütun başlığından otomatik eşleme için eş anlamlılar (harf/aksan/boşluk duyarsız karşılaştırılır). */
  synonyms: readonly string[];
  /** Şablondaki örnek değer. */
  example: string;
}

const f = (key: string, label: string, required: boolean, synonyms: readonly string[], example: string, hint?: string): ImportFieldDef => ({
  key,
  label,
  required,
  synonyms: [label, ...synonyms],
  example,
  hint,
});

export const IMPORT_FIELDS: Record<ImportKind, readonly ImportFieldDef[]> = {
  parties: [
    f('code', 'Kod', false, ['cari kod', 'cari kodu', 'hesap kodu', 'müşteri kodu'], 'CR-000101', 'Boşsa otomatik verilir'),
    f('name', 'Ünvan', true, ['ünvan / ad soyad', 'ad soyad', 'ad', 'adı', 'cari adı', 'cari ünvan', 'firma', 'firma adı', 'müşteri adı', 'isim', 'hesap adı'], 'Demir Çelik A.Ş.'),
    f('kind', 'Tür', false, ['cari türü', 'cari tipi', 'tip'], 'Tedarikçi', 'Müşteri, Tedarikçi ya da Her ikisi (boşsa Müşteri)'),
    f('taxNumber', 'Vergi no', false, ['vergi numarası', 'vergi kimlik no', 'vkn', 'tckn', 'vergi no/tc kimlik no'], '1234567890'),
    f('taxOffice', 'Vergi dairesi', false, ['vergi d.', 'vd'], 'Lefkoşa'),
    f('phone', 'Telefon', false, ['tel', 'telefon no', 'gsm', 'cep', 'cep telefonu'], '0392 222 00 00'),
    f('email', 'E-posta', false, ['eposta', 'e-mail', 'email', 'mail'], 'muhasebe@ornek.com'),
    f('address', 'Adres', false, ['adres bilgisi'], 'Sanayi Sitesi, Lefkoşa'),
    f('currencyCode', 'Para birimi', false, ['döviz', 'döviz cinsi', 'pb', 'para birimi kodu'], 'TRY', 'TRY, GBP, EUR, USD (boşsa TRY)'),
    f('paymentTermDays', 'Vade (gün)', false, ['vade', 'vade günü', 'ödeme vadesi'], '30'),
    f('creditLimit', 'Kredi limiti', false, ['risk limiti', 'limit'], '50.000,00'),
    f('notes', 'Not', false, ['notlar', 'açıklama'], ''),
  ],
  items: [
    f('code', 'Kod', false, ['stok kodu', 'stok kartı kodu', 'ürün kodu', 'malzeme kodu'], 'ST-000101', 'Boşsa otomatik verilir'),
    f('name', 'Ad', true, ['stok adı', 'ürün adı', 'malzeme adı', 'açıklama', 'stok kartı', 'ürün', 'malzeme'], 'Çimento 50 kg'),
    f('kind', 'Tür', false, ['stok türü', 'kalem türü'], 'Mal', 'Mal ya da Hizmet (boşsa Mal)'),
    f('unit', 'Birim', false, ['ölçü birimi', 'ölçü'], 'çuval', 'adet, kg, m, m², çuval… (boşsa adet)'),
    f('category', 'Kategori', false, ['grup', 'stok grubu', 'ürün grubu', 'kategori adı'], 'İnşaat malzemesi', 'Yoksa yeni kategori açılır'),
    f('barcode', 'Barkod', false, ['barkod no', 'ean'], '8690000000017'),
    f('vatCode', 'KDV kodu', false, ['kdv', 'kdv oranı', 'kdv %'], 'KDV-16', 'Ayarlar > KDV oranları kodu ya da oran (16)'),
    f('purchasePrice', 'Alış fiyatı', false, ['alış', 'alış bedeli', 'maliyet'], '185,00'),
    f('purchaseCurrency', 'Alış para birimi', false, ['alış döviz', 'alış pb'], 'TRY'),
    f('salePrice', 'Satış fiyatı', false, ['satış', 'satış bedeli', 'liste fiyatı'], '240,00'),
    f('saleCurrency', 'Satış para birimi', false, ['satış döviz', 'satış pb'], 'TRY'),
    f('minLevel', 'Kritik seviye', false, ['minimum stok', 'min stok', 'asgari stok', 'kritik stok'], '20'),
    f('notes', 'Not', false, ['notlar'], ''),
  ],
  party_openings: [
    f('party', 'Cari', true, ['cari kodu', 'cari kod', 'cari adı', 'cari ünvan', 'ünvan', 'hesap', 'müşteri', 'tedarikçi'], 'CR-000101', 'Cari kodu ya da tam ünvanı'),
    f('debit', 'Borç', false, ['borç bakiye', 'borç bakiyesi', 'bize borçlu'], '12.500,00', 'Cari bize borçlu (alacağımız var)'),
    f('credit', 'Alacak', false, ['alacak bakiye', 'alacak bakiyesi', 'biz borçluyuz'], '', 'Biz cariye borçluyuz'),
    f('amount', 'Tutar', false, ['bakiye', 'bakiye tutarı', 'açılış tutarı'], '', 'Borç/Alacak sütunları yoksa: tutar + Bakiye türü'),
    f('side', 'Bakiye türü', false, ['bakiye tipi', 'b/a', 'borç/alacak', 'yön'], '', 'Borç ya da Alacak (Tutar ile birlikte)'),
    f('currencyCode', 'Para birimi', false, ['döviz', 'döviz cinsi', 'pb'], '', 'Boşsa carinin para birimi'),
    f('fxRate', 'Kur', false, ['döviz kuru', 'kur değeri'], '', 'Dövizli satırda; boşsa açılış tarihindeki kayıtlı kur'),
    f('dueDate', 'Vade tarihi', false, ['vade', 'vadesi'], '30.01.2026', 'Yaşlandırma için (isteğe bağlı)'),
    f('description', 'Açıklama', false, ['not', 'notlar'], 'Açılış bakiyesi'),
  ],
  stock_openings: [
    f('warehouse', 'Depo', false, ['depo kodu', 'depo adı'], 'ANA', 'Depo kodu ya da adı (boşsa varsayılan depo)'),
    f('item', 'Stok kartı', true, ['stok kodu', 'stok adı', 'ürün kodu', 'ürün adı', 'kod', 'barkod', 'malzeme'], 'ST-000101', 'Stok kodu, barkod ya da tam ad'),
    f('quantity', 'Miktar', true, ['adet', 'devir miktarı', 'mevcut', 'stok miktarı'], '120'),
    f('unitCost', 'Birim maliyet', true, ['birim fiyat', 'maliyet', 'alış fiyatı', 'birim alış fiyatı'], '185,00'),
    f('currencyCode', 'Para birimi', false, ['döviz', 'pb'], 'TRY', 'Boşsa şirket para birimi'),
    f('fxRate', 'Kur', false, ['döviz kuru'], '', 'Dövizli satırda; boşsa açılış tarihindeki kayıtlı kur'),
  ],
  ledger_openings: [
    f('account', 'Hesap kodu', true, ['hesap', 'kod', 'hesap no', 'muhasebe kodu'], '102.001'),
    f('accountName', 'Hesap adı', false, ['adı', 'ad', 'açıklama', 'hesap adı'], 'Banka TL', 'Yalnızca bilgi; içe aktarılmaz'),
    f('debit', 'Borç', false, ['borç bakiye', 'borç bakiyesi', 'borç tutarı'], '250.000,00'),
    f('credit', 'Alacak', false, ['alacak bakiye', 'alacak bakiyesi', 'alacak tutarı'], ''),
    f('fxRate', 'Kur', false, ['döviz kuru'], '', 'Dövizli hesapta; boşsa açılış tarihindeki kayıtlı kur'),
  ],
};

export const importRowSchema = z.object({
  /** Kaynak dosyadaki satır numarası (1 tabanlı; başlık satırı dahil). */
  row: z.number().int().min(1),
  /** Alan anahtarı → hücre metni (eşleme istemcide uygulanır). */
  cells: z.record(z.string().max(64), z.string().max(IMPORT_LIMITS.maxCellChars)),
});
export type ImportRow = z.infer<typeof importRowSchema>;

export const importParseSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  /** Dosya içeriği, base64. */
  contentBase64: z.string().min(1),
  /** xlsx için sayfa adı; verilmezse ilk sayfa. */
  sheet: z.string().max(100).optional(),
});
export type ImportParseInput = z.infer<typeof importParseSchema>;

export interface ImportParseResult {
  fileName: string;
  format: 'csv' | 'xlsx';
  sheets: string[];
  sheet: string | null;
  headers: string[];
  /** Başlık satırından sonraki dolu satırlar: `no` kaynak satır numarasıdır. */
  rows: { no: number; cells: string[] }[];
  /** Alan anahtarı → sütun indeksi (eşleşen yoksa null). */
  suggestedMapping: Record<string, number | null>;
  suggestedNumberFormat: NumberFormat;
}

const numberFormat = z.enum(NUMBER_FORMATS).default('auto');

export const partiesImportOptionsSchema = z.object({
  skipDuplicates: z.boolean().default(true),
  numberFormat,
});
export const itemsImportOptionsSchema = z.object({
  skipDuplicates: z.boolean().default(true),
  numberFormat,
});
export const partyOpeningsOptionsSchema = z.object({
  openingDate: isoDate,
  /** Açılış karşı hesabı; boşsa `opening_offset` eşlemesi. */
  offsetAccountId: uuid.optional(),
  numberFormat,
});
export const stockOpeningsOptionsSchema = z.object({
  openingDate: isoDate,
  numberFormat,
});
export const ledgerOpeningsOptionsSchema = z.object({
  openingDate: isoDate,
  /** Borç-alacak farkını bu hesaba at (boşsa `opening_offset` eşlemesi). */
  offsetAccountId: uuid.optional(),
  /** false ise fark hatadır. */
  plugDifference: z.boolean().default(true),
  numberFormat,
});

export const IMPORT_OPTION_SCHEMAS = {
  parties: partiesImportOptionsSchema,
  items: itemsImportOptionsSchema,
  party_openings: partyOpeningsOptionsSchema,
  stock_openings: stockOpeningsOptionsSchema,
  ledger_openings: ledgerOpeningsOptionsSchema,
} as const satisfies Record<ImportKind, z.ZodType>;

export const importRunSchema = z.object({
  rows: z.array(importRowSchema).min(1, 'İçe aktarılacak satır yok').max(IMPORT_LIMITS.maxRows),
  options: z.record(z.string(), z.unknown()).default({}),
});
export type ImportRunInput = z.infer<typeof importRunSchema>;

export type ImportMessageSeverity = 'error' | 'warning' | 'info';

export interface ImportMessage {
  severity: ImportMessageSeverity;
  /** Alan anahtarı (varsa). */
  field?: string;
  code: string;
  message: string;
}

export type ImportRowStatus = 'ok' | 'skip' | 'error';

export interface ImportPreviewRow {
  row: number;
  status: ImportRowStatus;
  /** Satırın kısa özeti (örn. cari adı, hesap kodu). */
  label: string;
  messages: ImportMessage[];
}

export interface ImportPreview {
  kind: ImportKind;
  counts: { total: number; ok: number; skip: number; error: number };
  rows: ImportPreviewRow[];
  /** Satırlara bağlı olmayan sorunlar (kapalı dönem, eksik hesap eşlemesi…). */
  general: ImportMessage[];
  /** Ön izleme özeti (yeni kayıt sayısı, toplamlar…). */
  summary: { label: string; value: string }[];
  canCommit: boolean;
}

export interface ImportCommitResult {
  kind: ImportKind;
  created: number;
  skipped: number;
  summary: { label: string; value: string }[];
  /** Oluşan yevmiye/belge kayıtları (varsa) */
  entries: { type: 'journal' | 'stock'; id: string; no: string }[];
}
