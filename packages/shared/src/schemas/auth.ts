import { z } from 'zod';
import { WEAK_PASSWORD_MESSAGE, isWeakPassword } from '../password';

/** En az 10 karakter, yaygın/tahmin edilebilir olmayan parola (e-posta içermeme denetimi ilgili uçta yapılır). */
export const passwordSchema = z
  .string()
  .min(10, 'Şifre en az 10 karakter olmalı')
  .max(200)
  .refine((v) => !isWeakPassword(v), WEAK_PASSWORD_MESSAGE);

export const registerSchema = z.object({
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  password: passwordSchema,
  fullName: z.string().trim().min(2).max(120),
  organizationName: z.string().trim().min(2).max(160),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  password: z.string().min(1).max(200),
});
export const mfaVerifySchema = z.object({
  mfaToken: z.string().min(20).max(2000),
  /** 6 haneli uygulama kodu ya da kurtarma kodu. */
  code: z.string().trim().min(6).max(20),
});
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({
  email: z.email().max(254).transform((v) => v.toLowerCase()),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) });
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
