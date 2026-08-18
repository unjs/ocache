// 1. Server-rendered product page.
//
// The canonical ISR case: a catalogue with a heavy head and a very long tail, rendered
// from a database read plus a template pass. Both origin costs are present, so the result
// separates the latency win (I/O) from the capacity win (render CPU), and the Zipf tail
// keeps the hit ratio realistic instead of the 100% a single-key benchmark reports.

import { defineCachedHandler } from "../../src/index.ts";
import { createZipf } from "../harness/random.ts";
import { filler, makeEvent } from "../harness/scenario.ts";

import type { HTTPEvent } from "../../src/types.ts";
import type { Scenario } from "../harness/scenario.ts";

const BODY = filler(40 * 1024);
const KEYSPACE = 5000;

const scenario: Scenario = {
  id: "ssr-product-page",
  title: "SSR product page",
  kind: "handler",
  summary: "40 KiB HTML, 2 DB queries + template render, 5k pages, Zipf head",
  expect:
    "Latency drops to the storage round trip on hits; capacity rises because the 12 ms render is skipped. Hit ratio is set by the Zipf tail, not by the cache. The `redis-az-bytes` row is the text half of the codec pairing: the body leaves the JSON but never was base64, so only the escaping is saved.",
  origin: { ioMs: 18, cpuMs: 12, concurrency: 20 },
  payloadBytes: 40 * 1024,
  keyspace: KEYSPACE,
  storageProfiles: ["memory", "redis-az", "redis-az-bytes", "kv-edge"],
  load: {
    steady: { rps: 60, durationMs: 10_000, warmupMs: 3000 },
    ramp: [40, 80, 160, 320, 640, 1280, 2560],
  },
  memory: { maxBytes: 1024 * 1024 * 1024, maxSize: Infinity },

  create(ctx) {
    const pick = createZipf(ctx.rng, KEYSPACE, 1.1);
    const handler = (event: HTTPEvent) =>
      ctx.origin.run(
        () =>
          new Response(`<!doctype html><title>${event.url!.pathname}</title>${BODY}`, {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      );

    const cached = defineCachedHandler(handler, {
      name: "product-page",
      maxAge: 60,
      swr: true,
      staleMaxAge: 600,
      base: ctx.base,
      storage: ctx.storage,
    });

    const serve = ctx.mode === "cached" ? cached : handler;
    return async () => {
      const event = makeEvent(`https://shop.example/p/${pick()}`, undefined, ctx.waitUntil);
      const res = (await serve(event)) as Response;
      // Consume the body in both modes: the baseline streams, the cached path does not.
      await res.arrayBuffer();
      return res.headers.get("x-cache");
    };
  },
};

export default scenario;
