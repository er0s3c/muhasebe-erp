import { AsyncLocalStorage } from 'node:async_hooks';
import { COMPANY_TIME_ZONE, setCompanyTimeZoneResolver } from '@erp/shared';

const companyClock = new AsyncLocalStorage<string>();

// Her isteğin saati kendi async zincirinde kalır; paralel şirketler birbirini etkilemez.
setCompanyTimeZoneResolver(() => companyClock.getStore() ?? COMPANY_TIME_ZONE);

export function withCompanyTimeZone<T>(timeZone: string | null | undefined, work: () => T): T {
  return companyClock.run(timeZone || COMPANY_TIME_ZONE, work);
}
