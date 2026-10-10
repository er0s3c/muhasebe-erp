import { describe, expect, it } from 'vitest';
import { EMPTY_PORTAL_SCOPES, portalDocumentScopesSchema, portalScopeOf } from './portal';
describe('Portal belge kapsamı', () => {
  it('eski bağlantıda yeni belge kategorileri kendiliğinden açılmaz', () => { expect(portalDocumentScopesSchema.parse({})).toEqual(EMPTY_PORTAL_SCOPES); expect(portalDocumentScopesSchema.parse({ invoices: true })).toEqual({ ...EMPTY_PORTAL_SCOPES, invoices: true }); });
  it.each([{ invoices: 'true' }, { payroll: true }, { invoices: null }, ['invoices']])('geçersiz kapsamı reddeder: %j', value => { expect(portalDocumentScopesSchema.safeParse(value).success).toBe(false); });
  it('belge türleri yalnız bilinen kapsam anahtarlarına bağlanır', () => { expect(['invoice', 'quote', 'order'].map(kind => portalScopeOf(kind as Parameters<typeof portalScopeOf>[0]))).toEqual(['invoices', 'quotes', 'orders']); });
});
