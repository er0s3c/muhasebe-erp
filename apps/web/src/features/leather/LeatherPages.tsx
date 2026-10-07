import { useState } from 'react';
import { TransfersPanel } from '../manufacturing/TransfersPanel';
import { CustomValuesPanel, PieceRatePanel } from '../manufacturing/SupportPanels';
import { ProductionLink as Link, useGenericProduction } from './production-context';
import { useTranslation } from 'react-i18next';
import {
  todayIso,
  type LeatherModel,
  type LeatherRevision,
  type LeatherVariant,
  type LeatherLot,
  type LeatherPiece,
  type LeatherProductionOrder,
  type LeatherQualityCheck,
  type LeatherSubcontractJob,
  type LeatherCustomOrder,
  type LeatherServiceCase,
  type LeatherOverview,
  type LeatherDocument,
  type LeatherCostAllocation,
  type LeatherRevisionInput,
} from '@erp/shared';
import Decimal from 'decimal.js';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Stat } from '../../components/ui/Stat';
import { useProductionCan as useCan, useProductionQuery as useCQuery } from './production-context';
import { useCompany } from '../../lib/session';
import { moneyIn, money } from '../../lib/format';
import {
  LeatherHeader,
  OperationForm,
  Records,
  Status,
  numberField,
  options,
  optional,
  selectField,
  textField,
  useFocusedRecord,
  useLeatherActions,
  type FormField,
  type Values,
} from './common';

const familyNames: Record<string, string> = {
  wallet: 'Cüzdan',
  card_holder: 'Kartlık',
  bag: 'Çanta',
  suitcase: 'Valiz',
  belt: 'Kemer',
  accessory: 'Diğer aksesuar',
};
const operationNames: Record<string, string> = {
  selection: 'Deri seçimi ve ton eşleme',
  cutting: 'Kesim',
  splitting: 'Yüzey inceltme',
  skiving: 'Kenar traşlama',
  punching: 'Delme',
  embossing: 'Baskı ve monogram',
  gluing: 'Yapıştırma ve katlama',
  stitching: 'Dikiş',
  edge_finishing: 'Kenar bitimi',
  assembly: 'Aksesuar montajı',
  final_quality: 'Son kalite',
  packing: 'Ambalaj',
};
const datedFields = (): FormField[] => [
  { name: 'date', label: 'İşlem tarihi', type: 'date', required: true, value: todayIso() },
  textField('note', 'İşlem notu'),
];
const dated = (values: Values) => ({
  date: values.date,
  note: values.note ?? '',
  requestKey: values._requestKey ?? crypto.randomUUID(),
});
const costText = (value: string | null, currency: string) =>
  value === null ? '—' : moneyIn(value, currency);

interface LookupItem {
  id: string;
  code: string;
  name: string;
  unit: string;
  kind: string;
  inventoryRole: string;
}
interface LookupData {
  resources?:{id:string;name:string}[];
  lots?:{id:string;code:string;itemId:string;warehouseId:string;quantity:string}[];
  items: LookupItem[];
  parties: { id: string; name: string; kind: string }[];
  warehouses: { id: string; name: string }[];
  members?: { id: string; name: string }[];
  depositTransactions?: {
    id: string;
    partyId: string;
    description: string;
    amount: string;
    currencyCode: string;
  }[];
  serviceInvoices?: { id: string; partyId: string; invoiceNo: string; description: string }[];
  customInvoices?: { id: string; partyId: string; invoiceNo: string; salesOrderId: string }[];
  salesOrderLines?: {
    id: string;
    orderId: string;
    orderNo: string;
    partyId: string;
    itemId: string;
    itemName: string;
    variantId: string;
    quantity: string;
    remaining: string;
  }[];
  saleLines: {
    id: string;
    invoiceId: string;
    partyId: string;
    itemId: string;
    description: string;
    quantity: string;
  }[];
  costLines: {
    id: string;
    entryDate: string;
    accountCode: string;
    description: string;
    debitBase: string;
    remaining: string;
  }[];
}
function useStockLookups() {
  const data = useCQuery<LookupData>(['leather', 'lookups'], '/api/leather/lookups');
  return {
    items: data.data?.items ?? [],
    parties: data.data?.parties ?? [],
    warehouses: data.data?.warehouses ?? [],
    members: data.data?.members ?? [],
    depositTransactions: data.data?.depositTransactions ?? [],
    serviceInvoices: data.data?.serviceInvoices ?? [],
    customInvoices: data.data?.customInvoices ?? [],
    salesOrderLines: data.data?.salesOrderLines ?? [],
    saleLines: data.data?.saleLines ?? [],
    costLines: data.data?.costLines ?? [],
    resources:data.data?.resources??[],
    lots:data.data?.lots??[],
    error: data.error,
  };
}
function useCatalog() {
  const can = useCan();
  const models = useCQuery<{ models: LeatherModel[] }>(
    ['leather', 'models'],
    '/api/leather/catalog/models',
    { enabled: can('leather.catalog.read') },
  );
  const variants = useCQuery<{ variants: LeatherVariant[] }>(
    ['leather', 'variants'],
    '/api/leather/catalog/variants',
    { enabled: can('leather.catalog.read') },
  );
  return { models, variants };
}
function useOrders() {
  const can = useCan();
  return useCQuery<{ orders: LeatherProductionOrder[] }>(
    ['leather', 'orders'],
    '/api/leather/production/orders',
    { enabled: can('leather.production.read') },
  );
}
function orderName(row: LeatherProductionOrder) {
  return `${row.code} · ${row.itemName}`;
}

export function LeatherOverviewPage() {
  const { t } = useTranslation();
  const company = useCompany();
  const data = useCQuery<{ overview: LeatherOverview }>(
    ['leather', 'overview'],
    '/api/leather/overview',
  );
  const value = data.data?.overview;
  const metrics: [string, number | string | undefined, string][] = [
    ['Model', value?.models, '/leather/models'],
    ['Aktif üretim', value?.activeOrders, '/leather/production'],
    ['Termin yaklaşan / geçen', value?.dueOrders, '/leather/production'],
    ['Kabul bekleyen parça', value?.quarantinePieces, '/leather/materials'],
    ['Açık kalite kaydı', value?.openQuality, '/leather/quality'],
    ['Açık fason işi', value?.openSubcontracts, '/leather/subcontracts'],
    ['Özel sipariş', value?.customOrders, '/leather/custom-orders'],
    ['Servis kaydı', value?.serviceCases, '/leather/service'],
    [
      'Üretimdeki değer',
      value ? costText(value.wipValue, company.baseCurrency) : undefined,
      '/leather/production',
    ],
  ];
  return (
    <>
      <LeatherHeader title={t('leather.title')} description={t('leather.subtitle')} />
      {data.error && <Callout tone="danger">{data.error.message}</Callout>}
      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {metrics.map(([label, amount, path]) => (
          <Link key={label} to={path}>
            <Stat label={label}>{amount ?? '—'}</Stat>
          </Link>
        ))}
      </div>
      <Card className="p-5">
        <h2 className="text-subheading">Atölye akışı</h2>
        <p className="mt-3 text-sm text-muted">
          Model ve numune → reçete ve rota → deri kabulü → parça / ton seçimi → kesim → üretim ve
          fason → kalite → mamul kabulü → satış ve servis.
        </p>
        <div className="mt-4 flex flex-wrap gap-5 text-sm">
          <Link className="link" to="/purchasing/requests">
            Satın alma
          </Link>
          <Link className="link" to="/inventory/items">
            Stok kartları
          </Link>
          <Link className="link" to="/pos">
            Mağaza kasası
          </Link>
        </div>
      </Card>
      {!!value?.provisionalReceipts && (
        <div className="mt-5">
          <Callout tone="warning">
            {value.provisionalReceipts} deri kabulünün maliyeti satın alma faturasıyla
            kesinleştirilmeyi bekliyor.
          </Callout>
        </div>
      )}
    </>
  );
}

