import { z } from 'zod';
import { ACCESS_LEVELS } from '../module-access';

/**
 * Üyenin modül erişimini toplu değiştirir. Anahtar = erişim alanı (bir kayıt modülü anahtarı); değer: üç düzeyden biri ya da
 * `default` (istisnayı kaldırır, rol varsayılanı geçerli olur). Gönderilmeyen alanlar değişmez.
 */
export const setModuleAccessSchema = z.object({
  levels: z.record(z.string().min(3).max(60), z.enum([...ACCESS_LEVELS, 'default'])).refine((o) => Object.keys(o).length >= 1 && Object.keys(o).length <= 40, 'En az bir modül gönderilmeli'),
  note: z.string().trim().max(300).optional(),
});
export type SetModuleAccessInput = z.infer<typeof setModuleAccessSchema>;
