import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tx } from '../src/db/client';
import type { AiSessionContext } from '../src/modules/ai/types';

const provider = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('@google/genai', async importOriginal => ({
  ...await importOriginal<typeof import('@google/genai')>(),
  GoogleGenAI: class { models = { generateContent: provider.generate }; },
}));
import { callGemini } from '../src/modules/ai/gemini';
import { toolRegistry } from '../src/modules/ai/tools';

const context: AiSessionContext = { user: { id: 'u', role: 'owner' }, company: { id: 'c', name: 'Firma', sector: 'COMMERCE', baseCurrency: 'TRY' }, today: '2026-10-09', allowedTools: new Set(['list_critical_stock']) };
const request = { apiKey: 'test-key', model: 'test-model', systemInstruction: 'Read-only', message: 'Stok durumu?', context, tx: {} as Tx };
beforeEach(() => { vi.restoreAllMocks(); provider.generate.mockReset(); });

describe('Asistan sağlayıcı yürütmesi', () => {
  it('aynı DB oturumunda araçlar sırayla çalışır; sekiz çağrı sınırından sonra SQL aracı yürütülmez', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const execute = vi.spyOn(toolRegistry, 'execute').mockImplementation(async (name) => {
      if (execute.mock.calls.length === 1) await gate;
      return { name, result: { count: 1 } };
    });
    provider.generate.mockResolvedValueOnce({ functionCalls: Array.from({ length: 9 }, () => ({ name: 'list_critical_stock', args: {} })), candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'list_critical_stock', args: {} } }] } }] }).mockResolvedValueOnce({ text: 'Stok özeti' });
    const response = callGemini(request);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(provider.generate).toHaveBeenCalledTimes(1);
    release();
    expect(await response).toEqual({ success: true, answer: 'Stok özeti' });
    expect(execute).toHaveBeenCalledTimes(8);
    const followUp = provider.generate.mock.calls[1]![0];
    expect(followUp.config.tools).toBeUndefined();
    const parts = followUp.contents.at(-1).parts;
    expect(parts).toHaveLength(9);
    expect(parts[8].functionResponse.response.error).toContain('en fazla 8');
  });

  it.each([401, 404, 429, 500])('sağlayıcı %s hatasında anahtar veya ham hata kullanıcıya taşınmaz', async status => {
    provider.generate.mockRejectedValue({ status, message: 'SECRET-KEY raw-provider-detail' });
    const response = await callGemini(request);
    expect(response.success).toBe(false);
    expect(JSON.stringify(response)).not.toMatch(/SECRET-KEY|raw-provider-detail|test-key/);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it('araç cevabından sonra boş sağlayıcı yanıtı başarı olarak gösterilmez', async () => {
    vi.spyOn(toolRegistry, 'execute').mockResolvedValue({ name: 'list_critical_stock', result: { count: 1 } });
    provider.generate.mockResolvedValueOnce({ functionCalls: [{ name: 'list_critical_stock', args: {} }], candidates: [{ content: { role: 'model', parts: [] } }] }).mockResolvedValueOnce({ text: '  ' });
    expect(await callGemini(request)).toMatchObject({ success: false, code: 'AI_EMPTY_RESPONSE' });
  });
});
