// Open-loop load driver.
//
// Arrivals follow a Poisson process at a fixed offered rate and do not wait for earlier
// requests to finish. A closed-loop driver (N workers in a loop) cannot show the thing
// this benchmark exists to show: when the origin saturates, a closed loop simply slows
// its own request rate and reports a flattering tail.
//
// Latency is measured from the *intended* arrival time, not from dispatch. Without that,
// an overloaded run hides its queueing delay behind the driver's own backlog, which is
// the coordinated-omission error.

import { delay, settle } from "./clock.ts";
import { Samples, StatusTally } from "./metrics.ts";
import { exponentialMs } from "./random.ts";

import type { Rng } from "./random.ts";

export interface LoadSpec {
  /** Offered requests per second. */
  rps: number;
  /** Measured window, in milliseconds. */
  durationMs: number;
  /** Unmeasured window before it, in milliseconds. */
  warmupMs: number;
}

export interface Request {
  (index: number): Promise<string | null | undefined>;
}

export interface DriverResult {
  offeredRps: number;
  achievedRps: number;
  completed: number;
  errors: number;
  /** Arrivals abandoned because the in-flight ceiling was reached. */
  shed: number;
  overloaded: boolean;
  latency: Samples;
  status: StatusTally;
  wallMs: number;
}

/** Yield to the loop this often while dispatching a backlog. */
const YIELD_EVERY = 64;

export async function runLoad(opts: {
  spec: LoadSpec;
  rng: Rng;
  request: Request;
  /** Runs once when the warmup window closes, to reset counters. */
  onWarmupEnd?: () => void;
  /** Background promises registered through `waitUntil`. */
  background?: Promise<unknown>[];
  maxInflight?: number;
}): Promise<DriverResult> {
  const { spec, rng, request } = opts;
  const maxInflight = opts.maxInflight ?? 60_000;
  const totalMs = spec.warmupMs + spec.durationMs;

  const arrivals: number[] = [];
  for (let t = 0; t < totalMs;) {
    t += exponentialMs(rng, spec.rps);
    if (t < totalMs) arrivals.push(t);
  }

  const latency = new Samples();
  const status = new StatusTally();
  let completed = 0;
  let errors = 0;
  let shed = 0;
  let inflight = 0;
  let overloaded = false;
  let warmupDone = false;

  const inflightPromises = new Set<Promise<void>>();
  const t0 = performance.now();

  const dispatch = (index: number, dueAt: number) => {
    inflight++;
    const measured = dueAt - t0 >= spec.warmupMs;
    const promise = request(index).then(
      (cacheStatus) => {
        inflight--;
        completed++;
        if (measured) {
          latency.add(performance.now() - dueAt);
          status.record(cacheStatus);
        }
      },
      () => {
        inflight--;
        errors++;
      },
    );
    inflightPromises.add(promise);
    void promise.finally(() => inflightPromises.delete(promise));
  };

  for (let i = 0; i < arrivals.length; i++) {
    const dueAt = t0 + arrivals[i]!;
    const ahead = dueAt - performance.now();
    if (ahead > 0.2) {
      await delay(ahead);
    } else if (i % YIELD_EVERY === 0) {
      // Behind schedule: still yield, or the driver starves the work it is measuring.
      await delay(0);
    }
    if (!warmupDone && arrivals[i]! >= spec.warmupMs) {
      warmupDone = true;
      opts.onWarmupEnd?.();
    }
    if (inflight >= maxInflight) {
      overloaded = true;
      shed++;
      continue;
    }
    dispatch(i, dueAt);
  }

  // Drain in-flight work, then the background revalidations it started. SWR is only
  // honest if its `waitUntil` work is counted; otherwise it looks free.
  while (inflightPromises.size > 0) {
    await Promise.all(inflightPromises);
  }
  if (opts.background) {
    for (let i = 0; i < 10 && opts.background.length > 0; i++) {
      const pending = opts.background.splice(0, opts.background.length);
      await Promise.allSettled(pending);
    }
  }
  await settle();

  const wallMs = performance.now() - t0;
  return {
    offeredRps: spec.rps,
    achievedRps: (latency.count / spec.durationMs) * 1000,
    completed,
    errors,
    shed,
    overloaded,
    latency,
    status,
    wallMs,
  };
}
