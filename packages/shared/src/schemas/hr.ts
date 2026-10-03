import { z } from 'zod';
import { isoDate, pageParams } from './common';

export const EMPLOYEE_STATUSES = ['active', 'left'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];
export const EMPLOYEE_ID_KINDS = ['national_id', 'passport'] as const;
export const SENSITIVE_FIELDS = ['id_number', 'birth_date', 'iban'] as const;
export type SensitiveField = (typeof SENSITIVE_FIELDS)[number];

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).nullable().optional();

const employeeBody = {
  fullName: text(200).min(2, 'Ad soyad gerekli'),
  nationality: optText(80),
  idKind: z.enum(EMPLOYEE_ID_KINDS).nullable().optional(),
  /** Kimlik / pasaport numarası (açık metin yalnızca istekte; saklanırken şifrelenir). */
  idNumber: z.string().trim().min(4, 'Kimlik numarası çok kısa').max(40).nullable().optional(),
  birthDate: isoDate.nullable().optional(),
  iban: z
    .string()
    .trim()
    .transform((v) => v.replace(/\s+/g, '').toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/, 'Geçersiz IBAN'))
    .nullable()
    .optional(),
  phone: optText(40),
  email: z.string().trim().email('Geçersiz e-posta').max(200).nullable().optional(),
  address: optText(300),
  hireDate: isoDate.nullable().optional(),
  department: optText(100),
  jobTitle: optText(100),
  projectId: z.string().uuid().nullable().optional(),
  note: optText(500),
};

export const createEmployeeSchema = z.object(employeeBody).superRefine((v, ctx) => {
  if (v.idNumber && !v.idKind) ctx.addIssue({ code: 'custom', path: ['idKind'], message: 'Kimlik türü seçilmeli' });
});
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

export const updateEmployeeSchema = z.object(employeeBody).partial();
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

export const employeeListQuerySchema = z.object({
  ...pageParams(2000, 5000),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
});

export const terminateEmployeeSchema = z.object({ leaveDate: isoDate });
export const rehireEmployeeSchema = z.object({ hireDate: isoDate.optional() });

/** Hassas alanın açık okunması: gerekçe zorunludur ve denetim günlüğüne yazılır. */
export const revealFieldSchema = z.object({
  field: z.enum(SENSITIVE_FIELDS),
  reason: text(300).min(3, 'Gerekçe gerekli (en az 3 karakter)'),
});
export const exportEmployeeDataSchema = z.object({ reason: text(300).min(3, 'Gerekçe gerekli (en az 3 karakter)') });

export const DSR_KINDS = ['access', 'export', 'correction', 'erasure'] as const;
export type DsrKind = (typeof DSR_KINDS)[number];
export const createDsrSchema = z
  .object({
    employeeId: z.string().uuid().nullable().optional(),
    /** Rehber kişisi (X6): talep personele ya da rehber kişisine yönelir, ikisine birden değil. */
    contactId: z.string().uuid().nullable().optional(),
    requesterName: text(200).min(2, 'Talep eden gerekli'),
    kind: z.enum(DSR_KINDS),
    description: optText(1000),
  })
  .refine((v) => !(v.employeeId && v.contactId), { message: 'Talep personele ya da rehber kişisine yönelir, ikisine birden değil', path: ['contactId'] });
export const resolveDsrSchema = z.object({
  outcome: z.enum(['completed', 'rejected']),
  resolutionNote: text(1000).min(3, 'Sonuç notu gerekli'),
});

export const INVENTORY_CATEGORIES = ['identity', 'contact', 'financial', 'employment', 'other'] as const;
export const updateInventorySchema = z
  .object({
    purpose: text(300).min(3),
    legalBasis: text(300).min(3),
    retention: optText(200),
    transferAbroad: z.boolean(),
    note: optText(500),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'En az bir alan verilmeli');
export const verifyInventorySchema = z.object({ note: optText(500) });
