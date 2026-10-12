import type { ResourceOperation } from '@erp/shared';

/** Koleksiyon POST oluşturur; kayıt iş akışları günceller. Önizleme/açık veri okuma ayrıca salt okunur işaretlenir. */
export function inferResourceOperation(method: string, pattern: string): ResourceOperation | 'read' {
  const last = pattern.split('/').filter(Boolean).at(-1) ?? '';
  if (pattern.startsWith('/api/exports/') || last === 'export') return 'export';
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'read';
  if (method === 'DELETE') return 'delete';
  if (method !== 'POST') return 'update';
  if (['reveal', 'preview', 'eligibility', 'promise'].includes(last) || last.endsWith('-preview')) return 'read';
  if (['approve', 'post', 'cancel', 'calculate', 'pay', 'unpay', 'close', 'reopen', 'verify', 'archive', 'unarchive', 'restore', 'activate', 'deactivate', 'complete', 'hold', 'release', 'start', 'finish', 'stop', 'renew', 'receive', 'issue', 'rebuild', 'revoke', 'confirm', 'submit', 'send', 'reject', 'convert', 'reconcile', 'dispatch', 'deliver', 'accept', 'return', 'pause', 'resume', 'clear', 'reset', 'adjust', 'allocate', 'anonymize', 'apply', 'auto-match', 'award', 'backfill-reporting', 'client-accept', 'client-reject', 'decide', 'decision', 'finalize', 'handover', 'ignore', 'match', 'merge', 'phase', 'publish', 'quality-quantity', 'rehire', 'repay', 'resolve', 'result', 'retry', 'reverse', 'review', 'revise', 'state', 'status', 'terminate', 'unmatch', 'void', 'withdraw', 'geometry'].includes(last)) return 'update';
  return 'create';
}
