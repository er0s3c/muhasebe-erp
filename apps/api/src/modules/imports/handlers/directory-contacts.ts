import { createContactSchema, directoryImportOptionsSchema, emailKey, normalizeTags, phoneKey, type ImportRow } from '@erp/shared';
import { directoryContacts, directoryOrganizations } from '../../../db/schema';
import { foldKey } from '../values';
import { EMAIL_RE, RowState, cellOf, type ImportCtx, type ImportHandler, type PlanResult } from './common';

interface Planned {
  state: RowState;
  input: ReturnType<typeof createContactSchema.parse>;
  organization: string;
}

/**
 * Rehber kişileri (X6): aynı telefon (son 10 hane) ya da e-posta mevcut kişide/dosyada varsa "yinelenen" (atla ya da hata);
 * kurum adı mevcut kurumla eşleşir, yoksa yeni kurum açılır (kategori "Diğer"). Kimlik no/doğum tarihi sütunu YOKTUR.
 */
export const directoryContactsHandler: ImportHandler = {
  kind: 'directory_contacts',
  module: 'core.directory',
  permission: 'directory.manage',

  async plan(ctx: ImportCtx, rows: ImportRow[], rawOptions): Promise<PlanResult> {
    const opts = directoryImportOptionsSchema.parse(rawOptions);
    const { tx, company, userId } = ctx;

    const existing = await tx
      .select({ phone: directoryContacts.phone, phone2: directoryContacts.phone2, email: directoryContacts.email, email2: directoryContacts.email2, anonymizedAt: directoryContacts.anonymizedAt, mergedIntoId: directoryContacts.mergedIntoId })
      .from(directoryContacts);
    const takenPhone = new Set<string>();
    const takenEmail = new Set<string>();
    for (const c of existing) {
      if (c.anonymizedAt || c.mergedIntoId) continue;
      for (const p of [c.phone, c.phone2]) { const k = phoneKey(p); if (k) takenPhone.add(k); }
      for (const e of [c.email, c.email2]) { const k = emailKey(e); if (k) takenEmail.add(k); }
    }
    const orgs = await tx.select({ id: directoryOrganizations.id, name: directoryOrganizations.name }).from(directoryOrganizations);
    const orgByName = new Map(orgs.map((o) => [foldKey(o.name), o.id]));

    const states: RowState[] = [];
    const planned: Planned[] = [];
    const seenPhone = new Set<string>();
    const seenEmail = new Set<string>();

    for (const row of rows) {
      const name = cellOf(row, 'fullName');
      const rs = new RowState(row.row, name);
      states.push(rs);
      if (name.length < 2) rs.error('fullName', 'NAME_REQUIRED', 'Ad soyad en az 2 karakter olmalı');
      else if (name.length > 200) rs.error('fullName', 'NAME_TOO_LONG', 'Ad soyad en çok 200 karakter olabilir');
      for (const key of ['email', 'email2'] as const) {
        const v = cellOf(row, key);
        if (v !== '' && (v.length > 200 || !EMAIL_RE.test(v))) rs.error(key, 'EMAIL_INVALID', `"${v}" geçerli bir e-posta adresi değil`);
      }
      for (const [key, max, label] of [['title', 100, 'Unvan'], ['phone', 40, 'Telefon'], ['phone2', 40, 'Telefon 2'], ['address', 300, 'Adres'], ['note', 1000, 'Not'], ['organization', 200, 'Kurum']] as const) {
        if (cellOf(row, key).length > max) rs.error(key, 'TOO_LONG', `${label} en çok ${max} karakter olabilir`);
      }

      const phones = [cellOf(row, 'phone'), cellOf(row, 'phone2')].map(phoneKey).filter((v): v is string => !!v);
      const emails = [cellOf(row, 'email'), cellOf(row, 'email2')].map(emailKey).filter((v): v is string => !!v);
      if (rs.ok) {
        const inDb = phones.some((k) => takenPhone.has(k)) || emails.some((k) => takenEmail.has(k));
        const inFile = phones.some((k) => seenPhone.has(k)) || emails.some((k) => seenEmail.has(k));
        if (inDb || inFile) {
          const msg = inDb ? 'Aynı telefon ya da e-postaya sahip kişi rehberde zaten var' : 'Aynı telefon ya da e-posta dosyada daha önce geçiyor';
          if (opts.skipDuplicates) rs.skip('DUPLICATE', `${msg}; atlandı`);
          else rs.error('phone', 'DUPLICATE', msg);
        } else {
          phones.forEach((k) => seenPhone.add(k));
          emails.forEach((k) => seenEmail.add(k));
        }
      }

      if (rs.ok) {
        const parsed = createContactSchema.safeParse({
          fullName: name,
          title: cellOf(row, 'title') || undefined,
          phone: cellOf(row, 'phone') || undefined,
          phone2: cellOf(row, 'phone2') || undefined,
          email: cellOf(row, 'email') || undefined,
          email2: cellOf(row, 'email2') || undefined,
          address: cellOf(row, 'address') || undefined,
          tags: normalizeTags(cellOf(row, 'tags')),
          note: cellOf(row, 'note') || undefined,
        });
        if (!parsed.success) for (const issue of parsed.error.issues) rs.error(String(issue.path[0] ?? ''), 'INVALID', `Geçersiz değer: ${issue.message}`);
        else {
          const org = cellOf(row, 'organization');
          if (org !== '' && !orgByName.has(foldKey(org))) rs.warn('organization', 'NEW_ORG', `"${org}" kurumu yeni açılacak`);
          planned.push({ state: rs, input: parsed.data, organization: org });
        }
      }
    }

    const skipped = states.filter((s) => s.status === 'skip').length;
    const newOrgs = new Set(planned.filter((p) => p.organization !== '' && !orgByName.has(foldKey(p.organization))).map((p) => foldKey(p.organization)));
    return {
      rows: states.map((s) => s.preview()),
      general: [],
      summary: [
        { label: 'Oluşturulacak kişi', value: String(planned.length) },
        { label: 'Açılacak yeni kurum', value: String(newOrgs.size) },
        { label: 'Atlanacak satır', value: String(skipped) },
      ],
      apply: async () => {
        const created = new Map(orgByName);
        for (const p of planned) {
          let organizationId: string | null = null;
          if (p.organization !== '') {
            const key = foldKey(p.organization);
            if (!created.has(key)) {
              const [o] = await tx.insert(directoryOrganizations).values({ companyId: company.id, name: p.organization, category: 'Diğer', createdBy: userId }).returning({ id: directoryOrganizations.id });
              created.set(key, o!.id);
            }
            organizationId = created.get(key)!;
          }
          await tx.insert(directoryContacts).values({
            companyId: company.id,
            fullName: p.input.fullName,
            title: p.input.title ?? null,
            organizationId,
            phone: p.input.phone ?? null,
            phone2: p.input.phone2 ?? null,
            email: p.input.email ?? null,
            email2: p.input.email2 ?? null,
            address: p.input.address ?? null,
            tags: p.input.tags ?? [],
            note: p.input.note ?? null,
            createdBy: userId,
          });
        }
        return { created: planned.length, skipped, summary: [{ label: 'Oluşturulan kişi', value: String(planned.length) }, { label: 'Açılan yeni kurum', value: String(newOrgs.size) }], entries: [] };
      },
    };
  },
};
