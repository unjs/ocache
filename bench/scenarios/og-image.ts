// 4. Rendered OG image.
//
// Heavy, blocking CPU with a binary body. Two things only this scenario exercises: the
// base64 storage path in `http/entry.ts`, which charges roughly 8/3 bytes of budget per
// body byte, and conditional revalidation, where a matching `If-None-Match` returns 304
// and never rebuilds the response at all.

import { defineCachedHandler } from "../../src/index.ts";
import { createRng, createZipf } from "../harness/random.ts";
import { binaryFiller, makeEvent } from "../harness/scenario.ts";

import type { HTTPEvent } from "../../src/types.ts";
import type { Scenario } from "../harness/scenario.ts";

const KEYSPACE = 300;
const IMAGE_BYTES = 64 * 1024;
// A handful of distinct payloads, indexed by key, to keep the fixture off the heap budget.
const IMAGES = Array.from({ length: 8 }, (_, i) => binaryFiller(IMAGE_BYTES, i + 1));
/** Share of requests that replay a validator they already hold. */
const CONDITIONAL_SHARE = 0.3;

const scenario: Scenario = {
  id: "og-image",
  title: "OG image render",
  kind: "handler",
  summary: "64 KiB PNG, 180 ms blocking render, 300 slugs, 30% conditional requests",
  expect:
    "The largest capacity win in the set: blocking render CPU disappears on a hit. Watch the share of requests answered with 304, and the two `redis-az` rows: same wire, one storing the body as base64 inside JSON and one storing it as bytes through `createBlobStorage`.",
  origin: { ioMs: 5, cpuMs: 180, concurrency: 4 },
  payloadBytes: IMAGE_BYTES,
  keyspace: KEYSPACE,
  storageProfiles: ["memory", "redis-az", "redis-az-bytes"],
  load: {
    steady: { rps: 4, durationMs: 25_000, warmupMs: 5000 },
    ramp: [4, 8, 16, 32, 64, 128],
  },
  memory: { maxBytes: 512 * 1024 * 1024, maxSize: Infinity },

  create(ctx) {
    const pick = createZipf(ctx.rng, KEYSPACE, 1.3);
    const conditionalRng = createRng(0x6f_67_69_6d);
    const validators = new Set<number>();

    const handler = (event: HTTPEvent) =>
      ctx.origin.run(() => {
        const slug = Number(event.url!.pathname.split("/").pop()!.replace(".png", "")) || 0;
        return new Response(IMAGES[slug % IMAGES.length]! as unknown as BodyInit, {
          headers: { "content-type": "image/png", etag: `"og-${slug}"` },
        });
      });

    const cached = defineCachedHandler(handler, {
      name: "og-image",
      maxAge: 3600,
      swr: true,
      staleMaxAge: 86_400,
      base: ctx.base,
      storage: ctx.storage,
    });

    const serve = ctx.mode === "cached" ? cached : handler;
    return async () => {
      const slug = pick();
      const conditionalDraw = conditionalRng();
      const conditional = validators.has(slug) && conditionalDraw < CONDITIONAL_SHARE;
      const event = makeEvent(
        `https://shop.example/og/${slug}.png`,
        conditional ? { headers: { "if-none-match": `"og-${slug}"` } } : undefined,
        ctx.waitUntil,
      );
      // Traffic follows scheduled request order, not mode-dependent completion order.
      validators.add(slug);
      const res = (await serve(event)) as Response;
      await res.arrayBuffer();
      return res.status === 304 ? "304" : res.headers.get("x-cache");
    };
  },
};

export default scenario;
