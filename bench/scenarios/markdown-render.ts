// 6. Markdown/MDX render (cached function, not a handler).
//
// Pure blocking CPU with no I/O at all. This is the cleanest capacity measurement in the
// set: throughput is exactly 1000/cpuMs without a cache, so any hit ratio translates
// directly into headroom. It is also the cleanest break-even measurement, because a
// storage profile whose read latency exceeds 25 ms makes the cache a pure loss.

import { defineCachedFunction } from "../../src/index.ts";
import { createZipf } from "../harness/random.ts";
import { filler } from "../harness/scenario.ts";

import type { Scenario } from "../harness/scenario.ts";

const BODY = filler(20 * 1024);
const KEYSPACE = 3000;

const scenario: Scenario = {
  id: "markdown-render",
  title: "Markdown render (function)",
  kind: "function",
  summary: "25 ms blocking render to 20 KiB HTML, 3k documents",
  expect:
    "Baseline throughput is pinned at 1000/25 = 40 rps. Cached capacity should scale with hit ratio until storage latency becomes the new floor. `redis-az-bytes` is here as the counter-example: this value is a string, not bytes and not a response body, so it declares no payload and the frame has nothing to lift — it should cost more than plain `redis-az`, not less.",
  origin: { ioMs: 0, cpuMs: 25, concurrency: Infinity },
  payloadBytes: 20 * 1024,
  keyspace: KEYSPACE,
  storageProfiles: ["memory", "redis-local", "redis-az", "redis-az-bytes", "sql", "object-store"],
  load: {
    steady: { rps: 30, durationMs: 12_000, warmupMs: 3000 },
    ramp: [25, 50, 100, 200, 400, 800],
  },

  create(ctx) {
    const pick = createZipf(ctx.rng, KEYSPACE, 1);
    const render = (slug: string) =>
      ctx.origin.run(() => `<article id="${slug}">${BODY}</article>`);

    const cached = defineCachedFunction(render, {
      name: "render-markdown",
      maxAge: 300,
      getKey: (slug: string) => slug,
      base: ctx.base,
      storage: ctx.storage,
    });

    const run = ctx.mode === "baseline" ? render : cached;
    return async () => {
      const html = await run(`doc-${pick()}`);
      if (html.length === 0) throw new Error("empty render");
      // A cached function has no response header to report a status through.
      return null;
    };
  },
};

export default scenario;
