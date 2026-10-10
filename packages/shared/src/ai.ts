import { z } from 'zod';

export const aiRoleSchema = z.enum(['user', 'model']);
export type AiRole = z.infer<typeof aiRoleSchema>;

export const aiChatMessageSchema = z.object({
  role: aiRoleSchema,
  text: z.string().min(1, 'Mesaj metni boş olamaz').max(4000, 'Mesaj çok uzun'),
});
export type AiChatMessage = z.infer<typeof aiChatMessageSchema>;

export const aiChatRequestSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, 'Mesaj boş bırakılamaz')
    .max(2000, 'Mesaj en fazla 2000 karakter olabilir'),
  history: z.array(aiChatMessageSchema).max(10).optional(),
});
export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;

export const aiChatSuccessResponseSchema = z.object({
  success: z.literal(true),
  answer: z.string(),
});

export const aiChatErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
});

export const aiChatResponseSchema = z.union([
  aiChatSuccessResponseSchema,
  aiChatErrorResponseSchema,
]);
export type AiChatResponse = z.infer<typeof aiChatResponseSchema>;

/**
 * Geleceğe hazır kontrollü Tool/Function Calling temel arayüzleri.
 * Gemini asla doğrudan SQL çalıştırmaz; yalnızca onaylanmış ERP araçlarını çağırabilir.
 */
export interface AiToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
}

export interface AiToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, AiToolParameter>;
}

export interface AiToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface AiToolResult {
  name: string;
  result?: unknown;
  error?: string;
}
