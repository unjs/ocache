// What a cache hit costs when nothing else is happening.
//
// A load run cannot answer this: its per-request CPU includes the origin, the driver, and
// the clock pump. This measures the hit path on its own, sequentially, against memory
// storage — key hash, `validate`, `transform`, `deserializeEntry`, `new Response` — and
// subtracts the same loop without ocache in it. The difference is what a hit adds, and it
// is what sets the origin cost below which caching is a loss.

import { defineCachedFunction, defineCachedHandler, createMemoryStorage } from "../../src/index.ts";
import { filler, makeEvent } from "./scenario.ts";

export interface HitCost {
  payloadBytes: number;
  /** Main-thread microseconds per call, handler path. */
  handlerBaselineUs: number;
  handlerCachedUs: number;
  /** Microseconds a hit adds over calling the handler directly. */
  handlerAddedUs: number;
  functionBaselineUs: number;
  functionCachedUs: number;
  functionAddedUs: number;
}

const noop = () => {};

/** Repetitions per measurement. */
const REPEATS = 9;

/**
 * Times the two loops as a pair and reports what the second one adds.
 *
 * The added cost is a small difference between two much larger numbers, so the two sides
 * have to be measured against each other rather than separately: taking each side's own
 * minimum from a different repetition produced a cost curve that fell as the payload
 * grew, which cannot be true. Each repetition measures both sides back to back and keeps
 * their difference; the median of those differences is the estimate, which survives an
 * outlier in either direction. The absolute figures use each side's minimum, because
 * scheduler and GC noise can only add time.
 */
async function timePair(
  baseline: () => Promise<unknown>,
  cached: () => Promise<unknown>,
  iterations: number,
): Promise<{ baselineUs: number; cachedUs: number; addedUs: number }> {
  // Warm both paths before measuring.
  for (let i = 0; i < Math.min(200, iterations); i++) {
    await baseline();
    await cached();
  }
  const measure = async (call: () => Promise<unknown>) => {
    const cpu = process.cpuUsage();
    for (let i = 0; i < iterations; i++) await call();
    const used = process.cpuUsage(cpu);
    return (used.user + used.system) / iterations;
  };

  let bestBaseline = Infinity;
  let bestCached = Infinity;
  const deltas: number[] = [];
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    // Collect before each side so neither pays for the other's garbage. Available only
    // under `--expose-gc`, which `pnpm bench` sets; without it the spread roughly doubles.
    globalThis.gc?.();
    const baselineUs = await measure(baseline);
    globalThis.gc?.();
    const cachedUs = await measure(cached);
    bestBaseline = Math.min(bestBaseline, baselineUs);
    bestCached = Math.min(bestCached, cachedUs);
    deltas.push(cachedUs - baselineUs);
  }
  deltas.sort((a, b) => a - b);
  return {
    baselineUs: bestBaseline,
    cachedUs: bestCached,
    addedUs: deltas[deltas.length >> 1]!,
  };
}

export async function measureHitCost(payloadBytes: number, iterations = 3000): Promise<HitCost> {
  const body = filler(payloadBytes);

  const handler = () => new Response(body, { headers: { "content-type": "text/html" } });
  const cachedHandler = defineCachedHandler(handler, {
    name: "calibrate",
    maxAge: 600,
    storage: createMemoryStorage({ maxBytes: Infinity }),
  });

  const url = "https://bench.example/calibrate";
  // Warm the entry so every measured call is a hit.
  await cachedHandler(makeEvent(url, undefined, noop));

  const handlerCost = await timePair(
    // The baseline builds the same event, so the delta is ocache and nothing else.
    async () => {
      makeEvent(url, undefined, noop);
      const res = handler();
      await res.arrayBuffer();
    },
    async () => {
      const res = (await cachedHandler(makeEvent(url, undefined, noop))) as Response;
      await res.arrayBuffer();
    },
    iterations,
  );

  const produce = () => body;
  const cachedFn = defineCachedFunction(produce, {
    name: "calibrate-fn",
    maxAge: 600,
    getKey: () => "k",
    storage: createMemoryStorage({ maxBytes: Infinity }),
  });
  await cachedFn();

  const functionCost = await timePair(
    async () => {
      produce();
    },
    async () => {
      await cachedFn();
    },
    iterations,
  );

  return {
    payloadBytes,
    handlerBaselineUs: handlerCost.baselineUs,
    handlerCachedUs: handlerCost.cachedUs,
    handlerAddedUs: handlerCost.addedUs,
    functionBaselineUs: functionCost.baselineUs,
    functionCachedUs: functionCost.cachedUs,
    functionAddedUs: functionCost.addedUs,
  };
}
