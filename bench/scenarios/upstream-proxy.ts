// 5. Proxy in front of a rate-limited upstream.
//
// The dedup scenario. The origin is slow and hard-capped at ten concurrent calls, which
// is what a third-party API quota or a fragile internal service looks like. Offered load
// well past that cap makes the baseline queue without bound.
//
// Under `--load=burst` the cache starts cold and every arrival wants the same handful of
// keys at once. The `pending` map in `cache.ts` is what turns thousands of arrivals into
// one origin call per key; without it a cold cache is strictly worse than no cache.

import { defineCachedHandler } from "../../src/index.ts";
import { filler, makeEvent } from "../harness/scenario.ts";

import type { HTTPEvent } from "../../src/types.ts";
import type { Scenario } from "../harness/scenario.ts";

const BODY = filler(4 * 1024);
const KEYSPACE = 20;

const scenario: Scenario = {
  id: "upstream-proxy",
  title: "Rate-limited upstream proxy",
  kind: "handler",
  summary: "4 KiB JSON, 300 ms upstream capped at 10 concurrent calls, 20 keys",
  expect:
    "Baseline capacity is fixed at roughly 33 rps by the cap. Cached should hold the offered rate with about 20 origin calls per maxAge window; the burst profile shows dedup collapsing a cold stampede.",
  origin: { ioMs: 300, cpuMs: 1, concurrency: 10 },
  payloadBytes: 4 * 1024,
  keyspace: KEYSPACE,
  storageProfiles: ["memory", "redis-az", "object-store"],
  load: {
    steady: { rps: 25, durationMs: 12_000, warmupMs: 3000 },
    burst: { rps: 2000, durationMs: 1000, warmupMs: 0 },
    ramp: [25, 50, 100, 200, 400, 800, 1600],
  },

  create(ctx) {
    const handler = (event: HTTPEvent) =>
      ctx.origin.run(
        () =>
          new Response(`{"path":"${event.url!.pathname}","data":"${BODY}"}`, {
            headers: { "content-type": "application/json" },
          }),
      );

    const cached = defineCachedHandler(handler, {
      name: "upstream",
      maxAge: 10,
      swr: true,
      staleMaxAge: 60,
      base: ctx.base,
      storage: ctx.storage,
    });

    const serve = ctx.mode === "cached" ? cached : handler;
    return async () => {
      const event = makeEvent(
        `https://api.example/v1/rates/${Math.floor(ctx.rng() * KEYSPACE)}`,
        undefined,
        ctx.waitUntil,
      );
      const res = (await serve(event)) as Response;
      await res.arrayBuffer();
      return res.headers.get("x-cache");
    };
  },
};

export default scenario;
