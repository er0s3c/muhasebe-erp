import { describe, expect, it, vi } from 'vitest';
import { temporaryDatabaseError, withDatabaseReadiness } from '../src/db/readiness';
describe('PostgreSQL açılış beklemesi', () => {
  it('Drizzle içindeki starting up hatasından sonra güvenlik kontrolünü yeniden çalıştırır', async () => {
    const check = vi.fn().mockRejectedValueOnce({ cause: { code: '57P03' } }).mockResolvedValue(['RLS issue']);
    const wait = vi.fn(), onRetry = vi.fn();
    expect(await withDatabaseReadiness(check, { wait, onRetry })).toEqual(['RLS issue']);
    expect(check).toHaveBeenCalledTimes(2); expect(wait).toHaveBeenCalledWith(1000); expect(onRetry).toHaveBeenCalledWith(1);
  });
  it('yanlış parola, veritabanı ve SQL hatasını yeniden denemez', async () => {
    for (const code of ['28P01', '3D000', '42P01']) {
      const error = { cause: { code } }, check = vi.fn().mockRejectedValue(error), wait = vi.fn();
      await expect(withDatabaseReadiness(check, { wait })).rejects.toBe(error);
      expect(check).toHaveBeenCalledOnce(); expect(wait).not.toHaveBeenCalled();
    }
  });
  it('bağlantı kesilince sınırlı denemeden sonra özgün hatayı döndürür', async () => {
    const error = new AggregateError([{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }]);
    const check = vi.fn().mockRejectedValue(error), wait = vi.fn();
    await expect(withDatabaseReadiness(check, { attempts: 3, wait })).rejects.toBe(error);
    expect(check).toHaveBeenCalledTimes(3); expect(wait).toHaveBeenCalledTimes(2);
    expect(temporaryDatabaseError(new AggregateError([{ code: 'ECONNREFUSED' }, { code: '28P01' }]))).toBe(false);
  });
});
