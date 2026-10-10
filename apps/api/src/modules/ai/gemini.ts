import { GoogleGenAI } from '@google/genai';
import type { AiChatMessage } from '@erp/shared';
import type { AiSessionContext, AiExecutionResult } from './types';
import type { Tx } from '../../db/client';
import { toolRegistry } from './tools';

let cachedClient: GoogleGenAI | null = null;
let lastApiKey: string | null = null;

function getClient(apiKey: string): GoogleGenAI {
  if (cachedClient && lastApiKey === apiKey) {
    return cachedClient;
  }
  cachedClient = new GoogleGenAI({ apiKey, httpOptions: { timeout: 30_000, retryOptions: { attempts: 1 } } });
  lastApiKey = apiKey;
  return cachedClient;
}

export interface CallGeminiParams {
  apiKey?: string;
  model: string;
  systemInstruction: string;
  history?: AiChatMessage[];
  message: string;
  context?: AiSessionContext;
  tx?: Tx;
}

export async function callGemini(
  params: CallGeminiParams,
): Promise<AiExecutionResult> {
  const { apiKey, model, systemInstruction, history = [], message, context, tx } = params;

  if (!apiKey || apiKey.trim() === '') {
    return {
      success: false,
      error:
        'Ada AI servisi henüz yapılandırılmamış. Lütfen sistem yöneticisi ile iletişime geçin.',
      code: 'AI_NOT_CONFIGURED',
    };
  }

  try {
    const client = getClient(apiKey.trim());

    // Mesaj geçmişini Gemini formatına çevir
    const contents: Array<Record<string, unknown>> = [
      ...history.map((h) => ({
        role: h.role === 'model' ? 'model' : 'user',
        parts: [{ text: h.text }],
      })),
      {
        role: 'user',
        parts: [{ text: message }],
      },
    ];

    // Kayıtlı ERP araçlarını hazırla (eğer DB oturumu varsa)
    const toolDeclarations = tx && context ? toolRegistry.getDeclarations(context) : [];
    const toolsConfig = toolDeclarations.length > 0 ? [{ functionDeclarations: toolDeclarations }] : undefined;

    const response = await client.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction,
        ...(toolsConfig ? { tools: toolsConfig } : {}),
        temperature: 0.2, // Tutarlılık ve gerçek veriye sadakat için düşük sıcaklık
        maxOutputTokens: 2048,
      },
    });

    // Model bir veya daha fazla ERP fonksiyonunu çağırmak istiyorsa (Function Calling)
    if (
      response.functionCalls &&
      response.functionCalls.length > 0 &&
      context &&
      tx &&
      response.candidates?.[0]?.content
    ) {
      const candidateContent = response.candidates[0].content;

      // Her aracı güvenle çalıştır ve sonucunu topla
      const functionResponseParts = [];
      for (const [index, call] of response.functionCalls.entries()) {
          const callName = call.name ?? '';
          const result = index >= 8 ? { result: null, error: 'Tek istekte en fazla 8 araç kullanılabilir.' } : await toolRegistry.execute(
            callName,
            (call.args as Record<string, unknown>) || {},
            context,
            tx,
          );
          functionResponseParts.push({
            functionResponse: {
              name: callName,
              response: {
                data: result.result ?? null,
                error: result.error ?? null,
              },
            },
          });
      }

      // Fonksiyon çıktılarını Gemini'ye geri besle ve doğal dil yanıtını al
      const followUpContents = [
        ...contents,
        candidateContent,
        {
          role: 'user',
          parts: functionResponseParts,
        },
      ];

      const followUpResponse = await client.models.generateContent({
        model,
        contents: followUpContents as Parameters<typeof client.models.generateContent>[0]['contents'],
        config: {
          systemInstruction,
          temperature: 0.2,
          maxOutputTokens: 2048,
        },
      });

      const finalAnswer = followUpResponse.text?.trim();
      if (!finalAnswer) {
        return {
          success: false,
          error: 'Ada AI veriyi getirdi ancak yanıt oluşturamadı. Lütfen sorunuzu tekrarlayın.',
          code: 'AI_EMPTY_RESPONSE',
        };
      }

      return {
        success: true,
        answer: finalAnswer,
      };
    }

    const answerText = response.text?.trim();

    if (!answerText) {
      return {
        success: false,
        error: 'Ada AI boş bir yanıt döndürdü. Lütfen sorunuzu farklı bir şekilde iletin.',
        code: 'AI_EMPTY_RESPONSE',
      };
    }

    return {
      success: true,
      answer: answerText,
    };
  } catch (err: unknown) {
    // Güvenli hata eşleme: Asla API anahtarı veya ham yığın izini dışarı sızdırma
    const errorObj = err as { status?: number; code?: number | string; message?: string };
    const status = errorObj?.status;

    if (status === 401 || status === 403) {
      return {
        success: false,
        error:
          'Geçersiz veya yetkisiz Gemini API anahtarı. Lütfen .env dosyasındaki GEMINI_API_KEY değerini kontrol edin.',
        code: 'AI_AUTH_ERROR',
      };
    }

    if (status === 404) {
      return {
        success: false,
        error: 'Yapılandırılmış asistan modeli kullanılamıyor. Sistem yöneticisi model ayarını kontrol etmelidir.',
        code: 'AI_MODEL_NOT_FOUND',
      };
    }

    if (status === 429) {
      return {
        success: false,
        error: 'Gemini istek kotası aşıldı (Rate limit). Lütfen birkaç dakika sonra tekrar deneyin.',
        code: 'AI_RATE_LIMIT',
      };
    }

    if (status === 400) {
      const msg = errorObj?.message || '';
      if (msg.includes('API_KEY_INVALID') || msg.includes('API key not valid')) {
        return {
          success: false,
          error:
            'Geçersiz Gemini API anahtarı. Google AI Studio anahtarları genellikle \'AIzaSy...\' ile başlar. Lütfen .env dosyasındaki GEMINI_API_KEY değerini kontrol edin.',
          code: 'AI_INVALID_KEY',
        };
      }
      return {
        success: false,
        error: 'İstek işlenirken bir sorun oluştu. Lütfen parametreleri kontrol edin.',
        code: 'AI_BAD_REQUEST',
      };
    }

    if (status === 503) {
      return {
        success: false,
        error: 'Google Gemini servisi şu anda aşırı talep nedeniyle kullanılamıyor. Lütfen biraz sonra tekrar deneyin.',
        code: 'AI_UNAVAILABLE',
      };
    }

    return {
      success: false,
      error: 'Ada AI şu anda yanıt veremiyor. Lütfen API anahtarınızı ve model ayarınızı kontrol edin.',
      code: 'AI_ERROR',
    };
  }
}
