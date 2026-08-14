/**
 * Bounded concurrency for independent async work, such as one repository's
 * plan not needing to wait for another's.
 */

/** The concurrency used when nothing more specific is configured. */
export const DEFAULT_CONCURRENCY = 4;

/**
 * Run `fn` over every item with at most `limit` in flight at once, returning
 * results in input order regardless of which one finishes first.
 *
 * Order is part of the contract, not an accident of `Promise.all`: two runs
 * over the same input must produce the same output order even though network
 * timing never repeats exactly.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const bounded = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: bounded }, worker));
  return results;
}
