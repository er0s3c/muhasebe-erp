import { sql } from 'drizzle-orm';
import { Type, type FunctionDeclaration } from '@google/genai';
import type { AiToolDefinition, AiToolResult } from '@erp/shared';
import type { AiSessionContext } from './types';
import type { Tx } from '../../db/client';
import { stockStatus } from '../inventory/reports';
import { listTreasuryAccounts } from '../treasury/accounts';
import { allOpenItems } from '../parties/service';

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: AiSessionContext,
  tx?: Tx,
) => Promise<unknown>;

export interface RegisteredTool {
  definition: AiToolDefinition;
  declaration: FunctionDeclaration;
  handler: ToolHandler;
}

/**
 * Güvenli ve Onaylı ERP Araç Kayıt Defteri (Tool Registry).
 * Gemini asla doğrudan SQL sorgusu yazamaz ve çalıştıramaz.
 * Tüm araçlar parametre doğrulamasından geçer ve yalnızca yetkili backend fonksiyonlarını çağırır.
 */
class AiToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Araç zaten kayıtlı: ${tool.definition.name}`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  getDefinitions(): AiToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  getDeclarations(ctx?: AiSessionContext): FunctionDeclaration[] {
    return Array.from(this.tools.values()).filter((t) => !ctx || ctx.allowedTools?.has(t.definition.name)).map((t) => t.declaration);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: AiSessionContext,
    tx?: Tx,
  ): Promise<AiToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        name,
        error: `Böyle bir onaylı ERP aracı bulunamadı: ${name}`,
      };
    }

    if (tx && !ctx.allowedTools?.has(name)) return { name, error: 'Bu verileri okumak veya dışa aktarmak için yetkiniz yok.' };
    if (Object.keys(args).length > 0) return { name, error: 'Bu araç parametre kabul etmez.' };
    try {
      // Araç parametreleri backend tarafında güvenle çalıştırılır (Asla keyfi SQL yok)
      const result = await tool.handler(args, ctx, tx);
      return {
        name,
        result,
      };
    } catch {
      return {
        name,
        error: 'ERP verileri şu anda okunamadı. İlgili ekranı kontrol edip tekrar deneyin.',
      };
    }
  }
}

export const toolRegistry = new AiToolRegistry();

// ---------------------------------------------------------------------------
// 1. Kritik Stokları Listeleme
// ---------------------------------------------------------------------------
toolRegistry.register({
  definition: {
    name: 'list_critical_stock',
    description: 'Minimum veya emniyet stok seviyesinin altına düşmüş kritik ürünleri ve mevcut stok miktarlarını listeler.',
    parameters: {},
  },
  declaration: {
    name: 'list_critical_stock',
    description: 'Minimum veya emniyet stok seviyesinin altına düşmüş kritik ürünleri ve mevcut stok miktarlarını listeler.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  handler: async (_args, ctx, tx) => {
    if (!tx) {
      return { count: 0, items: [], message: 'Veritabanı oturumu mevcut değil.' };
    }
    const res = await stockStatus(
      tx,
      { baseCurrency: ctx.company.baseCurrency, reportingCurrency: null },
      { asOf: ctx.today, lowOnly: 'true', includeZero: 'true' },
    );

    const items = res.rows.slice(0, 50).map((r) => ({
      kod: r.code,
      urunAdi: r.name,
      birim: r.unit,
      mevcutMiktar: r.onHand,
      kritikSeviye: r.minLevel,
      kategori: r.categoryName ?? 'Genel',
      toplamDeger: `${r.value} ${ctx.company.baseCurrency}`,
    }));

    return {
      tarih: ctx.today,
      toplamKritikUrunSayisi: res.rows.length,
      listeSiniri: 50,
      urunler: items,
      bilgi: items.length === 0 ? 'Tüm stoklar güvenli seviyededir, kritik seviyenin altında ürün bulunmamaktadır.' : undefined,
    };
  },
});

// ---------------------------------------------------------------------------
// 2. Kasa ve Banka Bakiyeleri
// ---------------------------------------------------------------------------
toolRegistry.register({
  definition: {
    name: 'get_cash_and_bank_balances',
    description: 'Şirketin tüm kasa ve banka hesaplarının güncel bakiyelerini, para birimlerini ve son hareket tarihlerini listeler.',
    parameters: {},
  },
  declaration: {
    name: 'get_cash_and_bank_balances',
    description: 'Şirketin tüm kasa ve banka hesaplarının güncel bakiyelerini, para birimlerini ve son hareket tarihlerini listeler.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  handler: async (_args, ctx, tx) => {
    if (!tx) return { message: 'Veritabanı oturumu mevcut değil.' };
    const accounts = await listTreasuryAccounts(
      tx,
      {
        companyId: ctx.company.id,
        userId: ctx.user.id,
        baseCurrency: ctx.company.baseCurrency,
        reportingCurrency: null,
      },
      ctx.today,
    );

    const activeAccounts = accounts
      .filter((a) => a.isActive)
      .map((a) => ({
        hesapAdi: a.name,
        tur: a.kind === 'cash' ? 'Kasa (Nakit)' : 'Banka Hesabı',
        paraBirimi: a.currencyCode,
        bakiye: `${a.balance} ${a.currencyCode}`,
        anaParaBirimiKarsiligi: a.equivalent ? `${a.equivalent} ${ctx.company.baseCurrency}` : null,
        banka: a.bankName ?? null,
        sonIslemTarihi: a.lastActivity,
      }));

    return {
      tarih: ctx.today,
      hesaplar: activeAccounts,
      anaParaBirimi: ctx.company.baseCurrency,
    };
  },
});

// ---------------------------------------------------------------------------
// 3. Vadesi Geçmiş Alacaklar ve Borçlar
// ---------------------------------------------------------------------------
toolRegistry.register({
  definition: {
    name: 'get_overdue_receivables',
    description: 'Vadesi geçmiş müşteri alacaklarını ve tedarikçi borçlarını gün gecikmesi ile listeler.',
    parameters: {},
  },
  declaration: {
    name: 'get_overdue_receivables',
    description: 'Vadesi geçmiş müşteri alacaklarını ve tedarikçi borçlarını gün gecikmesi ile listeler.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  handler: async (_args, ctx, tx) => {
    if (!tx) return { message: 'Veritabanı oturumu mevcut değil.' };
    const receivables = await allOpenItems(tx, 'receivable', ctx.today);
    const payables = await allOpenItems(tx, 'payable', ctx.today);
    const rows = [
      ...receivables.map(r => ({ ...r, type: 'receivable' })),
      ...payables.map(r => ({ ...r, type: 'payable' })),
    ].filter(r => r.daysOverdue > 0).sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    return {
      tarih: ctx.today,
      toplamKayit: rows.length,
      listeSiniri: 15,
      vadesiGecmisKalemler: rows.slice(0, 15).map((r) => ({
        yevmiyeNo: r.entryNo,
        tur: r.type === 'receivable' ? 'Müşteri Alacağı' : 'Tedarikçi Borcu',
        cari: r.partyName,
        kayitTarihi: r.entryDate,
        vadeTarihi: r.dueDate,
        gecikenGun: r.daysOverdue,
        kalanTutar: `${r.remaining} ${r.currencyCode}`,
      })),
      bilgi: rows.length === 0 ? 'Vadesi geçmiş açık alacak veya borç kalemi bulunmamaktadır.' : undefined,
    };
  },
});

// ---------------------------------------------------------------------------
// 4. Son Faturalar
// ---------------------------------------------------------------------------
toolRegistry.register({
  definition: {
    name: 'get_recent_invoices',
    description: 'Son kesilen veya alınan faturaları (fatura no, cari, tutar, vade ve durum) listeler.',
    parameters: {},
  },
  declaration: {
    name: 'get_recent_invoices',
    description: 'Son kesilen veya alınan faturaları (fatura no, cari, tutar, vade ve durum) listeler.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  handler: async (_args, ctx, tx) => {
    if (!tx) return { message: 'Veritabanı oturumu mevcut değil.' };
    const rows = await tx.execute<{
      invoiceNo: string;
      type: string;
      partyName: string;
      invoiceDate: string;
      dueDate: string | null;
      grossTotal: string;
      currencyCode: string;
      status: string;
    }>(sql`
      select coalesce(i.invoice_no, 'Taslak') as "invoiceNo",
             i.type as "type",
             p.name as "partyName",
             i.invoice_date::text as "invoiceDate",
             i.due_date::text as "dueDate",
             i.gross_total as "grossTotal",
             i.currency_code as "currencyCode",
             i.status as "status"
      from invoices i
      join parties p on p.id = i.party_id
      where i.company_id = ${ctx.company.id}
      order by i.invoice_date desc, i.created_at desc
      limit 10
    `);

    return {
      toplam: rows.rows.length,
      faturalar: rows.rows.map((r) => ({
        faturaNo: r.invoiceNo,
        tur: r.type === 'sales' ? 'Satış Faturası' : r.type === 'purchase' ? 'Alış Faturası' : r.type,
        cari: r.partyName,
        tarih: r.invoiceDate,
        vade: r.dueDate,
        tutar: `${r.grossTotal} ${r.currencyCode}`,
        durum: r.status,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// 5. Aktif Projeler / Şantiyeler
// ---------------------------------------------------------------------------
toolRegistry.register({
  definition: {
    name: 'list_projects',
    description: 'ERP sistemine kayıtlı aktif veya planlanan şantiye/inşaat projelerini listeler.',
    parameters: {},
  },
  declaration: {
    name: 'list_projects',
    description: 'ERP sistemine kayıtlı aktif veya planlanan şantiye/inşaat projelerini listeler.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  handler: async (_args, ctx, tx) => {
    if (!tx) return { message: 'Veritabanı oturumu mevcut değil.' };
    const rows = await tx.execute<{
      code: string;
      name: string;
      kind: string;
      status: string;
      startDate: string | null;
      endDate: string | null;
      location: string | null;
      clientName: string | null;
    }>(sql`
      select pr.code as "code",
             pr.name as "name",
             pr.kind as "kind",
             pr.status as "status",
             pr.start_date::text as "startDate",
             pr.end_date::text as "endDate",
             pr.location as "location",
             p.name as "clientName"
      from projects pr
      left join parties p on p.id = pr.client_party_id
      where pr.company_id = ${ctx.company.id}
        and pr.status in ('planned', 'active')
      order by pr.code asc
      limit 20
    `);

    return {
      toplamProje: rows.rows.length,
      projeler: rows.rows.map((r) => ({
        kod: r.code,
        ad: r.name,
        tur: r.kind === 'contract' ? 'Taahhüt (İşveren Sözleşmeli)' : 'Öz Kaynak / Kendi İşi',
        durum: r.status,
        isveren: r.clientName,
        baslangicTarihi: r.startDate,
        bitisTarihi: r.endDate,
        konum: r.location,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// 6. Onay Bekleyen Belgeler
// ---------------------------------------------------------------------------
toolRegistry.register({
  definition: {
    name: 'get_pending_approvals',
    description: 'Onay bekleyen belgeleri (hakediş onayları, satın alma talepleri vb.) listeler.',
    parameters: {},
  },
  declaration: {
    name: 'get_pending_approvals',
    description: 'Onay bekleyen belgeleri (hakediş onayları, satın alma talepleri vb.) listeler.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  handler: async (_args, ctx, tx) => {
    if (!tx) return { message: 'Veritabanı oturumu mevcut değil.' };
    const rows = await tx.execute<{
      docType: string;
      amount: string;
      requestedAt: string;
      requesterName: string | null;
    }>(sql`
      select ar.doc_type as "docType",
             ar.amount as "amount",
             ar.requested_at::text as "requestedAt",
             u.full_name as "requesterName"
      from approval_requests ar
      left join users u on u.id = ar.requested_by
      where ar.company_id = ${ctx.company.id}
        and ar.status = 'pending'
        and ar.doc_type in (select jsonb_array_elements_text(${JSON.stringify(ctx.pendingApprovalTypes ?? [])}::jsonb))
      order by ar.requested_at desc
      limit 15
    `);

    return {
      toplamBekleyen: rows.rows.length,
      onayKuyrugu: rows.rows.map((r) => ({
        belgeTuru: r.docType,
        tutar: `${r.amount} ${ctx.company.baseCurrency}`,
        talepTarihi: r.requestedAt,
        talepEden: r.requesterName ?? 'Bilinmiyor',
      })),
      bilgi: rows.rows.length === 0 ? 'Şu anda onay bekleyen herhangi bir işlem veya belge bulunmamaktadır.' : undefined,
    };
  },
});

// ---------------------------------------------------------------------------
// 7. Taşeron Sözleşmeleri
// ---------------------------------------------------------------------------
toolRegistry.register({
  definition: {
    name: 'get_subcontracts',
    description: 'Şantiye projelerine ait taşeron ve işveren sözleşmelerini ve durumlarını listeler.',
    parameters: {},
  },
  declaration: {
    name: 'get_subcontracts',
    description: 'Şantiye projelerine ait taşeron ve işveren sözleşmelerini ve durumlarını listeler.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  handler: async (_args, ctx, tx) => {
    if (!tx) return { message: 'Veritabanı oturumu mevcut değil.' };
    const rows = await tx.execute<{
      code: string;
      title: string;
      direction: string;
      status: string;
      currencyCode: string;
      partyName: string;
      projectName: string;
    }>(sql`
      select sc.code as "code",
             sc.title as "title",
             sc.direction as "direction",
             sc.status as "status",
             sc.currency_code as "currencyCode",
             p.name as "partyName",
             pr.name as "projectName"
      from subcontracts sc
      join parties p on p.id = sc.party_id
      join projects pr on pr.id = sc.project_id
      where sc.company_id = ${ctx.company.id}
      order by sc.created_at desc
      limit 15
    `);

    return {
      toplamSozlesme: rows.rows.length,
      sozlesmeler: rows.rows.map((r) => ({
        kod: r.code,
        baslik: r.title,
        yon: r.direction === 'payable' ? 'Taşeron (Ödenecek)' : 'İşveren (Tahsil Edilecek)',
        taraf: r.partyName,
        proje: r.projectName,
        paraBirimi: r.currencyCode,
        durum: r.status,
      })),
    };
  },
});
