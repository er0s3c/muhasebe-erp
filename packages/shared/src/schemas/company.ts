import { z } from 'zod';
import { SECTORS } from '../module-registry';
import { ROLES } from '../permissions';
import { currencyCode } from './common';

export const createCompanySchema = z.object({
  name: z.string().trim().min(2).max(160),
  sector: z.enum(SECTORS),
  baseCurrency: currencyCode.default('TRY'),
  /** Yönetim raporlama para birimi; boş bırakılırsa raporlama tutarı tutulmaz. */
  reportingCurrency: currencyCode.nullable().default('GBP'),
  taxNumber: z.string().trim().max(40).optional(),
  taxOffice: z.string().trim().max(120).optional(),
});
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  taxNumber: z.string().trim().max(40).nullable().optional(),
  taxOffice: z.string().trim().max(120).nullable().optional(),
});
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

export const addMemberSchema = z.object({
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  fullName: z.string().trim().min(2).max(120),
  role: z.enum(ROLES),
  /** İlk şifre; kullanıcı ilk girişte değiştirmelidir. Mevcut (aynı kuruluştaki) kullanıcı eklenirken yok sayılır. */
  password: z.string().min(10).max(200).optional(),
});
export type AddMemberInput = z.infer<typeof addMemberSchema>;

export const updateMemberSchema = z.object({ role: z.enum(ROLES) });
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10, 'Şifre en az 10 karakter olmalı').max(200),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
