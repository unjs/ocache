// Assembles one run: fresh state, one load pass, one row of results.
//
// Every run rebuilds the origin, the storage, and the key generator from the same seed, so
// a baseline row and a cached row differ only in whether ocache is in the path.

import { createOrigin } from "./origin.ts";
import { createProcessMeter } from "./metrics.ts";
import { createProfiledStorage, createRoutedStorage, PROFILES } from "./storage.ts";
import { createRng } from "./random.ts";
import { runLoad } from "./driver.ts";

import type { DriverResult, LoadSpec } from "./driver.ts";
import type { ProcessSample } from "./metrics.ts";
import type { Mode, Scenario } from "./scenario.ts";
import type { StorageStats } from "./storage.ts";
import type { ProfileName } from "./storage.ts";

export interface RunRow {
  scenario: string;
  mode: Mode;
  profile: ProfileName | "-";
  offeredRps: number;
  achievedRps: number;
  completed: number;
  errors: number;
  shed: number;
  overloaded: boolean;
  p50: number;
  p90: number;
  p99: number;
  p999: number;
  max: number;
  mean: number;
  /** Origin invocations, foreground and background, during the measured window. */
  originCalls: number;
  originPeak: number;
  originQueuedMs: number;
  /** Share of measured requests that did not reach the origin. */
  offload: number;
  status: {
    hit: number;
    stale: number;
    revalidated: number;
    miss: number;
    bypass: number;
    notModified: number;
  };
  storage: StorageStats;
  process: ProcessSample;
  /** Main-thread CPU per measured request, in milliseconds. */
  cpuPerRequestMs: number;
}

export interface RunOptions {
  seed: number;
  spec: LoadSpec;
  /**
   * Requests issued before the timed phase to establish steady-state cache contents.
   *
   * A working set of thousands of keys never fills inside a short measured window, so
   * without this the reported hit ratio measures the run length rather than the traffic
   * distribution. Both origin and storage run instant during prewarm: the point is the
   * resulting cache state, not the cost of reaching it. Baseline runs prewarm too, so the
   * key sequence the timed phase sees is identical in both modes.
   */
  prewarm?: number;
}

export async function runOnce(
  scenario: Scenario,
  mode: Mode,
  profile: ProfileName,
  opts: RunOptions,
): Promise<RunRow> {
  const rng = createRng(opts.seed);
  const origin = createOrigin(scenario.origin, createRng(opts.seed ^ 0x9e_37_79_b9));
  const background: Promise<unknown>[] = [];

  const backendRng = createRng(opts.seed ^ 0x85_eb_ca_6b);
  const backend = createProfiledStorage(PROFILES[profile], {
    rng: backendRng,
    maxBytes: scenario.memory?.maxBytes,
    maxSize: scenario.memory?.maxSize,
  });
  const l1 =
    mode === "tiered"
      ? createProfiledStorage(PROFILES.memory, {
          rng: backendRng,
          maxBytes: scenario.memory?.maxBytes,
          maxSize: scenario.memory?.maxSize,
        })
      : undefined;

  const tiers = scenario.tiers;
  const storage =
    l1 && tiers
      ? createRoutedStorage([
          [tiers[0]!, l1],
          [tiers[1] ?? "/", backend],
        ])
      : backend;
  const base = mode === "tiered" && tiers ? tiers : "/cache";

  const runner = scenario.create({
    mode,
    rng,
    origin,
    storage,
    base,
    waitUntil: (promise) => {
      background.push(promise);
      promise.catch(() => {});
    },
  });

  const prewarm = mode === "baseline" ? (opts.prewarm ?? 0) : (opts.prewarm ?? 0);
  if (prewarm > 0) {
    origin.instant = true;
    backend.instant = true;
    if (l1) l1.instant = true;
    for (let i = 0; i < prewarm; i++) {
      await runner(i);
    }
    // Let the writes those requests started land before the timed phase begins.
    await Promise.allSettled(background.splice(0, background.length));
    origin.instant = false;
    backend.instant = false;
    if (l1) l1.instant = false;
  }

  const meter = createProcessMeter();
  const result: DriverResult = await runLoad({
    spec: opts.spec,
    rng: createRng(opts.seed ^ 0xc2_b2_ae_35),
    request: runner,
    background,
    onWarmupEnd: () => {
      // Everything before this point primed the cache and the JIT.
      origin.reset();
      backend.reset();
      l1?.reset();
      meter.reset();
    },
  });
  const process_ = meter.read();
  meter.stop();

  const [p50, p90, p99, p999, max] = result.latency.percentiles([0.5, 0.9, 0.99, 0.999, 1]);
  const measured = result.latency.count;
  const storageStats = mergeStats(backend.stats, l1?.stats);

  return {
    scenario: scenario.id,
    mode,
    profile: mode === "baseline" ? "-" : profile,
    offeredRps: result.offeredRps,
    achievedRps: result.achievedRps,
    completed: measured,
    errors: result.errors,
    shed: result.shed,
    overloaded: result.overloaded,
    p50: p50!,
    p90: p90!,
    p99: p99!,
    p999: p999!,
    max: max!,
    mean: result.latency.mean(),
    originCalls: origin.calls,
    originPeak: origin.peak,
    originQueuedMs: origin.queuedMs,
    offload: measured === 0 ? 0 : Math.max(0, 1 - origin.calls / measured),
    status: {
      hit: result.status.hit,
      stale: result.status.stale,
      revalidated: result.status.revalidated,
      miss: result.status.miss,
      bypass: result.status.bypass,
      notModified: result.status.notModified,
    },
    storage: storageStats,
    process: process_,
    cpuPerRequestMs: measured === 0 ? 0 : process_.cpuMs / measured,
  };
}

function mergeStats(a: StorageStats, b?: StorageStats): StorageStats {
  if (!b) return a;
  return {
    reads: a.reads + b.reads,
    readHits: a.readHits + b.readHits,
    writes: a.writes + b.writes,
    deletes: a.deletes + b.deletes,
    readMs: a.readMs + b.readMs,
    writeMs: a.writeMs + b.writeMs,
    bytesWritten: a.bytesWritten + b.bytesWritten,
    evicted: a.evicted + b.evicted,
  };
}

/**
 * Steps the offered rate until the run stops keeping up.
 *
 * The knee is the honest capacity number: the highest offered rate the configuration
 * sustains with a p99 under the budget and no meaningful arrival backlog.
 */
export async function runRamp(
  scenario: Scenario,
  mode: Mode,
  profile: ProfileName,
  opts: {
    seed: number;
    steps: number[];
    p99BudgetMs: number;
    durationMs: number;
    prewarm?: number;
  },
): Promise<{ sustainedRps: number; rows: RunRow[] }> {
  const rows: RunRow[] = [];
  let sustained = 0;
  for (const rps of opts.steps) {
    const row = await runOnce(scenario, mode, profile, {
      seed: opts.seed,
      spec: { rps, durationMs: opts.durationMs, warmupMs: Math.min(2000, opts.durationMs) },
      prewarm: opts.prewarm,
    });
    rows.push(row);
    const keptUp = row.achievedRps >= rps * 0.9 && row.p99 <= opts.p99BudgetMs && !row.overloaded;
    if (!keptUp) break;
    sustained = rps;
  }
  return { sustainedRps: sustained, rows };
}
