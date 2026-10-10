import type { OperationKind } from '@erp/shared';

export function operationsReturnDestination(sector: string, canReadProjects: boolean) {
  return sector === 'CONSTRUCTION' && canReadProjects
    ? { path: '/workspace/construction', label: 'İnşaat kontrol merkezi' }
    : { path: '/workspace', label: 'Çalışma alanı' };
}
export const labels: Record<OperationKind, string> = {
  collection: 'Tahsilat takibi',
  site_report: 'Şantiye günlük raporu',
  schedule: 'İş programı',
  equipment: 'Ekipman ve araçlar',
  equipment_log: 'Ekipman çalışma ve giderleri',
  defect: 'Teslim ve kusur takibi',
  rfi: 'Teknik bilgi talepleri',
  site_instruction: 'Saha talimatları',
  quality_check: 'Kalite kontrolleri',
  safety: 'İş güvenliği aksiyonları',
};
export const optionLabels: Record<string, string> = {
  vehicle: 'Araç',
  machine: 'Makine',
  tool: 'Alet',
  fuel: 'Yakıt',
  maintenance: 'Bakım',
  rent: 'Kira',
  other: 'Diğer',
  phone: 'Telefon',
  email: 'E-posta',
  meeting: 'Görüşme',
  message: 'Mesaj',
  pending: 'Bekliyor',
  promised: 'Ödeme sözü alındı',
  disputed: 'İtiraz var',
  unreachable: 'Ulaşılamadı',
  paid: 'Ödendi olarak bildirildi',
  civil: 'İnşaat',
  architecture: 'Mimari',
  mechanical: 'Mekanik',
  electrical: 'Elektrik',
  concrete: 'Beton',
  rebar: 'Donatı',
  waterproofing: 'Su yalıtımı',
  finishing: 'İnce işler',
  installation: 'Tesisat',
  pass: 'Uygun',
  fail: 'Uygunsuz',
  low: 'Düşük',
  medium: 'Orta',
  high: 'Yüksek',
  critical: 'Kritik',
  inspection: 'Saha kontrolü',
  near_miss: 'Ramak kala',
  incident: 'Olay',
};
export const permissions: Record<OperationKind, string> = {
  collection: 'parties.read',
  site_report: 'projects.read',
  schedule: 'projects.read',
  equipment: 'projects.read',
  equipment_log: 'projects.read',
  defect: 'realestate.read',
  rfi: 'projects.read',
  site_instruction: 'projects.read',
  quality_check: 'projects.read',
  safety: 'projects.read',
};
export const writePermissions: Record<OperationKind, string> = {
  collection: 'parties.manage',
  site_report: 'projects.manage',
  schedule: 'projects.manage',
  equipment: 'projects.manage',
  equipment_log: 'projects.manage',
  defect: 'realestate.manage',
  rfi: 'projects.manage',
  site_instruction: 'projects.manage',
  quality_check: 'projects.manage',
  safety: 'projects.manage',
};
type FieldDef = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'note' | 'select';
  options?: string[];
  numeric?: boolean;
  required?: boolean;
};
export const fields: Record<OperationKind, FieldDef[]> = {
  collection: [
    { key: 'promiseAmount', label: 'Söz verilen tutar', type: 'number', required: true },
    {
      key: 'currency',
      label: 'Para birimi',
      type: 'select',
      options: ['TRY', 'GBP', 'EUR', 'USD'],
    },
    { key: 'promiseDate', label: 'Ödeme sözü tarihi', type: 'date', required: true },
    { key: 'contactNote', label: 'Görüşme notu', type: 'note' },
    {
      key: 'channel',
      label: 'Görüşme kanalı',
      type: 'select',
      options: ['phone', 'email', 'meeting', 'message'],
    },
    {
      key: 'outcome',
      label: 'Görüşme sonucu',
      type: 'select',
      options: ['pending', 'promised', 'disputed', 'unreachable', 'paid'],
    },
  ],
  site_report: [
    { key: 'weather', label: 'Hava durumu', type: 'text' },
    { key: 'workers', label: 'Çalışan sayısı', type: 'number', numeric: true, required: true },
    { key: 'workDone', label: 'Yapılan işler', type: 'note' },
    { key: 'issues', label: 'Engeller ve ihtiyaçlar', type: 'note' },
  ],
  schedule: [
    { key: 'start', label: 'Planlanan başlangıç', type: 'date', required: true },
    { key: 'end', label: 'Planlanan bitiş', type: 'date', required: true },
    { key: 'progress', label: 'Tamamlanma (%)', type: 'number', numeric: true, required: true },
  ],
  equipment: [
    { key: 'code', label: 'Ekipman kodu / plaka', type: 'text', required: true },
    {
      key: 'category',
      label: 'Ekipman türü',
      type: 'select',
      options: ['vehicle', 'machine', 'tool'],
    },
    { key: 'serial', label: 'Seri numarası', type: 'text' },
    { key: 'nextMaintenance', label: 'Sonraki bakım tarihi', type: 'date' },
  ],
  equipment_log: [
    { key: 'hours', label: 'Çalışma saati', type: 'number', numeric: true, required: true },
    { key: 'fuelLiters', label: 'Yakıt (litre)', type: 'number', required: true },
    { key: 'cost', label: 'Gider tutarı', type: 'number', required: true },
    {
      key: 'currency',
      label: 'Para birimi',
      type: 'select',
      options: ['TRY', 'GBP', 'EUR', 'USD'],
    },
    {
      key: 'expenseType',
      label: 'Gider türü',
      type: 'select',
      options: ['fuel', 'maintenance', 'rent', 'other'],
    },
  ],
  defect: [
    { key: 'location', label: 'Kusurun konumu', type: 'text', required: true },
    { key: 'resolution', label: 'Çözüm / yapılan düzeltme', type: 'note' },
  ],
  rfi: [
    { key: 'reference', label: 'Çizim / doküman referansı', type: 'text' },
    {
      key: 'discipline',
      label: 'Disiplin',
      type: 'select',
      options: ['civil', 'architecture', 'mechanical', 'electrical', 'other'],
    },
    { key: 'question', label: 'Teknik soru', type: 'note', required: true },
    { key: 'response', label: 'Teknik yanıt', type: 'note' },
  ],
  site_instruction: [
    { key: 'location', label: 'Talimat konumu', type: 'text', required: true },
    { key: 'instruction', label: 'Uygulanacak talimat', type: 'note', required: true },
    { key: 'completionNote', label: 'Uygulama açıklaması', type: 'note' },
  ],
  quality_check: [
    { key: 'location', label: 'Kontrol konumu', type: 'text', required: true },
    {
      key: 'checkType',
      label: 'Kontrol türü',
      type: 'select',
      options: ['concrete', 'rebar', 'waterproofing', 'finishing', 'installation', 'other'],
    },
    {
      key: 'result',
      label: 'Kontrol sonucu',
      type: 'select',
      options: ['pending', 'pass', 'fail'],
    },
    { key: 'findings', label: 'Bulgular', type: 'note' },
    { key: 'correctiveAction', label: 'Düzeltici faaliyet', type: 'note' },
    { key: 'resolution', label: 'Giderilme açıklaması', type: 'note' },
  ],
  safety: [
    { key: 'location', label: 'Risk konumu', type: 'text', required: true },
    {
      key: 'severity',
      label: 'Risk seviyesi',
      type: 'select',
      options: ['medium', 'low', 'high', 'critical'],
    },
    {
      key: 'eventType',
      label: 'Kayıt türü',
      type: 'select',
      options: ['inspection', 'near_miss', 'incident'],
    },
    { key: 'observation', label: 'Tespit / gözlem', type: 'note', required: true },
    { key: 'correctiveAction', label: 'Alınacak önlem', type: 'note', required: true },
    { key: 'resolution', label: 'Giderilme açıklaması', type: 'note' },
  ],
};
