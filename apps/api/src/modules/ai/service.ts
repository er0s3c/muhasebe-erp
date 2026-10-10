import { callGemini } from './gemini';
import { buildSystemInstruction, sanitizeUserInput } from './prompts';
import type { GenerateAiOptions, AiExecutionResult } from './types';

export async function generateAiChatResponse(
  options: GenerateAiOptions,
): Promise<AiExecutionResult> {
  const { message, history, context, apiKey, model = 'gemini-flash-lite-latest', tx } = options;

  // Girdi temizleme & doğrulama
  const sanitizedMessage = sanitizeUserInput(message);
  if (!sanitizedMessage) {
    return {
      success: false,
      error: 'Mesaj boş bırakılamaz.',
      code: 'AI_EMPTY_MESSAGE',
    };
  }

  // Güvenli sistem talimatını ve bağlamı oluştur
  const systemInstruction = buildSystemInstruction(context);

  // Gemini çağrısını ERP araçları ve DB oturumu ile yürüt
  return callGemini({
    apiKey,
    model,
    systemInstruction,
    history,
    message: sanitizedMessage,
    context,
    tx,
  });
}
