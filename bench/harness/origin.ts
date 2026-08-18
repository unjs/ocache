// The thing being cached.
//
// Two costs are modelled separately because they behave differently under load:
// `ioMs` waits and yields the loop, so an unbounded origin serves it concurrently and
// caching it buys latency only; `cpuMs` blocks, so caching it buys capacity. Real
// handlers mix both, and a benchmark that models only one of them lies about the win.
//
// `concurrency` is the third axis: a connection pool, a render worker pool, or an
// upstream rate limit. Once offered load passes it, queueing dominates and the value of
// caching stops being about per-call cost at all.

import { burnCpu, delay } from "./clock.ts";
import { lognormal } from "./random.ts";

import type { Rng } from "./random.ts";

export interface OriginSpec {
  /** Median non-blocking wait, in milliseconds. */
  ioMs: number;
  /** p99 of that wait. Defaults to 3x the median. */
  ioP99?: number;
  /** Blocking main-thread work, in milliseconds. */
  cpuMs: number;
  /** Concurrent invocations allowed. `Infinity` for an unbounded origin. */
  concurrency: number;
}

export interface Origin {
  /**
   * Skips both costs.
   *
   * Prewarm establishes the cache state a steady-state server would already hold; paying
   * the origin's real cost for it would only measure the warm-up.
   */
  instant: boolean;
  /** Foreground and background invocations that reached the origin. */
  calls: number;
  /** Peak simultaneous invocations observed. */
  peak: number;
  /** Time spent queueing for a slot, in milliseconds. */
  queuedMs: number;
  run<T>(produce: () => T): Promise<T>;
  reset(): void;
}

export function createOrigin(spec: OriginSpec, rng: Rng): Origin {
  const ioP99 = spec.ioP99 ?? spec.ioMs * 3;
  const limit = spec.concurrency;
  let active = 0;
  const waiting: Array<() => void> = [];

  const origin: Origin = {
    instant: false,
    calls: 0,
    peak: 0,
    queuedMs: 0,
    reset() {
      origin.calls = 0;
      origin.peak = 0;
      origin.queuedMs = 0;
    },
    async run(produce) {
      origin.calls++;
      if (origin.instant) {
        return produce();
      }
      if (Number.isFinite(limit) && active >= limit) {
        const queuedAt = performance.now();
        await new Promise<void>((resolve) => waiting.push(resolve));
        origin.queuedMs += performance.now() - queuedAt;
      }
      active++;
      if (active > origin.peak) origin.peak = active;
      try {
        if (spec.ioMs > 0) await delay(lognormal(rng, spec.ioMs, ioP99));
        burnCpu(spec.cpuMs);
        return produce();
      } finally {
        active--;
        waiting.shift()?.();
      }
    },
  };
  return origin;
}
