// The shuffle of a read's choices (arch 06 line 285: "Low stakes: Haiku twice, choices shuffled"). Each read draws its
// own seed, a 32-bit unsigned integer, and lists the choices in the order that seed gives: a draw without replacement
// over the choices sorted by id, so one seed and one set of choices always give one order, whatever order the frontier
// listed them in. The seed goes into the read's span, so the read can be laid out again exactly.

/** The largest seed: seeds are 32-bit unsigned integers. */
export const SEED_LIMIT = 0xffffffff;

/** A seed is a whole number from 0 to SEED_LIMIT. */
export function isSeed(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= SEED_LIMIT;
}

/** A new seed for one read, from the platform's random source (crypto.getRandomValues, in Node and in Workers). */
export function drawSeed(): number {
  const [seed] = crypto.getRandomValues(new Uint32Array(1));
  return seed ?? 0;
}

/** mulberry32: numbers in [0, 1) from a 32-bit seed; the same seed always gives the same numbers. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The items in the order the seed gives: each draw takes one of those left, so every order is equally likely. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const next = generator(seed);
  const left = [...items];
  const order: T[] = [];
  while (left.length > 0) order.push(...left.splice(Math.floor(next() * left.length), 1));
  return order;
}
