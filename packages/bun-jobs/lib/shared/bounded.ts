/**
 * How many backend calls a namespace-wide fan-out in the library makes at
 * once. Small on purpose: the fan-outs run on the driver the workers claim
 * through, and a dashboard poll that opened one query per queue at once
 * could take a small pool away from them.
 */
export const FAN_OUT_LIMIT = 8;

/**
 * Maps `items` through `fn` with at most `limit` calls in flight, keeping the
 * results in the items' order. A pool rather than fixed batches, so one slow
 * call holds up one slot, not the whole batch behind it. Rejects with the
 * first error; calls already started are left to finish.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number = FAN_OUT_LIMIT,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;

  const lanes = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!, index);
      }
    },
  );

  await Promise.all(lanes);
  return results;
}
