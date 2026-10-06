import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST') => new ApiError(400, code, message);
export const unauthorized = (message = 'Oturum geçersiz veya süresi dolmuş', code = 'UNAUTHORIZED') => new ApiError(401, code, message);
export const forbidden = (message: string, code = 'FORBIDDEN') => new ApiError(403, code, message);
export const notFound = (message: string, code = 'NOT_FOUND') => new ApiError(404, code, message);
export const conflict = (message: string, code = 'CONFLICT') => new ApiError(409, code, message);

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ApiError) {
    return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
  }
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'İstek geçersiz', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
  }
  // Veritabanı koruma tetikleyicileri (LIC0x) iş kuralı ihlalidir
  const pgCode = (err as { cause?: { code?: unknown } }).cause?.code ?? (err as { code?: unknown }).code;
  if (typeof pgCode === 'string' && /^LIC\d\d$/.test(pgCode)) {
    const msg = (err as { cause?: { message?: string } }).cause?.message ?? err.message;
    return reply.code(422).send({ error: { code: 'RULE_VIOLATION', message: msg } });
  }
  const fe = err as FastifyError;
  if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
    return reply.code(fe.statusCode).send({ error: { code: fe.code ?? 'BAD_REQUEST', message: fe.message } });
  }
  req.log.error({ err }, 'beklenmeyen hata');
  return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Beklenmeyen bir hata oluştu' } });
}
