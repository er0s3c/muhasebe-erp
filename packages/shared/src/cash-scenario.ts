import { z } from 'zod';
import { dec } from './money';
export const cashScenarioSchema = z.object({
  name: z.string().trim().min(2).max(120),
  delayDays: z.number().int().min(0).max(365),
  outflowIncreasePct: z.number().min(0).max(500),
  weeks: z.number().int().min(1).max(26).default(13),
});
export type CashScenarioInput = z.infer<typeof cashScenarioSchema>;
type Source = {
  from: string;
  weeks: number;
  opening: string;
  later: { receivables: string; payables: string };
  items: { date: string; direction: 'in' | 'out'; amountBase: string }[];
};
export function projectCashScenario(
  source: Source,
  assumptions: Pick<CashScenarioInput, 'delayDays' | 'outflowIncreasePct'>,
) {
  const add = (iso: string, n: number) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const buckets = Array.from({ length: source.weeks }, (_, i) => ({
    week: i + 1,
    start: add(source.from, i * 7),
    end: add(source.from, i * 7 + 6),
    inflow: dec(0),
    outflow: dec(0),
  }));
  let movedIn = dec(0),
    movedOut = dec(0);
  for (const item of source.items) {
    // An already overdue receipt is assumed collectible today before applying the extra delay.
    const date = add(
      item.date < source.from ? source.from : item.date,
      item.direction === 'in' ? assumptions.delayDays : 0,
    );
    const amount = dec(item.amountBase).times(
      item.direction === 'out' ? dec(1).plus(dec(assumptions.outflowIncreasePct).div(100)) : 1,
    );
    const bucket = buckets.find((b) => date <= b.end);
    if (!bucket) {
      if (item.direction === 'in') movedIn = movedIn.plus(amount);
      else movedOut = movedOut.plus(amount);
      continue;
    }
    if (item.direction === 'in') bucket.inflow = bucket.inflow.plus(amount);
    else bucket.outflow = bucket.outflow.plus(amount);
  }
  let balance = dec(source.opening);
  let lowest = balance;
  const rows = buckets.map((b) => {
    const net = b.inflow.minus(b.outflow);
    balance = balance.plus(net);
    if (balance.lt(lowest)) lowest = balance;
    return {
      week: b.week,
      start: b.start,
      end: b.end,
      inflow: b.inflow.toFixed(2),
      outflow: b.outflow.toFixed(2),
      net: net.toFixed(2),
      closing: balance.toFixed(2),
    };
  });
  return {
    buckets: rows,
    lowest: lowest.toFixed(2),
    closing: balance.toFixed(2),
    movedBeyondHorizon: { inflow: movedIn.toFixed(2), outflow: movedOut.toFixed(2) },
    baselineBeyondHorizon: source.later,
  };
}
