// A seeded pseudo-random generator for the model-based tests (planning/core.md, Layer 2): the same seed gives the same
// sequence, so a failing run is replayed from the seed that is printed.

/** mulberry32: a 32-bit generator, a function that gives the next number in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Helpers over a generator. */
export function rng(seed: number) {
  const next = mulberry32(seed);
  return {
    next,
    /** An integer in [0, n). */
    int: (n: number): number => Math.floor(next() * n),
    /** One element of a non-empty list. */
    pick<T>(xs: readonly T[]): T {
      return xs[Math.floor(next() * xs.length)]!;
    },
    /** `true` with probability p. */
    chance: (p: number): boolean => next() < p,
    /** The list in a random order (Fisher-Yates), as a copy. */
    shuffle<T>(xs: readonly T[]): T[] {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}
