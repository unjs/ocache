// 7. Fan-out aggregation (cached function) over a tiered store.
//
// Three upstream calls in parallel, so the resolver is dominated by the slowest of them.
// A short `maxAge` with a long stale window means most reads land in the stale window:
// the caller is served immediately and the refresh runs in the background, which is the
// only configuration in this set where cached p99 can beat the origin's own p50.
//
// This scenario also carries the multi-tier measurement. ocache's `base` tiers are key
// prefixes on one `StorageInterface`, so an L1-over-L2 arrangement needs a router; the
// `tiered` mode puts memory in front of the run's profiled backend.

import { defineCachedFunction } from "../../src/index.ts";
import { createZipf } from "../harness/random.ts";

import type { Scenario } from "../harness/scenario.ts";

const KEYSPACE = 500;

const scenario: Scenario = {
  id: "fanout-aggregate",
  title: "Fan-out aggregation (function)",
  kind: "function",
  summary: "3 parallel upstreams, 220 ms slowest, 500 keys, SWR with a long stale window",
  expect:
    "Stale serves answer in microseconds, so p50 and p90 should collapse while p99 stays bounded by the origin: a key's first touch has no stale entry and blocks. The tiered run should recover most of a slow backend's read cost while paying write amplification on misses.",
  origin: { ioMs: 220, cpuMs: 4, concurrency: 30 },
  payloadBytes: 6 * 1024,
  keyspace: KEYSPACE,
  storageProfiles: ["memory", "redis-az", "kv-edge"],
  tiers: ["/l1", "/l2"],
  load: {
    steady: { rps: 90, durationMs: 12_000, warmupMs: 4000 },
    ramp: [60, 120, 240, 480, 960],
  },

  create(ctx) {
    const pick = createZipf(ctx.rng, KEYSPACE, 1.2);
    const aggregate = (id: string) =>
      ctx.origin.run(() => ({
        id,
        profile: { id, name: `user-${id}` },
        orders: Array.from({ length: 20 }, (_, i) => ({ i, total: i * 3 })),
        recommendations: Array.from({ length: 30 }, (_, i) => `sku-${i}`),
      }));

    const cached = defineCachedFunction(aggregate, {
      name: "aggregate-profile",
      // Short enough that entries fall into the stale window inside a measured run.
      maxAge: 5,
      swr: true,
      staleMaxAge: 300,
      getKey: (id: string) => id,
      base: ctx.base,
      storage: ctx.storage,
      // A cached function has no event, so the refresh reaches the driver only through
      // this hook. Without it the background work escapes the run's accounting.
      waitUntil: ctx.waitUntil,
    });

    const run = ctx.mode === "baseline" ? aggregate : cached;
    return async () => {
      const value = await run(`u${pick()}`);
      if (!value.id) throw new Error("empty aggregate");
      return null;
    };
  },
};

export default scenario;
