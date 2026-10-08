import { z } from 'zod';
import { ACCESS_LEVELS, PERMISSION_CHOICES } from '../module-access';

/**
 * Üyenin modül erişimini toplu değiştirir. Anahtar = erişim alanı (bir kayıt modülü anahtarı); değer: üç düzeyden biri ya da
 * `default` (istisnayı kaldırır, rol varsayılanı geçerli olur). `permissions` gerçek API iznini allow/deny/default ile ayrı değiştirir.
 * Gönderilmeyen alanlar ve işlemler değişmez.
 */
export const setModuleAccessSchema = z.object({
  levels: z.record(z.string().min(3).max(60), z.enum([...ACCESS_LEVELS, 'default'])).refine((o) => Object.keys(o).length <= 40, 'En fazla 40 modül gönderilebilir').default({}),
  permissions: z.record(z.string().min(3).max(60), z.enum(PERMISSION_CHOICES)).refine((o) => Object.keys(o).length <= 160, 'En fazla 160 işlem izni gönderilebilir').default({}),
  note: z.string().trim().max(300).optional(),
}).refine((o) => Object.keys(o.levels).length + Object.keys(o.permissions).length > 0, 'En az bir modül veya işlem izni gönderilmeli');
export type SetModuleAccessInput = z.infer<typeof setModuleAccessSchema>;
