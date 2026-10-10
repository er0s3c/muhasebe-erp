import { z } from 'zod';
import { uuid } from './schemas/common';

export const API_KEY_SCOPES=['inventory.read','parties.read','invoices.read','invoices.create_draft'] as const;
export type ApiKeyScope=(typeof API_KEY_SCOPES)[number];
export const API_KEY_SCOPE_LABELS:Record<ApiKeyScope,string>={ 'inventory.read':'Stok kartlarını oku','parties.read':'Cari hesapları oku','invoices.read':'Faturaları oku','invoices.create_draft':'Taslak satış faturası oluştur' };
export const WEBHOOK_EVENT_TYPES=['invoice.draft.created','invoice.posted'] as const;
export type PlatformWebhookEventType=(typeof WEBHOOK_EVENT_TYPES)[number];
export const createApiKeySchema=z.object({name:z.string().trim().min(2).max(100),expiresAt:z.iso.datetime(),branchId:uuid.nullable(),scopes:z.array(z.enum(API_KEY_SCOPES)).min(1).max(4)}).strict().refine(v=>new Set(v.scopes).size===v.scopes.length,'Erişim listesinde tekrar olamaz');
export const createWebhookSubscriptionSchema=z.object({name:z.string().trim().min(2).max(100),url:z.url().max(2000),branchId:uuid.nullable(),eventTypes:z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(2)}).strict().refine(v=>new Set(v.eventTypes).size===v.eventTypes.length,'Olay listesinde tekrar olamaz');
export interface PlatformWebhookPayload {id:string;type:PlatformWebhookEventType;occurredAt:string;companyId:string;branchId:string|null;data:{invoiceId:string;invoiceNo:string|null;status:string};}
export type CreateApiKeyInput=z.infer<typeof createApiKeySchema>;
export type CreateWebhookSubscriptionInput=z.infer<typeof createWebhookSubscriptionSchema>;
