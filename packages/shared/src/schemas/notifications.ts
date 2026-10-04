import { z } from 'zod';
import { NOTIFICATION_KINDS } from '../notifications';
import { pageParams } from './common';

/** Bildirim listesi: `active` kapatılmamış (kapatılmamış ve çözülmemiş), `unread` yalnızca okunmamış, `all` hepsi (çözülenler dahil). */
export const NOTIFICATION_STATUS_FILTERS = ['active', 'unread', 'all'] as const;
export const notificationListQuerySchema = z.object({
  ...pageParams(50, 200),
  status: z.enum(NOTIFICATION_STATUS_FILTERS).default('active'),
  kind: z.enum(NOTIFICATION_KINDS).optional(),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export const notificationKindParam = z.enum(NOTIFICATION_KINDS);

export const updateNotificationPreferencesSchema = z.object({
  preferences: z
    .array(
      z.object({
        kind: z.enum(NOTIFICATION_KINDS),
        inApp: z.boolean().optional(),
        email: z.boolean().optional(),
        /** null: tercihi kaldırır (kaynak ayarı/varsayılan geçerli olur). */
        leadDays: z.number().int().min(0).max(365).nullable().optional(),
      }),
    )
    .min(1)
    .max(NOTIFICATION_KINDS.length),
});
export type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesSchema>;
