import type { AiChatMessage, AiToolDefinition, AiToolCall, AiToolResult } from '@erp/shared';

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

import type { Tx } from '../../db/client';

export interface GenerateAiOptions {
  message: string;
  history?: AiChatMessage[];
  context: AiSessionContext;
  apiKey?: string;
  model?: string;
  tx?: Tx;
}

export interface AiExecutionResult {
  success: boolean;
  answer?: string;
  error?: string;
  code?: string;
}

export type { AiChatMessage, AiToolDefinition, AiToolCall, AiToolResult };
