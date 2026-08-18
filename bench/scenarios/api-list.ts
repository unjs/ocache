// 2. Paginated JSON list endpoint.
//
// The unflattering handler case. Query combinations spread the load over a wide keyspace
// with a shallow head, so the hit ratio is mediocre by construction. `allowQuery` is what
// makes the keyspace this wide at all — it opts the three real parameters in while leaving
// out the analytics ones, which ride along on a large share of real traffic and would
// otherwise turn every link into its own cache key.

import { defineCachedHandler } from "../../src/index.ts";
import { createZipf } from "../harness/random.ts";
import { filler, makeEvent } from "../harness/scenario.ts";

import type { HTTPEvent } from "../../src/types.ts";
import type { Scenario } from "../harness/scenario.ts";

const BODY = filler(8 * 1024);
const CATEGORIES = 40;
const PAGES = 25;
const SORTS = ["rank", "price", "new"];
const KEYSPACE = CATEGORIES * PAGES * SORTS.length;
const NOISE = ["utm_source=nl", "utm_campaign=spring", "fbclid=x", "ref=home"];

const scenario: Scenario = {
  id: "api-list",
  title: "JSON list API",
  kind: "handler",
  summary: "8 KiB JSON, 3k query combinations, 40% of requests carry tracking params",
  expect:
    "A shallow head means a middling hit ratio, so per-request cache overhead is visible. `allowQuery` collapses the tracking-parameter variants that would otherwise dominate the keyspace.",
  origin: { ioMs: 25, cpuMs: 2, concurrency: 20 },
  payloadBytes: 8 * 1024,
  keyspace: KEYSPACE,
  storageProfiles: ["memory", "redis-az", "kv-edge"],
  load: {
    steady: { rps: 300, durationMs: 10_000, warmupMs: 3000 },
    ramp: [200, 400, 800, 1600, 3200, 6400],
  },

  create(ctx) {
    const pick = createZipf(ctx.rng, KEYSPACE, 0.8);
    const handler = (event: HTTPEvent) =>
      ctx.origin.run(
        () =>
          new Response(`{"query":"${event.url!.search}","items":"${BODY}"}`, {
            headers: { "content-type": "application/json" },
          }),
      );

    const cached = defineCachedHandler(handler, {
      name: "product-list",
      maxAge: 30,
      allowQuery: ["category", "page", "sort"],
      base: ctx.base,
      storage: ctx.storage,
    });

    const serve = ctx.mode === "cached" ? cached : handler;
    return async () => {
      const index = pick();
      const category = index % CATEGORIES;
      const page = Math.floor(index / CATEGORIES) % PAGES;
      const sort = SORTS[Math.floor(index / (CATEGORIES * PAGES)) % SORTS.length]!;
      const noise = ctx.rng() < 0.4 ? `&${NOISE[Math.floor(ctx.rng() * NOISE.length)]}` : "";
      const event = makeEvent(
        `https://shop.example/api/products?category=${category}&page=${page}&sort=${sort}${noise}`,
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