export function LeatherModelsPage() {
  const generic=useGenericProduction();
  const { t } = useTranslation();
  const can = useCan();
  const save = useLeatherActions();
  const { models, variants } = useCatalog();
  const { items } = useStockLookups();
  const [modelId, setModelId] = useState('');
  const [editing, setEditing] = useState<LeatherRevision | null>(null);
  useFocusedRecord(models.data?.models, (row) => setModelId(row.id));
  const revisions = useCQuery<{ revisions: LeatherRevision[] }>(
    ['leather', 'revisions', modelId],
    modelId ? `/api/leather/catalog/models/${modelId}/revisions` : null,
  );
  return (
    <>
      <LeatherHeader
        title={t('leather.models')}
        description="Numuneyi, reçeteyi ve iş rotasını revizyon olarak saklayın; kabul edilmiş revizyondan ürün varyantları oluşturun."
      />
      {can('leather.catalog.manage') && (
        <OperationForm
          title="Yeni model"
          fields={[
            textField('code', 'Model kodu', true),
            textField('name', 'Model adı', true),
            generic?textField('family','Ürün ailesi',true):selectField(
              'family',
              'Ürün ailesi',
              Object.entries(familyNames).map(([value, label]) => ({ value, label })),
            ),
            textField('description', 'Model açıklaması'),
          ]}
          submit={(values) => save('/api/leather/catalog/models', values)}
        />
      )}
      <Records
        rows={models.data?.models}
        loading={models.isPending}
        error={models.error}
        columns={[
          { label: 'Kod', render: (row) => row.code },
          { label: 'Model', render: (row) => row.name },
          { label: 'Aile', render: (row) => familyNames[row.family] ?? row.family },
        ]}
        action={(row) => (
          <Button
            size="sm"
            onClick={() => {
              setModelId(row.id);
              setEditing(null);
            }}
          >
            Reçete ve varyantlar
          </Button>
        )}
      />
      <div className="my-5 max-w-md">
        <Field label="Çalışılan model">
          {(id) => (
            <Select
              id={id}
              value={modelId}
              onChange={(event) => {
                setModelId(event.target.value);
                setEditing(null);
              }}
            >
              <option value="">Model seçiniz</option>
              {models.data?.models.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.code} · {row.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {modelId && (
        <>
          {generic&&<CustomValuesPanel entity="model" id={modelId}/>}
          {can('leather.catalog.manage') && (
            <RevisionEditor
              key={`${modelId}-${editing?.id ?? 'new'}`}
              modelId={modelId}
              revision={editing}
              items={items}
              onDone={() => setEditing(null)}
            />
          )}
          <Records
            rows={revisions.data?.revisions}
            loading={revisions.isPending}
            error={revisions.error}
            columns={[
              { label: 'Revizyon', render: (row) => `R${row.revision} · ${row.name}` },
              { label: 'Malzeme', render: (row) => row.materials.length },
              { label: 'Operasyon', render: (row) => row.operations.length },
              {
                label: 'Numune',
                render: (row) => (row.sampleApproved ? 'Kabul edildi' : 'İncelemede'),
              },
              { label: 'Durum', render: (row) => <Status value={row.status} /> },
            ]}
            action={(row) => (
              <div className="flex gap-2">
                {row.status === 'draft' && can('leather.catalog.manage') && (
                  <Button size="sm" onClick={() => setEditing(row)}>
                    Düzenle
                  </Button>
                )}
                {row.status === 'draft' && can('leather.catalog.approve') && (
                  <OperationForm
                    title={`R${row.revision} üretime uygunluk`}
                    fields={[]}
                    action="Üretime uygun olarak onayla"
                    submit={() => save(`/api/leather/catalog/revisions/${row.id}/approve`, {})}
                  />
                )}
              </div>
            )}
          />
          {can('leather.catalog.manage') && (
            <div className="mt-5">
              <OperationForm
                key={`${modelId}-${revisions.data?.revisions.map((row) => row.id).join()}`}
                title="Yeni ürün varyantı"
                fields={[
                  selectField(
                    'revisionId',
                    'Üretim revizyonu',
                    options(
                      revisions.data?.revisions.filter((row) => row.status === 'approved'),
                      (row) => `R${row.revision} · ${row.name}`,
                    ),
                  ),
                  selectField(
                    'itemId',
                    'Mamul stok kartı',
                    options(items, (row) => `${row.code} · ${row.name}`),
                  ),
                  textField('color', 'Ürün rengi', true),
                  textField('size', 'Ölçü / beden'),
                  textField('hardwareColor', 'Aksesuar rengi'),
                  { ...numberField('beltLength', 'Kemer boyu (cm)'), required: false },
                  selectField(
                    'allowsPersonalization',
                    'Kişiselleştirme',
                    [
                      { value: 'false', label: 'Kapalı' },
                      { value: 'true', label: 'Monogram yapılabilir' },
                    ],
                    true,
                    'false',
                  ),
                ]}
                submit={(values) =>
                  save('/api/leather/catalog/variants', {
                    ...values,
                    modelId,
                    beltLength: optional(values.beltLength),
                    allowsPersonalization: values.allowsPersonalization === 'true',
                  })
                }
              >
                <Link className="link text-sm" to="/inventory/items">
                  Mamul stok kartı oluştur
                </Link>
              </OperationForm>
            </div>
          )}
        </>
      )}
      <div className="mt-5">
        <Records
          rows={variants.data?.variants.filter((row) => !modelId || row.modelId === modelId)}
          loading={variants.isPending}
          error={variants.error}
          columns={[
            { label: 'Ürün', render: (row) => row.itemName },
            { label: 'Model', render: (row) => row.modelName },
            { label: 'Revizyon', render: (row) => `R${row.revision}` },
            {
              label: 'Varyant',
              render: (row) =>
                [row.color, row.size, row.hardwareColor, row.beltLength && `${row.beltLength} cm`]
                  .filter(Boolean)
                  .join(' · '),
            },
          ]}
          action={row=>modelId===row.modelId&&can('leather.catalog.approve')?<OperationForm title="Varyantın yeni üretim revizyonu" description="Açık emirler kendi onaylı reçetelerini korur." fields={[selectField('revisionId','Onaylı revizyon',options(revisions.data?.revisions.filter(r=>r.status==='approved')??[],r=>`R${r.revision} · ${r.name}`))]} submit={v=>save(`/api/leather/catalog/variants/${row.id}/revision`,{revisionId:v.revisionId})}/>:null}
        />
      </div>
    </>
  );
}

function RevisionEditor({
  modelId,
  revision,
  items,
  onDone,
}: {
  modelId: string;
  revision: LeatherRevision | null;
  items: LookupItem[];
  onDone: () => void;
}) {
  const save = useLeatherActions();
  const generic=useGenericProduction();
  const can = useCan();
  const files = useCQuery<{ items: { id: string; filename: string }[] }>(
    ['record-documents', 'leather-model', modelId],
    `/api/workspace/documents?kind=leather_model&id=${modelId}&latest=true`,
    { enabled: can('workspace.use'), refetchOnWindowFocus: true },
  );
  const [attachments, setAttachments] = useState<string[]>(revision?.attachments ?? []);
  const [materials, setMaterials] = useState<(LeatherRevisionInput['materials'][number]&{alternatives?:string[]})[]>(
    revision?.materials ?? [{ itemId: '', quantity: '1', wastePct: '0', note: '' }],
  );
  const [byproducts,setByproducts]=useState<{itemId:string;quantity:string;costShare:string}[]>((revision as (LeatherRevision & {byproducts?:{itemId:string;quantity:string;costShare:string}[]})|null)?.byproducts??[]);
  const [operations, setOperations] = useState<LeatherRevisionInput['operations']>(
    revision?.operations ??
      (generic?['assembly','packing']:[
        'selection',
        'cutting',
        'skiving',
        'stitching',
        'edge_finishing',
        'assembly',
        'final_quality',
        'packing',
      ]).map((key) => ({
        key,
        name: operationNames[key]!,
        station: '',
        plannedMinutes: '0',
        outsourced: false,
      })),
  );
  return (
    <OperationForm
      title={
        revision ? `R${revision.revision} reçetesini düzenle` : 'Yeni reçete ve numune revizyonu'
      }
      fields={[
        { ...textField('name', 'Revizyon adı', true), value: revision?.name },
        {
          ...textField('sampleNotes', 'Numune değerlendirmesi'),
          type: 'textarea',
          value: revision?.sampleNotes,
        },
        selectField(
          'sampleApproved',
          'Numune sonucu',
          [
            { value: 'false', label: 'İncelemede' },
            { value: 'true', label: 'Numune kabul edildi' },
          ],
          true,
          revision?.sampleApproved ? 'true' : 'false',
        ),
        {
          ...textField('dimensions', 'Bitmiş ürün ölçüleri'),
          value: revision?.specifications.dimensions,
        },
        {
          ...textField('thickness', 'Hedef deri kalınlığı (mm)'),
          value: revision?.specifications.thickness,
        },
        {
          ...textField('qualityNotes', 'Kalite şartnamesi'),
          type: 'textarea',
          value: revision?.specifications.qualityNotes,
        },
      ]}
      submit={(values) =>
        save(
          revision
            ? `/api/leather/catalog/revisions/${revision.id}`
            : `/api/leather/catalog/models/${modelId}/revisions`,
          {
            name: values.name,
            sampleNotes: values.sampleNotes,
            sampleApproved: values.sampleApproved === 'true',
            specifications: {
              dimensions: values.dimensions ?? '',
              thickness: values.thickness ?? '',
              qualityNotes: values.qualityNotes ?? '',
            },
            materials,
            ...(generic?{byproducts}:{}),
            operations,
            attachments,
          },
          revision ? 'PUT' : 'POST',
        )
      }
      onDone={onDone}
    >
      <fieldset className="space-y-3">
        <legend>Kalıp ve teknik dosyalar</legend>
        {files.data?.items.map((file) => (
          <label key={file.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={attachments.includes(file.id)}
              onChange={(event) =>
                setAttachments((old) =>
                  event.target.checked ? [...old, file.id] : old.filter((id) => id !== file.id),
                )
              }
            />
            {file.filename}
          </label>
        ))}
        <Link
          className="link text-sm"
          target="_blank"
          to={`/workspace/documents?kind=leather_model&id=${modelId}`}
        >
          Modelin kalıp, çizim ve fotoğraflarını yükle
        </Link>
      </fieldset>
      <div className="space-y-3">
        <h3>Bir mamul için malzeme reçetesi</h3>
        {materials.map((line, index) => (
          <div
            key={index}
            className="grid items-end gap-3 rounded-xl border border-border p-3 sm:grid-cols-4"
          >
            {generic&&<Field label={`Alternatif malzemeler ${index+1}`} hint="Birden fazla seçim için Ctrl tuşunu kullanın.">{id=><Select id={id} multiple value={line.alternatives??[]} onChange={e=>setMaterials(old=>old.map((row,i)=>i===index?{...row,alternatives:Array.from(e.target.selectedOptions,o=>o.value)}:row))}>{items.filter(i=>i.id!==line.itemId).map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</Select>}</Field>}
            <Field label={`Reçete malzemesi ${index + 1}`} required>
              {(id) => (
                <Select
                  id={id}
                  required
                  value={line.itemId}
                  onChange={(event) =>
                    setMaterials((old) =>
                      old.map((row, i) =>
                        i === index ? { ...row, itemId: event.target.value } : row,
                      ),
                    )
                  }
                >
                  <option value="">Stok kartı seçiniz</option>
                  {items.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name} ({row.unit})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={`Birim tüketim ${index + 1}`} required>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  step="any"
                  min="0.0001"
                  required
                  value={line.quantity}
                  onChange={(event) =>
                    setMaterials((old) =>
                      old.map((row, i) =>
                        i === index ? { ...row, quantity: event.target.value } : row,
                      ),
                    )
                  }
                />
              )}
            </Field>
            <Field label={`Plan fire (%) ${index + 1}`}>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  step="any"
                  min="0"
                  max="100"
                  value={line.wastePct}
                  onChange={(event) =>
                    setMaterials((old) =>
                      old.map((row, i) =>
                        i === index ? { ...row, wastePct: event.target.value } : row,
                      ),
                    )
                  }
                />
              )}
            </Field>
            <Button
              onClick={() => setMaterials((old) => old.filter((_, i) => i !== index))}
              disabled={materials.length === 1}
            >
              Malzemeyi kaldır
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          onClick={() =>
            setMaterials((old) => [...old, { itemId: '', quantity: '1', wastePct: '0', note: '' }])
          }
        >
          Reçete malzemesi ekle
        </Button>
      </div>
      {generic&&<fieldset className="space-y-3"><legend>Yan ürünler</legend>{byproducts.map((line,index)=><div key={index} className="grid gap-3 sm:grid-cols-4"><Field label={`Yan ürün ${index+1}`} required>{id=><Select id={id} value={line.itemId} required onChange={e=>setByproducts(old=>old.map((r,i)=>i===index?{...r,itemId:e.target.value}:r))}><option value="">Stok seçiniz</option>{items.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</Select>}</Field><Field label={`Yan ürün miktarı ${index+1}`} required>{id=><Input id={id} required type="number" min="0.0001" step="any" value={line.quantity} onChange={e=>setByproducts(old=>old.map((r,i)=>i===index?{...r,quantity:e.target.value}:r))}/>}</Field><Field label={`Maliyet payı ${index+1}`} hint="0,20 payı %20 anlamına gelir.">{id=><Input id={id} type="number" min="0" max="0.9999" step="any" value={line.costShare} onChange={e=>setByproducts(old=>old.map((r,i)=>i===index?{...r,costShare:e.target.value}:r))}/>}</Field><Button type="button" onClick={()=>setByproducts(old=>old.filter((_,i)=>i!==index))}>Kaldır</Button></div>)}<Button type="button" onClick={()=>setByproducts(old=>[...old,{itemId:'',quantity:'1',costShare:'0'}])}>Yan ürün ekle</Button></fieldset>}
      {generic&&<fieldset className="space-y-3"><legend>Operasyon rotası</legend>{operations.map((op,index)=><div key={index} className="grid gap-3 sm:grid-cols-3">{(['key','name','station','plannedMinutes']as const).map((key,i)=><Field key={key} label={['Operasyon kodu','Operasyon adı','İş merkezi','Birim süre (dk)'][i]!}>{id=><Input id={id} value={op[key]} type={key==='plannedMinutes'?'number':'text'} onChange={e=>setOperations(old=>old.map((r,j)=>j===index?{...r,[key]:e.target.value}:r))}/>}</Field>)}<label><input type="checkbox" checked={op.outsourced} onChange={e=>setOperations(old=>old.map((r,i)=>i===index?{...r,outsourced:e.target.checked}:r))}/> Fason operasyon</label><Button type="button" onClick={()=>setOperations(old=>old.filter((_,i)=>i!==index))}>Operasyonu kaldır</Button></div>)}<Button type="button" onClick={()=>setOperations(old=>[...old,{key:'op'+(old.length+1),name:'Yeni operasyon',station:'',plannedMinutes:'0',outsourced:false}])}>Operasyon ekle</Button></fieldset>}
      {!generic&&<fieldset className="space-y-3">
        <legend className="mb-3">İş rotası ve süre</legend>
        {Object.entries(operationNames).map(([key, name]) => {
          const row = operations.find((item) => item.key === key);
          return (
            <div
              key={key}
              className="grid items-center gap-3 border-b border-border pb-3 sm:grid-cols-4"
            >
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!row}
                  onChange={(event) =>
                    setOperations((old) =>
                      event.target.checked
                        ? Object.keys(operationNames)
                            .filter(
                              (operationKey) =>
                                operationKey === key ||
                                old.some((item) => item.key === operationKey),
                            )
                            .map(
                              (operationKey) =>
                                old.find((item) => item.key === operationKey) ?? {
                                  key: operationKey,
                                  name: operationNames[operationKey]!,
                                  station: '',
                                  plannedMinutes: '0',
                                  outsourced: false,
                                },
                            )
                        : old.filter((item) => item.key !== key),
                    )
                  }
                />
                {name}
              </label>
              {row && (
                <>
                  <Field label={`${name} iş istasyonu`}>
                    {(id) => (
                      <Input
                        id={id}
                        value={row.station}
                        onChange={(event) =>
                          setOperations((old) =>
                            old.map((item) =>
                              item.key === key ? { ...item, station: event.target.value } : item,
                            ),
                          )
                        }
                      />
                    )}
                  </Field>
                  <Field label={`${name} süre (dk)`}>
                    {(id) => (
                      <Input
                        id={id}
                        type="number"
                        min="0"
                        step="any"
                        value={row.plannedMinutes}
                        onChange={(event) =>
                          setOperations((old) =>
                            old.map((item) =>
                              item.key === key
                                ? { ...item, plannedMinutes: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    )}
                  </Field>
                  <label className="flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={row.outsourced}
                      onChange={(event) =>
                        setOperations((old) =>
                          old.map((item) =>
                            item.key === key ? { ...item, outsourced: event.target.checked } : item,
                          ),
                        )
                      }
                    />
                    Fason operasyon
                  </label>
                </>
              )}
            </div>
          );
        })}
      </fieldset>}
    </OperationForm>
  );
}

interface PieceDraft {
  code: string;
  area: string;
  areaUnit: string;
  usableArea: string;
  grade: string;
  tone: string;
  thicknessMin: string;
  thicknessMax: string;
  shape: string;
  note: string;
}
const newPiece = (): PieceDraft => ({
  code: '',
  area: '',
  areaUnit: 'm2',
  usableArea: '',
  grade: 'A',
  tone: '',
  thicknessMin: '',
  thicknessMax: '',
  shape: 'shoulder',
  note: '',
});
function PieceRows({
  rows,
  onChange,
  title = 'Fiziksel deri parçaları',
}: {
  rows: PieceDraft[];
  onChange: (rows: PieceDraft[]) => void;
  title?: string;
}) {
  const update = (index: number, key: keyof PieceDraft, value: string) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  return (
    <fieldset className="space-y-4">
      <legend className="mb-3">{title}</legend>
      {rows.map((row, index) => (
        <div key={index} className="space-y-3 rounded-xl border border-border p-4">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Field label={`Parça kodu ${index + 1}`} required>
              {(id) => (
                <Input
                  id={id}
                  required
                  value={row.code}
                  onChange={(event) => update(index, 'code', event.target.value)}
                />
              )}
            </Field>
            <Field label={`Alan ölçü birimi ${index + 1}`}>
              {(id) => (
                <Select id={id} value={row.areaUnit} onChange={(event) => update(index, 'areaUnit', event.target.value)}>
                  <option value="m2">m²</option>
                  <option value="dm2">dm²</option>
                  <option value="ft2">ft²</option>
                </Select>
              )}
            </Field>
            {(['area', 'usableArea', 'thicknessMin', 'thicknessMax'] as const).map((key) => (
              <Field
                key={key}
                label={`${{ area: 'Ölçülen alan', usableArea: 'Kullanılabilir alan tahmini', thicknessMin: 'En az kalınlık (mm)', thicknessMax: 'En çok kalınlık (mm)' }[key]} ${index + 1}`}
                required={key === 'area'}
              >
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min="0"
                    step="any"
                    required={key === 'area'}
                    value={row[key]}
                    onChange={(event) => update(index, key, event.target.value)}
                  />
                )}
              </Field>
            ))}
            <Field label={`Kalite sınıfı ${index + 1}`}>
              {(id) => (
                <Select
                  id={id}
                  value={row.grade}
                  onChange={(event) => update(index, 'grade', event.target.value)}
                >
                  {['A', 'B', 'C'].map((grade) => (
                    <option key={grade}>{grade}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={`Ton grubu ${index + 1}`}>
              {(id) => (
                <Input
                  id={id}
                  value={row.tone}
                  onChange={(event) => update(index, 'tone', event.target.value)}
                />
              )}
            </Field>
            <Field label={`Parça biçimi ${index + 1}`}>
              {(id) => (
                <Select
                  id={id}
                  value={row.shape}
                  onChange={(event) => update(index, 'shape', event.target.value)}
                >
                  {[
                    ['hide', 'Deri'],
                    ['side', 'Yarım deri'],
                    ['shoulder', 'Omuz'],
                    ['belly', 'Etek'],
                    ['butt', 'Krupon'],
                    ['remnant', 'Kalan parça'],
                    ['strip', 'Şerit'],
                  ].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Field label={`Kusur / yüzey notu ${index + 1}`}>
            {(id) => (
              <Input
                id={id}
                value={row.note}
                onChange={(event) => update(index, 'note', event.target.value)}
              />
            )}
          </Field>
          <Button size="sm" onClick={() => onChange(rows.filter((_, i) => i !== index))}>
            Parçayı kaldır
          </Button>
        </div>
      ))}
      <Button onClick={() => onChange([...rows, newPiece()])}>Parça ekle</Button>
    </fieldset>
  );
}
function piecePayload(rows: PieceDraft[]) {
  return rows.map((row) => ({
    ...row,
    usableArea: row.usableArea || row.area,
    thicknessMin: row.thicknessMin || '0',
    thicknessMax: row.thicknessMax || '0',
  }));
}

export function LeatherMaterialsPage() {
  const { t } = useTranslation();
  const can = useCan();
  const save = useLeatherActions();
  const company = useCompany();
  const lookups = useStockLookups();
  const orders = useOrders();
  const lots = useCQuery<{ lots: LeatherLot[] }>(
    ['leather', 'lots'],
    '/api/leather/materials/lots',
  );
  const pieces = useCQuery<{ pieces: LeatherPiece[] }>(
    ['leather', 'pieces'],
    '/api/leather/materials/pieces',
  );
  const [incoming, setIncoming] = useState<PieceDraft[]>([newPiece()]);
  const [selected, setSelected] = useState<LeatherPiece | null>(null);
  const [cutting, setCutting] = useState<LeatherPiece | null>(null);
  const [remnants, setRemnants] = useState<PieceDraft[]>([]);
  useFocusedRecord(pieces.data?.pieces, setSelected, 'piece');
  return (
    <>
      <LeatherHeader
        title={t('leather.materials')}
        description="Tabaklanmış deriyi fiziksel parça ve gerçek alanıyla kabul edin; kesimde kullanılan, fire ve kalan alanı birlikte kaydedin."
      />
      {can('leather.materials.manage') && can('leather.costs.manage') && (
        <OperationForm
          title="Tabaklanmış deri kabulü"
          description="Her parçada ölçülen m², dm² veya ft² birimini seçin. Stok alanı m²'ye çevrilir; geçici maliyeti m² başına girin."
          fields={[
            selectField(
              'partyId',
              'Deri tedarikçisi',
              options(
                lookups.parties.filter((row) => row.kind === 'supplier' || row.kind === 'both'),
                (row) => row.name,
              ),
            ),
            selectField(
              'itemId',
              'Deri stok kartı',
              options(
                lookups.items.filter((row) => row.unit === 'm2'),
                (row) => `${row.name} (m²)`,
              ),
            ),
            selectField(
              'warehouseId',
              'Kabul deposu',
              options(lookups.warehouses, (row) => row.name),
            ),
            {
              name: 'date',
              label: 'Kabul tarihi',
              type: 'date',
              value: todayIso(),
              required: true,
            },
            textField('externalNo', 'Tedarikçi irsaliye numarası', true),
            numberField('provisionalUnitCost', 'm² başına geçici maliyet'),
            { ...textField('currency', 'Para birimi', true), value: company.baseCurrency },
            { ...numberField('fxRate', 'Döviz kuru'), required: false },
            selectField(
              'tanning',
              'Tabaklama türü',
              [
                { value: 'vegetable', label: 'Bitkisel / kök tabaklama' },
                { value: 'chrome', label: 'Krom' },
                { value: 'combined', label: 'Kombine' },
                { value: 'other', label: 'Diğer' },
              ],
              true,
              'vegetable',
            ),
            textField('tannery', 'Tabakhane'),
            textField('country', 'Derinin üretim ülkesi'),
            textField('note', 'Kabul notu'),
          ]}
          action="Deri kabulünü kaydet"
          submit={(values) =>
            save('/api/leather/materials/receipts', {
              ...values,
              fxRate: values.fxRate || undefined,
              pieces: piecePayload(incoming),
            })
          }
          onDone={() => setIncoming([newPiece()])}
        >
          <PieceRows rows={incoming} onChange={setIncoming} />
          <Link className="link text-sm" to="/inventory/items">
            Alan birimli deri stok kartı oluştur
          </Link>
        </OperationForm>
      )}
      <h2 className="mb-3 text-subheading">Deri partileri</h2>
      <Records
        rows={lots.data?.lots}
        loading={lots.isPending}
        error={lots.error}
        columns={[
          { label: 'Parti', render: (row) => row.code },
          { label: 'Deri', render: (row) => row.itemName },
          {
            label: 'Tabakhane / ülke',
            render: (row) => `${row.tannery || '—'} · ${row.country || '—'}`,
          },
          { label: 'Toplam alan', render: (row) => money(row.totalArea, 4), numeric: true },
          { label: 'Kalan alan', render: (row) => money(row.remainingArea, 4), numeric: true },
          {
            label: 'Geçici değer',
            render: (row) => costText(row.provisionalValue, company.baseCurrency),
            numeric: true,
          },
        ]}
      />
      <h2 className="mb-3 mt-6 text-subheading">Fiziksel parça ve kalanlar</h2>
      <Records
        rows={pieces.data?.pieces}
        loading={pieces.isPending}
        error={pieces.error}
        columns={[
          {
            label: 'Parça kodu',
            render: (row) => (
              <>
                {row.code}
                {row.parentId && <p className="text-xs text-muted">Kesimden kalan parça</p>}
              </>
            ),
          },
          { label: 'Kalan alan', render: (row) => money(row.remainingArea, 4), numeric: true },
          { label: 'Kalite / ton', render: (row) => `${row.grade} · ${row.tone || '—'}` },
          { label: 'Kalınlık (mm)', render: (row) => `${row.thicknessMin}–${row.thicknessMax}` },
          { label: 'Durum', render: (row) => <Status value={row.status} /> },
        ]}
        action={(row) => (
          <div className="flex gap-2">
            {row.status === 'quarantine' && can('leather.quality.approve') && (
              <Button size="sm" onClick={() => setSelected(row)}>
                Kabul kararı
              </Button>
            )}
            {['available', 'accepted', 'second'].includes(row.status) &&
              can('leather.production.manage') &&
              new Decimal(row.remainingArea).gt(0) && (
                <Button
                  size="sm"
                  onClick={() => {
                    setCutting(row);
                    setRemnants([]);
                  }}
                >
                  Kesim kaydı
                </Button>
              )}
          </div>
        )}
      />
      {selected && (
        <Card className="mt-5">
          <CardHeader title={`${selected.code} parça ayrıntısı`} />
          <div className="space-y-3 p-5">
            <p className="text-sm">
              Alan {selected.remainingArea} m² · kalite {selected.grade} · ton{' '}
              {selected.tone || '—'} · kalınlık {selected.thicknessMin}–{selected.thicknessMax} mm
            </p>
            <Status value={selected.status} />
            {selected.status === 'quarantine' && can('leather.quality.approve') && (
              <OperationForm
                key={selected.id}
                title={`${selected.code} kabul kararı`}
                fields={[
                  selectField('decision', 'Kabul kararı', [
                    { value: 'accept', label: 'Üretime kabul et' },
                    { value: 'second', label: 'İkinci kalite kabul et' },
                    { value: 'reject', label: 'Reddet' },
                  ]),
                  textField('note', 'Karar gerekçesi'),
                ]}
                submit={(values) =>
                  save(`/api/leather/materials/pieces/${selected.id}/accept`, values)
                }
                onDone={() => setSelected(null)}
              />
            )}
          </div>
        </Card>
      )}
      {cutting && (
        <div className="mt-5">
          <OperationForm
            key={cutting.id}
            title={`${cutting.code} kesim kaydı`}
            description={`Başlangıç alanı ${cutting.remainingArea}. Kullanılan + fire + kalan parçalar toplamı bu alana eşit olmalıdır.`}
            fields={[
              selectField(
                'orderId',
                'Kesimin üretim emri',
                options(
                  orders.data?.orders.filter(
                    (row) => row.status === 'released' || row.status === 'in_progress',
                  ),
                  orderName,
                ),
              ),
              numberField('usedArea', 'Ürün parçalarına kullanılan alan'),
              numberField('wasteArea', 'Kesim firesi alanı', '0'),
              numberField('setsProduced', 'Çıkan parça seti', '0'),
              ...datedFields(),
            ]}
            action="Kesimi kaydet"
            submit={(values) =>
              save('/api/leather/materials/cuts', {
                ...dated(values),
                pieceId: cutting.id,
                orderId: values.orderId,
                usedArea: values.usedArea,
                wasteArea: values.wasteArea,
                setsProduced: Number(values.setsProduced),
                remnants: piecePayload(remnants),
              })
            }
            onDone={() => {
              setCutting(null);
              setRemnants([]);
            }}
          >
            <PieceRows
              rows={remnants}
              onChange={setRemnants}
              title="Yeniden kullanılabilir kalan parçalar"
            />
          </OperationForm>
        </div>
      )}
    </>
  );
}

interface ReservationDraft {
  itemId: string;
  quantity: string;
  pieceId: string;
}
function ReservationRows({
  rows,
  onChange,
  items,
  pieces,
  title = 'Malzeme ve parça rezervasyonu',
  materialLabel = 'Rezerve malzeme',
  quantityLabel = 'Rezervasyon miktarı',
}: {
  rows: ReservationDraft[];
  onChange: (rows: ReservationDraft[]) => void;
  items: LookupItem[];
  pieces: LeatherPiece[];
  title?: string;
  materialLabel?: string;
  quantityLabel?: string;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-3">{title}</legend>
      {rows.map((row, index) => (
        <div
          key={index}
          className="grid items-end gap-3 border-b border-border pb-3 sm:grid-cols-4"
        >
          <Field label={`${materialLabel} ${index + 1}`} required>
            {(id) => (
              <Select
                id={id}
                required
                value={row.itemId}
                onChange={(event) =>
                  onChange(
                    rows.map((line, i) =>
                      i === index ? { ...line, itemId: event.target.value, pieceId: '' } : line,
                    ),
                  )
                }
              >
                <option value="">Stok kartı seçiniz</option>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.unit})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={`${quantityLabel} ${index + 1}`} required>
            {(id) => (
              <Input
                id={id}
                required
                type="number"
                step="any"
                min="0.0001"
                value={row.quantity}
                onChange={(event) =>
                  onChange(
                    rows.map((line, i) =>
                      i === index ? { ...line, quantity: event.target.value } : line,
                    ),
                  )
                }
              />
            )}
          </Field>
          <Field label={`Deri parçası ${index + 1}`}>
            {(id) => (
              <Select
                id={id}
                value={row.pieceId}
                onChange={(event) =>
                  onChange(
                    rows.map((line, i) =>
                      i === index ? { ...line, pieceId: event.target.value } : line,
                    ),
                  )
                }
              >
                <option value="">Fiziksel parça seçilmedi</option>
                {pieces
                  .filter(
                    (piece) =>
                      piece.itemId === row.itemId &&
                      ['available', 'accepted', 'second'].includes(piece.status),
                  )
                  .map((piece) => (
                    <option key={piece.id} value={piece.id}>
                      {piece.code} · {piece.remainingArea} m² · {piece.tone}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Button onClick={() => onChange(rows.filter((_, i) => i !== index))}>
            Malzeme satırını kaldır
          </Button>
        </div>
      ))}
      <Button onClick={() => onChange([...rows, { itemId: '', quantity: '', pieceId: '' }])}>
        Malzeme satırı ekle
      </Button>
    </fieldset>
  );
}

export function LeatherProductionPage() {
  const generic=useGenericProduction();
  const { t } = useTranslation();
  const can = useCan();
  const company = useCompany();
  const save = useLeatherActions();
  const { variants } = useCatalog();
  const lookups = useStockLookups();
  const orders = useOrders();
  const pieces = useCQuery<{ pieces: LeatherPiece[] }>(
    ['leather', 'pieces'],
    '/api/leather/materials/pieces',
    { enabled: can('leather.materials.read') },
  );
  const customs = useCQuery<{ customOrders: LeatherCustomOrder[] }>(
    ['leather', 'custom-orders'],
    '/api/leather/custom-orders',
    { enabled: can('leather.catalog.read') },
  );
  const [variantId, setVariantId] = useState('');
  const variant = variants.data?.variants.find((row) => row.id === variantId);
  const [reservations, setReservations] = useState<ReservationDraft[]>([]);
  const [selected, setSelected] = useState('');
  useFocusedRecord(orders.data?.orders, (row) => setSelected(row.id));
  return (
    <>
      <LeatherHeader
        title={t('leather.production')}
        description="Reçete revizyonuyla üretimi planlayın, malzemeyi rezerve edin ve gerçekleşen üretim maliyetini izleyin."
      />
      {can('leather.production.manage') && (
        <>
          <div className="mb-4 max-w-lg">
            <Field label="Üretilecek ürün varyantı">
              {(id) => (
                <Select
                  id={id}
                  value={variantId}
                  onChange={(event) => {
                    setVariantId(event.target.value);
                    setReservations([]);
                  }}
                >
                  <option value="">Ürün seçiniz</option>
                  {variants.data?.variants.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.itemCode} · {row.itemName} · {row.color} · R{row.revision}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {variant && (
            <OperationForm
              key={variant.id}
              title="Yeni üretim emri"
              description={`${variant.itemName} · üretim reçetesi R${variant.revision}`}
              fields={[
                numberField('quantity', 'Planlanan mamul adedi', '1', 1),
                selectField(
                  'warehouseId',
                  'Malzeme deposu',
                  options(lookups.warehouses, (row) => row.name),
                ),
                selectField(
                  'outputWarehouseId',
                  'Mamul deposu',
                  options(lookups.warehouses, (row) => row.name),
                ),
                { name: 'dueDate', label: 'Üretim termin tarihi', type: 'date' },
                selectField(
                  'customOrderId',
                  'Bağlı özel sipariş',
                  options(
                    customs.data?.customOrders.filter(
                      (row) => row.variantId === variant.id && row.status === 'confirmed',
                    ),
                    (row) => `${row.partyName} · ${row.quantity} adet · ${row.monogram}`,
                  ),
                  false,
                ),
                textField('note', 'Planlama notu'),
                selectField(
                  'assignedUserId',
                  'Üretim sorumlusu',
                  options(lookups.members, (member) => member.name),
                  false,
                ),
              ]}
              action="Üretimi planla"
              submit={(values) =>
                save('/api/leather/production/orders', {
                  ...values,
                  variantId: variant.id,
                  revisionId: variant.revisionId,
                  dueDate: values.dueDate || undefined,
                  customOrderId: optional(values.customOrderId),
                  assignedUserId: values.assignedUserId || undefined,
                  reservations: reservations.map((row) => ({
                    ...row,
                    pieceId: optional(row.pieceId),
                  })),
                })
              }
              onDone={() => setReservations([])}
            >
              <ReservationRows
                rows={reservations}
                onChange={setReservations}
                items={lookups.items}
                pieces={pieces.data?.pieces ?? []}
              />
            </OperationForm>
          )}
        </>
      )}
      <Records
        rows={orders.data?.orders}
        loading={orders.isPending}
        error={orders.error}
        columns={[
          { label: 'Üretim emri', render: (row) => row.code },
          { label: 'Mamul', render: (row) => row.itemName },
          { label: 'Reçete', render: (row) => `R${row.revision}` },
          {
            label: 'Plan / kabul',
            render: (row) => `${row.quantity} / ${row.completedQty}`,
            numeric: true,
          },
          { label: 'Termin', render: (row) => row.dueDate ?? '—' },
          {
            label: 'Üretimdeki değer',
            render: (row) =>
              can('leather.costs.read') ? costText(row.wipValue, company.baseCurrency) : '—',
            numeric: true,
          },
          { label: 'Durum', render: (row) => <Status value={row.status} /> },
        ]}
        action={(row) => (
          <Button size="sm" onClick={() => setSelected(row.id)}>
            Üretimi yönet
          </Button>
        )}
      />
      {selected && (
        <div className="mt-6">
          <ProductionDetail key={selected} orderId={selected} />
        </div>
      )}
      {can('leather.costs.read') && <CostPanel />}
      {generic&&<PieceRatePanel/>}
    </>
  );
}

function ProductionDetail({ orderId }: { orderId: string }) {
  const generic=useGenericProduction();
  const can = useCan();
  const save = useLeatherActions();
  const company = useCompany();
  const lookups = useStockLookups();
  const data = useCQuery<{ order: LeatherProductionOrder; documents: LeatherDocument[] }>(
    ['leather', 'order', orderId],
    `/api/leather/production/orders/${orderId}`,
  );
  const pieces = useCQuery<{ pieces: LeatherPiece[] }>(
    ['leather', 'pieces'],
    '/api/leather/materials/pieces',
    { enabled: can('leather.materials.read') },
  );
  const checks = useCQuery<{ checks: LeatherQualityCheck[] }>(
    ['leather', 'checks'],
    '/api/leather/quality/checks',
    { enabled: can('leather.quality.read') },
  );
  const [issueItemId, setIssueItemId] = useState('');
  const order = data.data?.order;
  if (data.error) return <Callout tone="danger">{data.error.message}</Callout>;
  if (!order) return null;
  const inProgress = ['released', 'in_progress'].includes(order.status);
  const acceptedChecks = checks.data?.checks.filter(
    (row) =>
      row.scope === 'production' &&
      row.sourceId === order.id &&
      row.stage === 'final' &&
      row.status === 'approved',
  );
  return (
    <>
      <Card className="mb-5">
        <CardHeader
          title={`${order.code} · ${order.itemName}`}
          description={`Plan ${order.quantity} adet · kabul ${order.completedQty} adet · R${order.revision}`}
        />
        <div className="grid gap-4 p-5 sm:grid-cols-3">
          <Stat label="Kalan mamul">
            {new Decimal(order.quantity).sub(order.completedQty).toString()}
          </Stat>
          <Stat label="Üretimdeki değer">
            {can('leather.costs.read') ? costText(order.wipValue, company.baseCurrency) : '—'}
          </Stat>
          <div>
            <p className="mb-2 text-sm text-muted">Durum</p>
            <Status value={order.status} />
          </div>
        </div>
      </Card>
      {order.status === 'planned' && can('leather.production.approve') && (
        <OperationForm
          title="Üretime başlat"
          fields={datedFields()}
          action="Üretime başlat"
          submit={(values) =>
            save(`/api/leather/production/orders/${orderId}/release`, dated(values))
          }
        />
      )}
      {generic&&<><CustomValuesPanel entity="production" id={orderId}/><TransfersPanel orderId={orderId} operations={order.operations}/></>}
      <h3 className="mb-3">Malzeme rezervasyonları</h3>
      <Records
        rows={order.reservations}
        columns={[
          { label: 'Malzeme', render: (row) => row.itemName },
          { label: 'Rezerve', render: (row) => row.quantity, numeric: true },
          { label: 'Tüketilen', render: (row) => row.consumedQty, numeric: true },
          {
            label: 'Parça',
            render: (row) =>
              pieces.data?.pieces.find((piece) => piece.id === row.pieceId)?.code ?? '—',
          },
          { label: 'Durum', render: (row) => <Status value={row.status} /> },
        ]}
      />
      <h3 className="mb-3 mt-5">Operasyon gerçekleşmeleri</h3>
      <Records
        rows={order.operations.map((row) => ({ ...row, id: row.key }))}
        columns={[
          { label: 'Operasyon', render: (row) => row.name },
          { label: 'İstasyon', render: (row) => row.station || '—' },
          {
            label: 'Plan / gerçek süre',
            render: (row) => `${row.plannedMinutes} / ${row.actualMinutes ?? '0'} dk`,
          },
          { label: 'Üretilen', render: (row) => row.completedQty ?? '0' },
          { label: 'Durum', render: (row) => <Status value={row.status ?? 'pending'} /> },
        ]}
      />
      {inProgress && can('leather.production.manage') && (
        <div className="mt-5">
          <OperationForm
            title="Operasyon kaydı"
            fields={[
              selectField('resourceId','Çalışılan kaynak',options(lookups.resources,r=>r.name),false),
              selectField(
                'key',
                'Operasyon',
                order.operations.map((row) => ({ value: row.key, label: row.name })),
              ),
              selectField('status', 'Operasyon sonucu', [
                { value: 'started', label: 'Başladı' },
                { value: 'completed', label: 'Tamamlandı' },
                { value: 'rework', label: 'Yeniden işlem' },
              ]),
              numberField('quantity', 'İşlenen adet', '0'),
              numberField('minutes', 'Gerçekleşen süre (dk)', '0'),
              numberField('goodQty', 'Operasyonda uygun adet', '0'),
              numberField('reworkQty', 'Operasyonda yeniden işlem adedi', '0'),
              numberField('scrapQty', 'Operasyonda hurda adedi', '0'),
              ...datedFields(),
            ]}
            submit={(values) =>
              save(`/api/leather/production/orders/${orderId}/operations`, {
                ...dated(values),
                key: values.key,
                status: values.status,
                quantity: values.quantity,
                minutes: values.minutes,
                goodQty: values.goodQty,
                reworkQty: values.reworkQty,
                scrapQty: values.scrapQty,
                resourceId:values.resourceId||undefined,
              })
            }
          />
          <div className="mb-4 max-w-lg">
            <Field label="Üretime verilecek malzeme">
              {(id) => (
                <Select
                  id={id}
                  value={issueItemId}
                  onChange={(event) => setIssueItemId(event.target.value)}
                >
                  <option value="">Malzeme seçiniz</option>
                  {lookups.items.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name} ({row.unit})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {issueItemId && (
            <OperationForm
              key={issueItemId}
              title="Malzeme tüketimi"
              description="Deri için seçilen fiziksel parçadan tüketilir; kesim kaydı aynı alanın ikinci kez tüketimi olarak girilmemelidir."
              fields={[
                numberField('quantity', 'Tüketim miktarı'),
                selectField('lotId','Sarf partisi',options(lookups.lots.filter(l=>l.itemId===issueItemId&&l.warehouseId===order.warehouseId),l=>`${l.code} · ${l.quantity}`),false),
                selectField(
                  'pieceId',
                  'Tüketilen deri parçası',
                  options(
                    pieces.data?.pieces.filter(
                      (piece) =>
                        piece.itemId === issueItemId &&
                        piece.warehouseId === order.warehouseId &&
                        new Decimal(piece.remainingArea).gt(0),
                    ),
                    (row) => `${row.code} · ${row.remainingArea} m²`,
                  ),
                  false,
                ),
                ...datedFields(),
              ]}
              action="Tüketimi kaydet"
              submit={(values) =>
                save(`/api/leather/production/orders/${orderId}/issues`, {
                  ...dated(values),
                  lines: [
                    {
                      itemId: issueItemId,
                      quantity: values.quantity,
                      lotAllocations:values.lotId?[{lotId:values.lotId,quantity:values.quantity}]:undefined,
                      pieces: values.pieceId
                        ? [{ pieceId: values.pieceId, quantity: values.quantity }]
                        : [],
                    },
                  ],
                })
              }
            />
          )}
          <OperationForm
            title="Kullanılmayan malzemeyi iade et"
            fields={[
              selectField(
                'issueId',
                'İlk tüketim belgesi',
                options(
                  data.data?.documents.filter((row) => row.kind === 'issue'),
                  (row) =>
                    `${row.date} · ${row.quantity} · ${moneyIn(row.value, company.baseCurrency)}`,
                ),
              ),
              numberField('quantity', 'İade miktarı'),
              selectField(
                'pieceId',
                'Deri parçası',
                options(pieces.data?.pieces, (row) => row.code),
                false,
              ),
              ...datedFields(),
            ]}
            submit={(values) =>
              save(`/api/leather/production/orders/${orderId}/returns`, {
                ...dated(values),
                issueId: values.issueId,
                lines: [
                  {
                    lineNo: 1,
                    quantity: values.quantity,
                    pieces: values.pieceId
                      ? [{ pieceId: values.pieceId, quantity: values.quantity }]
                      : [],
                  },
                ],
              })
            }
          />
          {can('leather.production.approve') && (
            <OperationForm
              title="Mamul kabulü"
              description="Son kalite kontrolü onaylanmış olmalıdır. Son kabulde kalan üretim değeri mamullere dağıtılır."
              fields={[
                numberField('quantity', 'Kabul edilen mamul adedi', '1', 1),
                selectField(
                  'qualityCheckId',
                  'Onaylı son kalite kontrolü',
                  options(
                    acceptedChecks,
                    (row) =>
                      `${row.passedQty} uygun · ${new Date(row.createdAt).toLocaleDateString('tr-TR')}`,
                  ),
                ),
                selectField(
                  'final',
                  'Üretim kapatma',
                  [
                    { value: 'false', label: 'Kısmi mamul kabulü' },
                    { value: 'true', label: 'Son kabul ve üretimi kapat' },
                  ],
                  true,
                  'false',
                ),
                {
                  name: 'serials',
                  label: 'Mamul seri numaraları',
                  type: 'textarea',
                  hint: 'Seri izlenen mamullerde her satıra bir seri numarası girin.',
                },
                ...datedFields(),
              ]}
              action="Mamulü stoğa kabul et"
              submit={(values) =>
                save(`/api/leather/production/orders/${orderId}/completions`, {
                  ...dated(values),
                  quantity: values.quantity,
                  qualityCheckId: values.qualityCheckId,
                  final: values.final === 'true',
                  serials:
                    values.serials
                      ?.split(/[\n,]+/)
                      .map((value) => value.trim())
                      .filter(Boolean) ?? [],
                })
              }
            >
              <Link className="link text-sm" to="/leather/quality">
                Son kalite kontrolü oluştur
              </Link>
            </OperationForm>
          )}
        </div>
      )}
      <h3 className="mb-3 mt-5">Üretim belgeleri ve maliyet izi</h3>
      <Records
        rows={data.data?.documents}
        columns={[
          {
            label: 'Belge',
            render: (row) =>
              ({
                issue: 'Tüketim',
                return: 'Malzeme iadesi',
                completion: 'Mamul kabulü',
                cut: 'Kesim',
              })[row.kind] ?? row.kind,
          },
          { label: 'Tarih', render: (row) => row.date },
          { label: 'Miktar', render: (row) => row.quantity, numeric: true },
          {
            label: 'Değer',
            render: (row) =>
              can('leather.costs.read') ? costText(row.value, company.baseCurrency) : '—',
            numeric: true,
          },
        ]}
      />
    </>
  );
}

function CostPanel() {
  const can = useCan();
  const company = useCompany();
  const lookups = useStockLookups();
  const orders = useOrders();
  const save = useLeatherActions();
  const lots = useCQuery<{ lots: LeatherLot[] }>(
    ['leather', 'lots'],
    '/api/leather/materials/lots',
    { enabled: can('leather.materials.read') },
  );
  const data = useCQuery<{ allocations: LeatherCostAllocation[] }>(
    ['leather', 'costs'],
    '/api/leather/costs/allocations',
  );
  const [target, setTarget] = useState('production');
  return (
    <section className="mt-6">
      <h2 className="mb-4 text-subheading">Kaynak belgeli maliyet dağıtımı</h2>
      {can('leather.costs.manage') && (
        <>
          <div className="mb-4 max-w-sm">
            <Field label="Maliyet hedefi">
              {(id) => (
                <Select id={id} value={target} onChange={(event) => setTarget(event.target.value)}>
                  <option value="production">Üretim emri</option>
                  <option value="receipt">Deri kabulü</option>
                </Select>
              )}
            </Field>
          </div>
          <OperationForm
            key={target}
            title="Maliyet payı ekle"
            description="Kayıtlı yevmiye kaynağındaki henüz dağıtılmamış tutardan pay ayrılır."
            fields={[
              target === 'production'
                ? selectField(
                    'orderId',
                    'Maliyet üretim emri',
                    options(orders.data?.orders, orderName),
                  )
                : selectField(
                    'receiptLineId',
                    'Maliyet deri kabulü',
                    (lots.data?.lots ?? []).map((row) => ({
                      value: row.deliveryLineId,
                      label: `${row.code} · ${row.itemName}`,
                    })),
                  ),
              selectField(
                'sourceJournalLineId',
                'Giderin kaynak belgesi',
                lookups.costLines.map((row) => ({
                  value: row.id,
                  label: `${row.entryDate} · ${row.accountCode} · ${row.description || 'Gider'} · kalan ${moneyIn(row.remaining, company.baseCurrency)}`,
                })),
              ),
              selectField('kind', 'Maliyet türü', [
                { value: 'labor', label: 'İşçilik' },
                { value: 'subcontract', label: 'Fason' },
                { value: 'overhead', label: 'Üretim gideri' },
                { value: 'freight', label: 'Nakliye' },
                { value: 'acquisition', label: 'Edinim gideri' },
              ]),
              numberField('amount', 'Dağıtılan tutar'),
              ...datedFields(),
            ]}
            submit={(values) =>
              save('/api/leather/costs/allocations', {
                ...dated(values),
                ...(target === 'production'
                  ? { orderId: values.orderId }
                  : { receiptLineId: values.receiptLineId }),
                sourceJournalLineId: values.sourceJournalLineId,
                kind: values.kind,
                amount: values.amount,
              })
            }
          />
        </>
      )}
      <Records
        rows={data.data?.allocations}
        loading={data.isPending}
        error={data.error}
        columns={[
          { label: 'Tarih', render: (row) => row.date },
          {
            label: 'Maliyet türü',
            render: (row) =>
              ({
                labor: 'İşçilik',
                subcontract: 'Fason',
                overhead: 'Üretim gideri',
                freight: 'Nakliye',
                acquisition: 'Edinim',
              })[row.kind] ?? row.kind,
          },
          {
            label: 'Tutar',
            render: (row) => moneyIn(row.amount, company.baseCurrency),
            numeric: true,
          },
          {
            label: 'Dağıtım izi',
            render: (row) =>
              row.destinations
                .map(
                  (destination) =>
                    `${destination.target}: ${moneyIn(destination.amount, company.baseCurrency)}`,
                )
                .join(' · '),
          },
        ]}
      />
    </section>
  );
}

export function LeatherQualityPage() {
  const { t } = useTranslation();
  const can = useCan();
  const save = useLeatherActions();
  const orders = useOrders();
  const pieces = useCQuery<{ pieces: LeatherPiece[] }>(
    ['leather', 'pieces'],
    '/api/leather/materials/pieces',
    { enabled: can('leather.materials.read') },
  );
  const services = useCQuery<{ cases: LeatherServiceCase[] }>(
    ['leather', 'service'],
    '/api/leather/service/cases',
    { enabled: can('leather.service.read') },
  );
  const data = useCQuery<{ checks: LeatherQualityCheck[] }>(
    ['leather', 'checks'],
    '/api/leather/quality/checks',
  );
  const [scope, setScope] = useState('production');
  const [selected, setSelected] = useState<LeatherQualityCheck | null>(null);
  const [criteria, setCriteria] = useState([
    { label: 'Ölçü ve teknik şartname', passed: true, note: '' },
    { label: 'Görünüş ve ton uyumu', passed: true, note: '' },
    { label: 'Dikiş / kenar / montaj', passed: true, note: '' },
    { label: 'İşlev kontrolü', passed: true, note: '' },
  ]);
  const sources =
    scope === 'production'
      ? options(orders.data?.orders, orderName)
      : scope === 'material'
        ? options(pieces.data?.pieces, (row) => row.code)
        : options(services.data?.cases, (row) => `${row.partyName} · ${row.itemName}`);
  return (
    <>
      <LeatherHeader
        title={t('leather.quality')}
        description="Kontrol edilen miktarı uygun, yeniden işlem, ikinci kalite ve hurda olarak ayırın; üretim kabulünden önce son kaliteyi onaylayın."
      />
      {can('leather.quality.manage') && (
        <>
          <div className="mb-4 max-w-md">
            <Field label="Kalite kontrolü kapsamı">
              {(id) => (
                <Select id={id} value={scope} onChange={(event) => setScope(event.target.value)}>
                  <option value="production">Üretim</option>
                  <option value="material">Deri kabulü</option>
                  <option value="service">Servis</option>
                </Select>
              )}
            </Field>
          </div>
          <OperationForm
            key={scope}
            title="Yeni kalite kontrolü"
            fields={[
              selectField('sourceId', 'Kontrol edilen kayıt', sources),
              selectField(
                'stage',
                'Kontrol aşaması',
                [
                  { value: 'incoming', label: 'Giriş kontrolü' },
                  { value: 'cutting', label: 'Kesim kontrolü' },
                  { value: 'intermediate', label: 'Ara kontrol' },
                  { value: 'final', label: 'Son kontrol' },
                ],
                true,
                scope === 'material' ? 'incoming' : 'final',
              ),
              numberField('inspectedQty', 'İncelenen miktar', '1'),
              numberField('passedQty', 'Uygun miktar', '1'),
              numberField('reworkQty', 'Yeniden işlem miktarı', '0'),
              numberField('secondQty', 'İkinci kalite miktarı', '0'),
              numberField('scrapQty', 'Hurda miktarı', '0'),
              textField('note', 'Kalite notu'),
            ]}
            action="Kalite kontrolünü kaydet"
            submit={(values) =>
              save('/api/leather/quality/checks', { ...values, scope, checks: criteria })
            }
          >
            <fieldset className="space-y-3">
              <legend className="mb-3">Kontrol maddeleri</legend>
              {criteria.map((row, index) => (
                <div
                  key={index}
                  className="grid items-center gap-3 border-b border-border pb-3 sm:grid-cols-3"
                >
                  <Field label={`Kontrol maddesi ${index + 1}`} required>
                    {(id) => (
                      <Input
                        id={id}
                        required
                        value={row.label}
                        onChange={(event) =>
                          setCriteria((old) =>
                            old.map((item, i) =>
                              i === index ? { ...item, label: event.target.value } : item,
                            ),
                          )
                        }
                      />
                    )}
                  </Field>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={row.passed}
                      onChange={(event) =>
                        setCriteria((old) =>
                          old.map((item, i) =>
                            i === index ? { ...item, passed: event.target.checked } : item,
                          ),
                        )
                      }
                    />
                    Uygun
                  </label>
                  <Field label={`Kontrol açıklaması ${index + 1}`}>
                    {(id) => (
                      <Input
                        id={id}
                        value={row.note}
                        onChange={(event) =>
                          setCriteria((old) =>
                            old.map((item, i) =>
                              i === index ? { ...item, note: event.target.value } : item,
                            ),
                          )
                        }
                      />
                    )}
                  </Field>
                </div>
              ))}
              <Button
                onClick={() =>
                  setCriteria((old) => [...old, { label: '', passed: true, note: '' }])
                }
              >
                Kontrol maddesi ekle
              </Button>
            </fieldset>
          </OperationForm>
        </>
      )}
      <Records
        rows={data.data?.checks}
        loading={data.isPending}
        error={data.error}
        columns={[
          {
            label: 'Kapsam',
            render: (row) =>
              ({ production: 'Üretim', material: 'Deri kabulü', service: 'Servis' })[row.scope],
          },
          {
            label: 'Kaynak',
            render: (row) =>
              row.scope === 'production'
                ? (orders.data?.orders.find((order) => order.id === row.sourceId)?.code ?? 'Üretim')
                : row.scope === 'material'
                  ? (pieces.data?.pieces.find((piece) => piece.id === row.sourceId)?.code ?? 'Deri')
                  : 'Servis',
          },
          {
            label: 'Aşama',
            render: (row) =>
              ({ incoming: 'Giriş', cutting: 'Kesim', intermediate: 'Ara', final: 'Son' })[
                row.stage
              ],
          },
          { label: 'Uygun / incelenen', render: (row) => `${row.passedQty} / ${row.inspectedQty}` },
          {
            label: 'Yeniden / ikinci / hurda',
            render: (row) => `${row.reworkQty} / ${row.secondQty} / ${row.scrapQty}`,
          },
          { label: 'Durum', render: (row) => <Status value={row.status} /> },
        ]}
        action={(row) => (
          <Button size="sm" onClick={() => setSelected(row)}>
            İncele
          </Button>
        )}
      />
      {selected && (
        <Card className="mt-5">
          <CardHeader title="Kalite kontrolü ayrıntısı" />
          <div className="space-y-3 p-5">
            {selected.checks.map((row, index) => (
              <p key={index} className="text-sm">
                <Status value={row.passed ? 'pass' : 'fail'} />{' '}
                <span className="ml-2">
                  {row.label} · {row.note}
                </span>
              </p>
            ))}
            <p className="text-sm text-muted">{selected.note}</p>
            {can('leather.quality.approve') && ['draft', 'pending'].includes(selected.status) && (
              <OperationForm
                title="Kalite kararı"
                fields={[
                  selectField('decision', 'Kalite kararı', [
                    { value: 'approve', label: 'Kontrolü onayla' },
                    { value: 'reject', label: 'Kontrolü reddet' },
                  ]),
                  textField('note', 'Onay / ret notu'),
                ]}
                submit={(values) =>
                  save(`/api/leather/quality/checks/${selected.id}/decision`, values)
                }
                onDone={() => setSelected(null)}
              />
            )}
          </div>
        </Card>
      )}
    </>
  );
}

export function LeatherSubcontractsPage() {
  const can = useCan();
  const save = useLeatherActions();
  const lookups = useStockLookups();
  const orders = useOrders();
  const company = useCompany();
  const data = useCQuery<{ jobs: LeatherSubcontractJob[] }>(
    ['leather', 'subcontracts'],
    '/api/leather/subcontracting/jobs',
  );
  const [orderId, setOrderId] = useState('');
  const order = orders.data?.orders.find((row) => row.id === orderId);
  const [selected, setSelected] = useState<LeatherSubcontractJob | null>(null);
  const [materials, setMaterials] = useState<ReservationDraft[]>([]);
  const pieces = useCQuery<{ pieces: LeatherPiece[] }>(
    ['leather', 'pieces'],
    '/api/leather/materials/pieces',
    { enabled: can('leather.materials.read') },
  );
  useFocusedRecord(data.data?.jobs, setSelected);
  return (
    <>
      <LeatherHeader
        title="Fason üretim işleri"
        description="Üretim emrine bağlı dış operasyonların gönderimini, geri teslimini ve kaynak belgeli maliyetini izleyin."
      />
      {can('leather.subcontracting.manage') && (
        <>
          <div className="mb-4 max-w-lg">
            <Field label="Fason üretim emri">
              {(id) => (
                <Select
                  id={id}
                  value={orderId}
                  onChange={(event) => setOrderId(event.target.value)}
                >
                  <option value="">Üretim seçiniz</option>
                  {orders.data?.orders.map((row) => (
                    <option key={row.id} value={row.id}>
                      {orderName(row)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {order && (
            <OperationForm
              key={order.id}
              title="Yeni fason işi"
              fields={[
                selectField(
                  'partyId',
                  'Fason üretici',
                  options(
                    lookups.parties.filter((row) => row.kind !== 'customer'),
                    (row) => row.name,
                  ),
                ),
                selectField(
                  'operationKey',
                  'Fason operasyon',
                  order.operations
                    .filter((row) => row.outsourced)
                    .map((row) => ({ value: row.key, label: row.name })),
                ),
                numberField('quantity', 'Fason miktarı', order.quantity),
                selectField(
                  'externalWarehouseId',
                  'Fason emanet deposu',
                  options(
                    lookups.warehouses.filter((warehouse) => warehouse.id !== order.warehouseId),
                    (warehouse) => warehouse.name,
                  ),
                ),
                { name: 'dueDate', label: 'Fason termin tarihi', type: 'date' },
                textField('note', 'Fason notu'),
              ]}
              submit={(values) =>
                save('/api/leather/subcontracting/jobs', {
                  ...values,
                  orderId,
                  dueDate: values.dueDate || undefined,
                })
              }
            />
          )}
        </>
      )}
      <Records
        rows={data.data?.jobs}
        loading={data.isPending}
        error={data.error}
        columns={[
          {
            label: 'Üretim emri',
            render: (row) =>
              orders.data?.orders.find((order) => order.id === row.orderId)?.code ?? '—',
          },
          { label: 'Fason üretici', render: (row) => row.partyName },
          {
            label: 'Operasyon',
            render: (row) => operationNames[row.operationKey] ?? row.operationKey,
          },
          { label: 'Gönderilen / gelen', render: (row) => `${row.quantity} / ${row.returnedQty}` },
          { label: 'Termin', render: (row) => row.dueDate ?? '—' },
          { label: 'Durum', render: (row) => <Status value={row.status} /> },
        ]}
        action={(row) =>
          can('leather.subcontracting.manage') &&
          row.status !== 'cancelled' &&
          row.status !== 'completed' ? (
            <Button size="sm" onClick={() => setSelected(row)}>
              Fason işlemi
            </Button>
          ) : null
        }
      />
      {selected && (
        <div className="mt-5">
          <OperationForm
            key={selected.id}
            title={`${selected.partyName} fason işlemi`}
            fields={[
              selectField('action', 'Fason işlemi', [
                { value: 'dispatch', label: 'Malzemeyi / işi gönder' },
                { value: 'return', label: 'İşlenmiş ürünü geri al' },
                { value: 'consume', label: 'Fasondaki malzemeyi üretime sarf et' },
                { value: 'waste', label: 'Fasondaki malzeme firesini kaydet' },
                { value: 'cancel', label: 'İşi iptal et' },
              ]),
              numberField(
                'quantity',
                'Teslim miktarı',
                new Decimal(selected.quantity).sub(selected.returnedQty).toString(),
              ),
              selectField(
                'sourceJournalLineId',
                'Fason gideri kaynak belgesi',
                lookups.costLines.map((row) => ({
                  value: row.id,
                  label: `${row.entryDate} · ${row.description} · ${moneyIn(row.remaining, company.baseCurrency)}`,
                })),
                false,
              ),
              { ...numberField('cost', 'Fason maliyet payı'), required: false },
              ...datedFields(),
            ]}
            submit={(values) =>
              save(`/api/leather/subcontracting/jobs/${selected.id}/actions`, {
                ...dated(values),
                action: values.action,
                quantity: values.quantity || undefined,
                sourceJournalLineId: values.sourceJournalLineId || undefined,
                cost: values.cost || undefined,
                materials:
                  materials.length &&
                  ['dispatch', 'return', 'consume', 'waste'].includes(values.action!)
                    ? materials.map((line) => ({
                        itemId: line.itemId,
                        quantity: line.quantity,
                        pieces: line.pieceId
                          ? [{ pieceId: line.pieceId, quantity: line.quantity }]
                          : [],
                      }))
                    : undefined,
              })
            }
            onDone={() => {
              setSelected(null);
              setMaterials([]);
            }}
          >
            <ReservationRows
              title="Fason malzeme hareketi"
              materialLabel="Fason malzeme"
              quantityLabel="Fason malzeme miktarı"
              rows={materials}
              onChange={setMaterials}
              items={lookups.items}
              pieces={pieces.data?.pieces ?? []}
            />
            <p className="text-sm text-muted">
              Gönderimde malzeme satırları gerekir. Deri parçası fiziksel olarak emanet deposuna
              taşınır; sarf, fire ve geri teslim ayrı kaydedilir.
            </p>
          </OperationForm>
        </div>
      )}
    </>
  );
}

export function LeatherCustomOrdersPage() {
  const { t } = useTranslation();
  const can = useCan();
  const save = useLeatherActions();
  const lookups = useStockLookups();
  const { variants } = useCatalog();
  const company = useCompany();
  const data = useCQuery<{ customOrders: LeatherCustomOrder[] }>(
    ['leather', 'custom-orders'],
    '/api/leather/custom-orders',
  );
  const [selected, setSelected] = useState<LeatherCustomOrder | null>(null);
  useFocusedRecord(data.data?.customOrders, setSelected);
  return (
    <>
      <LeatherHeader
        title={t('leather.customOrders')}
        description="Monogramı, konumunu, müşteri talebini ve termini üretime bağlı özel sipariş olarak izleyin."
      />
      {can('leather.catalog.manage') && (
        <OperationForm
          title="Yeni özel sipariş"
          fields={[
            selectField(
              'partyId',
              'Sipariş müşterisi',
              options(
                lookups.parties.filter((row) => row.kind !== 'supplier'),
                (row) => row.name,
              ),
            ),
            selectField(
              'variantId',
              'Sipariş ürün varyantı',
              options(
                variants.data?.variants.filter((row) => row.allowsPersonalization),
                (row) => `${row.itemName} · ${row.color} ${row.size}`,
              ),
            ),
            numberField('quantity', 'Sipariş adedi', '1', 1),
            { name: 'dueDate', label: 'Müşteriye teslim tarihi', type: 'date', required: true },
            { ...textField('currency', 'Sipariş para birimi', true), value: company.baseCurrency },
            numberField('unitPrice', 'Sipariş birim fiyatı'),
            textField('monogram', 'Monogram metni'),
            textField('placement', 'Monogram konumu'),
            { ...textField('customerNotes', 'Müşteri talebi'), type: 'textarea' },
          ]}
          submit={(values) => save('/api/leather/custom-orders', values)}
        />
      )}
      <Records
        rows={data.data?.customOrders}
        loading={data.isPending}
        error={data.error}
        columns={[
          { label: 'Müşteri', render: (row) => row.partyName },
          { label: 'Ürün', render: (row) => row.itemName },
          { label: 'Adet', render: (row) => row.quantity, numeric: true },
          { label: 'Monogram', render: (row) => `${row.monogram || '—'} · ${row.placement}` },
          { label: 'Teslim tarihi', render: (row) => row.dueDate },
          {
            label: 'Birim fiyat',
            render: (row) => moneyIn(row.unitPrice, row.currency),
            numeric: true,
          },
          { label: 'Durum', render: (row) => <Status value={row.status} /> },
        ]}
        action={(row) =>
          can('leather.catalog.manage') ? (
            <Button size="sm" onClick={() => setSelected(row)}>
              Sipariş işlemi
            </Button>
          ) : null
        }
      />
      {selected && (
        <div className="mt-5">
          <OperationForm
            key={selected.id}
            title={`${selected.partyName} özel sipariş işlemi`}
            fields={[
              selectField('action', 'Sipariş işlemi', [
                { value: 'confirm', label: 'Siparişi kesinleştir' },
                { value: 'ready', label: 'Teslime hazır' },
                { value: 'deliver', label: 'Müşteriye teslim et' },
                { value: 'cancel', label: 'Siparişi iptal et' },
              ]),
              selectField(
                'treasuryTransactionId',
                'Kayıtlı kapora tahsilatı',
                options(
                  lookups.depositTransactions.filter((row) => row.partyId === selected.partyId),
                  (row) =>
                    `${row.description || 'Tahsilat'} · ${moneyIn(row.amount, row.currencyCode)}`,
                ),
                false,
              ),
              selectField(
                'invoiceId',
                'Teslim satış faturası',
                lookups.saleLines
                  .filter(
                    (row, index, rows) =>
                      row.partyId === selected.partyId &&
                      rows.findIndex((item) => item.invoiceId === row.invoiceId) === index,
                  )
                  .map((row) => ({ value: row.invoiceId, label: row.description })),
                false,
              ),
              textField('note', 'Sipariş işlem notu'),
            ]}
            submit={(values) =>
              save(`/api/leather/custom-orders/${selected.id}/actions`, {
                action: values.action,
                treasuryTransactionId: values.treasuryTransactionId || undefined,
                invoiceId: values.invoiceId || undefined,
                note: values.note,
              })
            }
            onDone={() => setSelected(null)}
          >
            <p className="text-sm text-muted">
              Üretim planlarken kesinleşmiş özel siparişi üretim emrine bağlayın.
            </p>
          </OperationForm>
        </div>
      )}
    </>
  );
}

export function LeatherServicePage() {
  const { t } = useTranslation();
  const can = useCan();
  const lookups = useStockLookups();
  const save = useLeatherActions();
  const company = useCompany();
  const data = useCQuery<{ cases: LeatherServiceCase[] }>(
    ['leather', 'service'],
    '/api/leather/service/cases',
  );
  const [saleLineId, setSaleLineId] = useState('');
  const saleLine = lookups.saleLines.find((row) => row.id === saleLineId);
  const [selected, setSelected] = useState<LeatherServiceCase | null>(null);
  const [parts, setParts] = useState<ReservationDraft[]>([]);
  const pieces = useCQuery<{ pieces: LeatherPiece[] }>(
    ['leather', 'pieces'],
    '/api/leather/materials/pieces',
    { enabled: can('leather.materials.read') },
  );
  useFocusedRecord(data.data?.cases, setSelected);
  return (
    <>
      <LeatherHeader
        title={t('leather.service')}
        description="Kendi ürününüzün satış satırından garanti, bakım ve onarım kaydı açın; teslim sürecini izleyin."
      />
      {can('leather.service.manage') && (
        <>
          <div className="mb-4 max-w-2xl">
            <Field label="Servise alınacak satış ürünü">
              {(id) => (
                <Select
                  id={id}
                  value={saleLineId}
                  onChange={(event) => setSaleLineId(event.target.value)}
                >
                  <option value="">Satış ürünü seçiniz</option>
                  {lookups.saleLines.map((row) => (
                    <option key={row.id} value={row.id}>
                      {lookups.parties.find((party) => party.id === row.partyId)?.name ?? 'Müşteri'}{' '}
                      · {row.description} · {row.quantity} adet
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {saleLine && (
            <OperationForm
              key={saleLine.id}
              title="Servis kabulü"
              fields={[
                {
                  name: 'date',
                  label: 'Servis kabul tarihi',
                  type: 'date',
                  value: todayIso(),
                  required: true,
                },
                {
                  ...textField('complaint', 'Müşteri şikâyeti / bakım talebi', true),
                  type: 'textarea',
                },
                selectField(
                  'warranty',
                  'Garanti kapsamında',
                  [
                    { value: 'false', label: 'Hayır / değerlendirme bekliyor' },
                    { value: 'true', label: 'Evet' },
                  ],
                  true,
                  'false',
                ),
              ]}
              action="Servis kaydını aç"
              submit={(values) =>
                save('/api/leather/service/cases', {
                  ...values,
                  partyId: saleLine.partyId,
                  itemId: saleLine.itemId,
                  invoiceLineId: saleLine.id,
                  warranty: values.warranty === 'true',
                })
              }
            />
          )}
        </>
      )}
      <Records
        rows={data.data?.cases}
        loading={data.isPending}
        error={data.error}
        columns={[
          { label: 'Müşteri', render: (row) => row.partyName },
          { label: 'Ürün', render: (row) => row.itemName },
          { label: 'Kabul tarihi', render: (row) => row.date },
          { label: 'Talep', render: (row) => row.complaint },
          {
            label: 'Garanti',
            render: (row) => (row.warranty ? 'Kapsamda' : 'Değerlendirme / ücretli'),
          },
          { label: 'Ücret', render: (row) => moneyIn(row.fee, company.baseCurrency) },
          { label: 'Durum', render: (row) => <Status value={row.status} /> },
        ]}
        action={(row) =>
          can('leather.service.manage') ? (
            <Button size="sm" onClick={() => setSelected(row)}>
              Servis işlemi
            </Button>
          ) : null
        }
      />
      {selected && (
        <div className="mt-5">
          <OperationForm
            key={selected.id}
            title={`${selected.itemName} servis işlemi`}
            fields={[
              selectField('action', 'Servis işlemi', [
                { value: 'diagnose', label: 'İncele ve teşhis et' },
                { value: 'approve_repair', label: 'Müşteri onayını kaydet' },
                { value: 'repair', label: 'Onarıma al' },
                { value: 'ready', label: 'Teslime hazır' },
                { value: 'deliver', label: 'Müşteriye teslim et' },
                { value: 'cancel', label: 'Servisi iptal et' },
              ]),
              {
                ...textField('assessment', 'Teknik değerlendirme'),
                type: 'textarea',
                value: selected.assessment,
              },
              numberField('fee', 'Servis ücreti', selected.fee || '0'),
              textField('approvalReference', 'Müşteri onayının belge / iletişim referansı'),
              selectField(
                'warehouseId',
                'Onarım malzemesi deposu',
                options(lookups.warehouses, (warehouse) => warehouse.name),
                false,
              ),
              selectField(
                'invoiceId',
                'Ücretli servis faturası',
                lookups.saleLines
                  .filter(
                    (row, index, rows) =>
                      row.partyId === selected.partyId &&
                      rows.findIndex((item) => item.invoiceId === row.invoiceId) === index,
                  )
                  .map((row) => ({ value: row.invoiceId, label: row.description })),
                false,
              ),
              ...datedFields(),
            ]}
            submit={(values) =>
              save(`/api/leather/service/cases/${selected.id}/actions`, {
                ...dated(values),
                action: values.action,
                assessment: values.assessment,
                fee: values.fee,
                invoiceId: values.invoiceId || undefined,
                approvalReference: values.approvalReference || undefined,
                warehouseId:
                  values.action === 'repair' ? values.warehouseId || undefined : undefined,
                parts:
                  values.action === 'repair' && parts.length
                    ? parts.map((line) => ({
                        itemId: line.itemId,
                        quantity: line.quantity,
                        pieces: line.pieceId
                          ? [{ pieceId: line.pieceId, quantity: line.quantity }]
                          : [],
                      }))
                    : undefined,
              })
            }
            onDone={() => {
              setSelected(null);
              setParts([]);
            }}
          >
            <ReservationRows
              title="Onarımda kullanılan parçalar"
              materialLabel="Onarım malzemesi"
              quantityLabel="Onarım sarf miktarı"
              rows={parts}
              onChange={setParts}
              items={lookups.items}
              pieces={pieces.data?.pieces ?? []}
            />
            <p className="text-sm text-muted">
              Ücretli onarımda teşhis ve fiyatlandırmadan sonra müşteri onayını kaydedin. Parça
              sarfı, onarım işlemi sırasında seçilen depodan yapılır.
            </p>
          </OperationForm>
        </div>
      )}
    </>
  );
}
