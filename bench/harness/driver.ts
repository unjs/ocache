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

/** Rounds of nested `waitUntil` work a drain will follow before giving up. */
const BACKGROUND_ROUNDS = 20;

export async function runLoad(opts: {
  spec: LoadSpec;
  rng: Rng;
  request: Request;
  /** Runs after warmup work has drained, before measured arrivals begin. */
  onWarmupEnd?: () => void;
  /** Background promises registered through `waitUntil`. */
  background?: Promise<unknown>[];
  maxInflight?: number;
}): Promise<DriverResult> {
  const { spec, rng, request } = opts;
  const maxInflight = opts.maxInflight ?? 60_000;
  const latency = new Samples();
  const status = new StatusTally();
  const inflightPromises = new Set<Promise<void>>();
  let inflight = 0;
  let requestIndex = 0;

  const drain = async () => {
    while (inflightPromises.size > 0) {
      await Promise.all(inflightPromises);
    }
    // A refresh can register another `waitUntil`, so drain rounds until the queue stays
    // empty. Bounded: work that re-registers forever is a bug in the scenario, and the
    // run should say so rather than hang.
    let rounds = 0;
    while (opts.background && opts.background.length > 0) {
      if (++rounds > BACKGROUND_ROUNDS) {
        console.error(
          `  ! ${opts.background.length} background promises still pending after ${BACKGROUND_ROUNDS} drain rounds; their origin calls are not counted`,
        );
        opts.background.length = 0;
        break;
      }
      const pending = opts.background.splice(0, opts.background.length);
      await Promise.allSettled(pending);
    }
    await settle();
  };

  const runWindow = async (durationMs: number, measured: boolean) => {
    const arrivals: number[] = [];
    for (let t = 0; t < durationMs;) {
      t += exponentialMs(rng, spec.rps);
      if (t < durationMs) arrivals.push(t);
    }

    let completed = 0;
    let errors = 0;
    let shed = 0;
    let overloaded = false;
    const t0 = performance.now();

    const dispatch = (index: number, dueAt: number) => {
      inflight++;
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
        await delay(0);
      }
      if (inflight >= maxInflight) {
        overloaded = true;
        shed++;
        requestIndex++;
        continue;
      }
      dispatch(requestIndex++, dueAt);
    }
    await drain();
    return { completed, errors, shed, overloaded, wallMs: performance.now() - t0 };
  };

  if (spec.warmupMs > 0) {
    await runWindow(spec.warmupMs, false);
  }
  opts.onWarmupEnd?.();
  const measured = await runWindow(spec.durationMs, true);

  return {
    offeredRps: spec.rps,
    achievedRps: (latency.count / spec.durationMs) * 1000,
    completed: measured.completed,
    errors: measured.errors,
    shed: measured.shed,
    overloaded: measured.overloaded,
    latency,
    status,
    wallMs: measured.wallMs,
  };
}
