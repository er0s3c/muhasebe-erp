export interface QuantityTime { at: string; quantity: number }

/** FIFO, quantity-weighted receive-to-first-start time; missing MES evidence remains unmeasured. */
export function processingQueue(
  arrivals: readonly QuantityTime[],
  starts: readonly QuantityTime[],
  now: number,
) {
  const valid = (r: QuantityTime) => Number.isFinite(Date.parse(r.at)) && Number.isFinite(r.quantity) && r.quantity > 0;
  const received = arrivals.filter(valid).map(r => ({ ...r })).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const work = starts.filter(valid).map(r => ({ ...r })).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let minutes = 0, measuredQty = 0, waitingMinutes = 0, waitingQty = 0;
  for (const arrival of received) {
    let left = arrival.quantity;
    for (const session of work) {
      if (session.quantity <= 0 || Date.parse(session.at) < Date.parse(arrival.at)) continue;
      const taken = Math.min(left, session.quantity);
      minutes += taken * (Date.parse(session.at) - Date.parse(arrival.at)) / 60_000;
      measuredQty += taken;
      left -= taken;
      session.quantity -= taken;
      if (left <= 0) break;
    }
    waitingQty += left;
    waitingMinutes += left * Math.max(0, now - Date.parse(arrival.at)) / 60_000;
  }
  return {
    source: 'transfer_receive_to_mes_start',
    measuredQty,
    averageMinutes: measuredQty ? minutes / measuredQty : null,
    unmeasuredQty: waitingQty,
    averageOpenMinutes: waitingQty ? waitingMinutes / waitingQty : null,
  };
}
