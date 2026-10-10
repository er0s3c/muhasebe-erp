import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { userUiPreferences } from '../../db/schema';
import { tenantRoute } from '../../http/context';
import { badRequest } from '../../http/errors';

/**
 * Kişisel arayüz tercihleri (favoriler, pano düzeni, tablo yoğunluğu). Her üye yalnız kendi satırını okur/yazar
 * (sahiplik RLS'tedir). Kapı her rolde bulunan `settings.read`; değerler anahtar başına şemayla doğrulanır.
 */
const pathSchema = z.string().min(1).max(300).startsWith('/');
const PREFERENCE_SCHEMAS = {
  favorites: z.array(z.object({ path: pathSchema, title: z.string().trim().min(1).max(80) }).strict()).max(20),
  'dashboard.layout': z
    .object({
      version: z.literal(1),
      widgets: z
        .array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/), size: z.enum(['s', 'm', 'l']) }).strict())
        .max(30),
    })
    .strict(),
  'table.density': z.enum(['comfortable', 'compact']),
} as const;
type PreferenceKey = keyof typeof PREFERENCE_SCHEMAS;
const isKey = (key: string): key is PreferenceKey => Object.hasOwn(PREFERENCE_SCHEMAS, key);

export const preferenceRoutes: FastifyPluginAsync = async (app) => {
  const member = { permission: 'settings.read' } as const;

  app.get(
    '/api/me/preferences',
    tenantRoute(app, member, async ({ tx, user, company }) => {
      const rows = await tx
        .select({ key: userUiPreferences.key, value: userUiPreferences.value })
        .from(userUiPreferences)
        .where(and(eq(userUiPreferences.companyId, company.id), eq(userUiPreferences.userId, user.id)));
      const preferences: Partial<Record<PreferenceKey, unknown>> = {};
      for (const row of rows) {
        // Şema daralmışsa eski/geçersiz değer döndürülmez; istemci varsayılanı kullanır
        if (isKey(row.key) && PREFERENCE_SCHEMAS[row.key].safeParse(row.value).success) preferences[row.key] = row.value;
      }
      return { preferences };
    }),
  );

  app.put(
    '/api/me/preferences/:key',
    // Kişisel veridir (şirket ayarı değil): salt-okunur ayar erişimi olan üye de kendi tercihini yazabilir
    tenantRoute(app, { ...member, operation: 'read', limit: { name: 'ui-preferences', max: 120, windowMs: 60_000 } }, async ({ tx, req, user, company }) => {
      const { key } = z.object({ key: z.string() }).parse(req.params);
      if (!isKey(key)) throw badRequest('Bilinmeyen tercih anahtarı', 'PREFERENCE_UNKNOWN');
      const body = z.object({ value: z.unknown() }).parse(req.body);
      const parsed = PREFERENCE_SCHEMAS[key].safeParse(body.value);
      if (!parsed.success) throw badRequest('Tercih değeri geçersiz', 'PREFERENCE_INVALID');
      await tx
        .insert(userUiPreferences)
        .values({ companyId: company.id, userId: user.id, key, value: parsed.data })
        .onConflictDoUpdate({
          target: [userUiPreferences.companyId, userUiPreferences.userId, userUiPreferences.key],
          set: { value: parsed.data, updatedAt: new Date() },
        });
      return { value: parsed.data };
    }),
  );
};
