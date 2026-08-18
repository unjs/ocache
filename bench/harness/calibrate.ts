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
const REPEATS = 10;

/**
 * Times the two loops as a pair and reports what the second one adds.
 *
 * The added cost is a small difference between two much larger numbers, so the two sides
 * have to be measured against each other rather than separately: taking each side's own
 * minimum from a different repetition produced a cost curve that fell as the payload
 * grew, which cannot be true. Each repetition measures both sides back to back and keeps
 * their difference; the median pair is the estimate, which survives an outlier in either
 * direction. Measurement order alternates so positional drift does not belong to one side.
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

  const pairs: Array<{ baselineUs: number; cachedUs: number; addedUs: number }> = [];
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    // Collect before each side so neither pays for the other's garbage. Available only
    // under `--expose-gc`, which `pnpm bench` sets; without it the spread roughly doubles.
    let baselineUs: number;
    let cachedUs: number;
    if (repeat % 2 === 0) {
      globalThis.gc?.();
      baselineUs = await measure(baseline);
      globalThis.gc?.();
      cachedUs = await measure(cached);
    } else {
      globalThis.gc?.();
      cachedUs = await measure(cached);
      globalThis.gc?.();
      baselineUs = await measure(baseline);
    }
    pairs.push({ baselineUs, cachedUs, addedUs: cachedUs - baselineUs });
  }
  pairs.sort((a, b) => a.addedUs - b.addedUs);
  const lower = pairs[REPEATS / 2 - 1]!;
  const upper = pairs[REPEATS / 2]!;
  const baselineUs = (lower.baselineUs + upper.baselineUs) / 2;
  const cachedUs = (lower.cachedUs + upper.cachedUs) / 2;
  return { baselineUs, cachedUs, addedUs: cachedUs - baselineUs };
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
