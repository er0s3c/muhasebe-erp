import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addMember, client, createCompany, makeApp, registerUser } from './helpers';

const provider = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('@google/genai', async importOriginal => ({
  ...await importOriginal<typeof import('@google/genai')>(),
  GoogleGenAI: class { models = { generateContent: provider.generate }; },
}));

const within = <T>(work: Promise<T>, ms: number, label: string) =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} ${ms} ms içinde bitmedi`)), ms))]);

describe('Ada AI: sağlayıcı beklenirken veritabanı işlemi tutulmaz (öneri 19)', async () => {
  const { app } = await makeApp({ configOverrides: { GEMINI_API_KEY: 'test-key' } });
  beforeEach(() => provider.generate.mockReset());

  it('üretim şirketinde sağlayıcı yanıtı beklenirken aynı şirkette maliyet kilidi alan yazma beklemeden tamamlanır', async () => {
    const owner = await registerUser(app, 'AiKilit');
    const company = await createCompany(app, owner.token, { name: 'AI Kilit Üretim', sector: 'MANUFACTURING_WHOLESALE' });
    const c = client(app, owner.token, company.id);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    provider.generate.mockImplementationOnce(async () => { entered(); await gate; return { text: 'Tamam' }; });

    const chat = c.post('/api/ai/chat', { message: 'Merhaba' });
    await within(waiting, 10_000, 'sağlayıcı çağrısı');
    // Eskiden AI isteği maliyet sırası kilidini (leather-costs) sağlayıcı cevabına kadar tutuyordu; bu yazma beklerdi
    const party = await within(c.post('/api/parties', { name: 'Beklemeyen Cari', kind: 'customer' }), 10_000, 'cari kaydı');
    expect(party.statusCode, party.body).toBe(201);
    release();
    const res = await chat;
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ success: true, answer: 'Tamam' });
  });

  it('sohbet sırasında kaldırılan dışa aktarma izni bir sonraki araç okumasında hemen uygulanır', async () => {
    const owner = await registerUser(app, 'AiYetki');
    const company = await createCompany(app, owner.token, { name: 'AI Yetki Ltd.' });
    const ownerClient = client(app, owner.token, company.id);
    const member = await addMember(app, ownerClient, company.id, 'admin', 'ai-yonetici');
    provider.generate
      .mockImplementationOnce(async () => {
        // Model araç isterken yönetici üyenin stok dışa aktarma iznini kapatır
        const denied = await ownerClient.put(`/api/company/members/${member.userId}/module-access`, { operations: { 'operation.core.inventory.export': 'deny' } });
        expect(denied.statusCode, denied.body).toBe(200);
        return {
          functionCalls: [{ name: 'list_critical_stock', args: {} }],
          candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'list_critical_stock', args: {} } }] } }],
        };
      })
      .mockResolvedValueOnce({ text: 'Yetki yok' });

    const res = await member.client.post('/api/ai/chat', { message: 'Kritik stoklar?' });
    expect(res.statusCode, res.body).toBe(200);
    expect(provider.generate).toHaveBeenCalledTimes(2);
    // İlk çağrıda araç sunulmuştu; okuma anında izin yeniden denetlendi ve veri gönderilmedi
    expect(provider.generate.mock.calls[0]![0].config.tools[0].functionDeclarations.map((d: { name: string }) => d.name)).toContain('list_critical_stock');
    const response = provider.generate.mock.calls[1]![0].contents.at(-1).parts[0].functionResponse.response;
    expect(response.data).toBeNull();
    expect(response.error).toContain('yetkiniz yok');
  });
});
