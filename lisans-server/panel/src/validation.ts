import { ApiError } from './api';

/** Keep server validation beside the original field without changing submitted values. */
export function validationErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_ERROR' || !Array.isArray(error.details)) return {};
  return Object.fromEntries(error.details.flatMap((detail: unknown) => {
    if (!detail || typeof detail !== 'object') return [];
    const { path, message } = detail as { path?: unknown; message?: unknown };
    const key = Array.isArray(path) ? path.join('.') : typeof path === 'string' ? path : '';
    return key && typeof message === 'string' ? [[key, message]] : [];
  }));
}

export function focusValidationError(form: HTMLFormElement | null) {
  requestAnimationFrame(() => {
    const input = form?.querySelector<HTMLElement>('[aria-invalid="true"]');
    input?.focus();
    input?.scrollIntoView({ block: 'nearest' });
  });
}
