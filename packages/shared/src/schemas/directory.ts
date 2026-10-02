import { z } from 'zod';
import { isoDate, uuid } from './common';

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).nullable().optional();
const timeHm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Saat SS:DD biçiminde olmalı');
const optEmail = z.string().trim().email('Geçersiz e-posta').max(200).nullable().optional();
const optUuid = uuid.nullable().optional();
const tagList = z.array(z.string().trim().min(1).max(40)).max(20);

/** Kategori kullanıcı yönetimli serbest metindir; bunlar arayüzde öneri olarak sunulur. */
export const DIRECTORY_ORG_CATEGORY_HINTS = ['Banka', 'Kamu kurumu', 'Tedarikçi', 'Müşteri', 'Danışman', 'Diğer'] as const;

const orgBody = {
  name: text(200).min(2, 'Kurum adı gerekli'),
  category: text(60).min(1),
  address: optText(300),
  phone: optText(40),
  email: optEmail,
  web: optText(200),
  partyId: optUuid,
  note: optText(1000),
};
export const createOrganizationSchema = z.object({ ...orgBody, category: orgBody.category.default('Diğer') });
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export const updateOrganizationSchema = z.object(orgBody).partial();

export const ARCHIVE_FILTERS = ['active', 'archived', 'all'] as const;
export const organizationListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(60).optional(),
  archived: z.enum(ARCHIVE_FILTERS).default('active'),
  partyId: uuid.optional(),
});

const contactBody = {
  fullName: text(200).min(2, 'Ad soyad gerekli'),
  title: optText(100),
  organizationId: optUuid,
  phone: optText(40),
  phone2: optText(40),
  email: optEmail,
  email2: optEmail,
  address: optText(300),
  partyId: optUuid,
  employeeId: optUuid,
  projectId: optUuid,
  tags: tagList.optional(),
  note: optText(1000),
};
export const createContactSchema = z.object(contactBody);
export type CreateContactInput = z.infer<typeof createContactSchema>;
export const updateContactSchema = z.object(contactBody).partial();
export type UpdateContactInput = z.infer<typeof updateContactSchema>;

export const contactListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  tag: z.string().trim().max(40).optional(),
  organizationId: uuid.optional(),
  /** Cariye bağlı kişiler (kişinin kendi bağlantısı ya da kurumunun cari bağlantısı). */
  partyId: uuid.optional(),
  projectId: uuid.optional(),
  archived: z.enum(ARCHIVE_FILTERS).default('active'),
});
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;

export const duplicateQuerySchema = z.object({
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().max(200).optional(),
  excludeId: uuid.optional(),
});
export const mergeContactSchema = z.object({ mergeId: uuid });
export const anonymizeContactSchema = z.object({ reason: text(300).min(3, 'Gerekçe gerekli (en az 3 karakter)') });
export const exportContactDataSchema = z.object({ reason: text(300).min(3, 'Gerekçe gerekli (en az 3 karakter)') });

export const NOTE_KINDS = ['call', 'meeting', 'email', 'other'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_VISIBILITIES = ['private', 'shared'] as const;
export type NoteVisibility = (typeof NOTE_VISIBILITIES)[number];

export const createNoteSchema = z
  .object({
    contactId: optUuid,
    organizationId: optUuid,
    kind: z.enum(NOTE_KINDS),
    noteDate: isoDate,
    summary: text(4000).min(1, 'Özet gerekli'),
    visibility: z.enum(NOTE_VISIBILITIES).default('private'),
    projectId: optUuid,
  })
  .refine((v) => !!v.contactId || !!v.organizationId, { message: 'Kişi ya da kurum seçilmeli', path: ['contactId'] });
export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export const updateNoteSchema = z
  .object({ kind: z.enum(NOTE_KINDS), noteDate: isoDate, summary: text(4000).min(1, 'Özet gerekli'), visibility: z.enum(NOTE_VISIBILITIES) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'En az bir alan verilmeli');
export const noteListQuerySchema = z.object({ contactId: uuid.optional(), organizationId: uuid.optional(), projectId: uuid.optional() });

export const AGENDA_KINDS = ['task', 'appointment'] as const;
export type AgendaKind = (typeof AGENDA_KINDS)[number];
export const AGENDA_STATUSES = ['open', 'done', 'cancelled'] as const;
export type AgendaStatus = (typeof AGENDA_STATUSES)[number];

const agendaBody = {
  kind: z.enum(AGENDA_KINDS),
  title: text(200).min(1, 'Başlık gerekli'),
  description: optText(1000),
  dueDate: isoDate,
  allDay: z.boolean(),
  startTime: timeHm.nullable().optional(),
  endTime: timeHm.nullable().optional(),
  /** Hatırlatma ofseti (dakika): yalnızca veridir, bildirim gönderilmez. */
  remindBeforeMinutes: z.number().int().min(0).max(43200).nullable().optional(),
  /** Verilmezse oturumdaki kullanıcı; null = şirket ajandası (directory.manage). */
  ownerId: uuid.nullable().optional(),
  contactId: optUuid,
  organizationId: optUuid,
  partyId: optUuid,
  projectId: optUuid,
};
const timeRule = (v: { allDay?: boolean; startTime?: string | null; endTime?: string | null }, ctx: z.RefinementCtx) => {
  if (v.allDay === false && !v.startTime) ctx.addIssue({ code: 'custom', path: ['startTime'], message: 'Saatli kalem için başlangıç saati gerekli' });
  if (v.startTime && v.endTime && v.endTime <= v.startTime) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'Bitiş saati başlangıçtan sonra olmalı' });
};
export const createAgendaSchema = z.object({ ...agendaBody, kind: agendaBody.kind.default('task'), allDay: agendaBody.allDay.default(true) }).superRefine(timeRule);
export type CreateAgendaInput = z.infer<typeof createAgendaSchema>;
export const updateAgendaSchema = z.object(agendaBody).partial().superRefine(timeRule);
export const followUpSchema = z.object({
  title: text(200).min(1).optional(),
  dueDate: isoDate,
  ownerId: uuid.nullable().optional(),
  remindBeforeMinutes: z.number().int().min(0).max(43200).nullable().optional(),
});

export const AGENDA_SCOPES = ['mine', 'company', 'all'] as const;
export const agendaListQuerySchema = z.object({
  scope: z.enum(AGENDA_SCOPES).default('mine'),
  status: z.enum(AGENDA_STATUSES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  contactId: uuid.optional(),
  organizationId: uuid.optional(),
  partyId: uuid.optional(),
  projectId: uuid.optional(),
  /** "Bugün" tarihi (varsayılan sunucu günü); gecikmiş/bugün/yaklaşan kovaları buna göre. */
  asOf: isoDate.optional(),
});
export type AgendaListQuery = z.infer<typeof agendaListQuerySchema>;
export const agendaSummaryQuerySchema = z.object({ scope: z.enum(AGENDA_SCOPES).default('mine'), asOf: isoDate.optional() });

export const directoryImportOptionsSchema = z.object({
  skipDuplicates: z.boolean().default(true),
  numberFormat: z.enum(['auto', 'tr', 'en']).default('auto'),
});
