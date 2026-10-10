/** Splits items into batches of at most `size` (migration calls accept at most 5 items). */
export function toBatches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
