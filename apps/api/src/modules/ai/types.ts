import type { AiChatMessage, AiSource, AiToolDefinition, AiToolCall, AiToolResult } from '@erp/shared';

export interface AiSessionContext {
  user: {
    id: string;
    fullName?: string;
    role: string;
  };
  company: {
    id: string;
    name: string;
    sector: string;
    baseCurrency: string;
  };
  today: string;
  /** Server-derived, never accepted from chat input. Missing access denies DB tools. */
  allowedTools?: ReadonlySet<string>;
  pendingApprovalTypes?: readonly string[];
}

/**
 * Bir ERP aracını kendi kısa, salt okunur işleminde çalıştırır; yetki o anda yeniden denetlenir.
 * Sağlayıcı çağrıları sırasında veritabanı işlemi açık tutulmaz.
 */
export type AiToolRunner = (name: string, args: Record<string, unknown>) => Promise<AiToolResult>;

export interface GenerateAiOptions {
  message: string;
  history?: AiChatMessage[];
  context: AiSessionContext;
  apiKey?: string;
  model?: string;
  runTool?: AiToolRunner;
}

export interface AiExecutionResult {
  success: boolean;
  answer?: string;
  error?: string;
  code?: string;
  /** Yanıtta kullanılan ERP verilerinin kaynağı (öneri 18). */
  sources?: AiSource[];
}

export type { AiChatMessage, AiToolDefinition, AiToolCall, AiToolResult };
