import { z } from 'zod';

export const registerSchema = z.object({
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  password: z.string().min(10, 'Şifre en az 10 karakter olmalı').max(200),
  fullName: z.string().trim().min(2).max(120),
  organizationName: z.string().trim().min(2).max(160),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;
