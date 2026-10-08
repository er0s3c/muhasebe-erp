import {
  capacityIntervalEnd,
  type CapacityInterval,
  type ScheduledOperation,
} from './manufacturing';

/** Count the union of shifts, subtracting every blocked interval once. */
export function netCapacityMinutes(
  calendars: readonly CapacityInterval[],
  resourceId: string,
  from: string,
  to: string,
) {
  const start = Date.parse(from),
    end = Date.parse(to);
  const relevant = calendars.filter(
    (c) =>
      c.resourceId === resourceId && capacityIntervalEnd(c) > start && Date.parse(c.start) < end,
  );
  const cuts = [
    start,
    end,
    ...relevant.flatMap((c) => [
      Math.max(start, Date.parse(c.start)),
      Math.min(end, capacityIntervalEnd(c)),
    ]),
  ].sort((a, b) => a - b);
  let minutes = 0;
  for (let i = 1; i < cuts.length; i++) {
    const a = cuts[i - 1]!,
      b = cuts[i]!;
    if (
      relevant.some(
        (c) => c.available && Date.parse(c.start) <= a && capacityIntervalEnd(c) >= b,
      ) &&
      !relevant.some((c) => !c.available && Date.parse(c.start) < b && capacityIntervalEnd(c) > a)
    )
      minutes += (b - a) / 60000;
  }
  return minutes;
}
export function scheduledLoadMinutes(
  operations: readonly ScheduledOperation[],
  resourceId: string,
  from: string,
  to: string,
) {
  const start = Date.parse(from),
    end = Date.parse(to);
  return operations
    .filter((o) => o.resourceId === resourceId)
    .reduce(
      (total, o) =>
        total +
        (o.segments ?? [o]).reduce(
          (s, p) =>
            s +
            Math.max(0, Math.min(end, Date.parse(p.end)) - Math.max(start, Date.parse(p.start))) /
              60000,
          0,
        ),
      0,
    );
}
