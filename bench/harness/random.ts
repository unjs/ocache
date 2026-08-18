// Seeded generators. Every run must be reproducible: the same seed has to produce the
// same key sequence, the same arrival times, and the same latency samples, or a
// baseline run and a cached run are not comparable.

export type Rng = () => number;

/** mulberry32: small state, good enough distribution for load shaping. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Standard normal via Box-Muller. */
export function normal(rng: Rng): number {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Exponential inter-arrival time for a Poisson process of `rate` events per second. */
export function exponentialMs(rng: Rng, ratePerSecond: number): number {
  return (-Math.log(1 - rng()) / ratePerSecond) * 1000;
}

/**
 * Samples a lognormal latency fitted to a median and a p99.
 *
 * Storage and network round trips are right-skewed; a fixed delay would hide exactly the
 * tail that decides whether caching helps.
 */
export function lognormal(rng: Rng, p50: number, p99: number): number {
  if (p50 <= 0) return 0;
  // z(0.99) = 2.3263
  const sigma = p99 > p50 ? Math.log(p99 / p50) / 2.326_3 : 0;
  return sigma === 0 ? p50 : p50 * Math.exp(sigma * normal(rng));
}

/**
 * Draws from a Zipf distribution over `n` keys.
 *
 * Real traffic is neither uniform nor single-key. The exponent controls how much of the
 * load the head absorbs, which is what actually sets the achievable hit ratio.
 */
export function createZipf(rng: Rng, n: number, exponent: number): () => number {
  const cdf = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += 1 / Math.pow(i + 1, exponent);
    cdf[i] = total;
  }
  for (let i = 0; i < n; i++) cdf[i] = cdf[i]! / total;
  return () => {
    const u = rng();
    // Binary search the CDF.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid]! < u) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}
