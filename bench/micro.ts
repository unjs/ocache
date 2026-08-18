// What one cache hit costs, with nothing else in the way.
//
// The load harness (`bench/index.ts`) answers what ocache buys. This answers what it
// charges: the origin resolves instantly and storage is an in-process Map, so every
// number here is ocache's own work — key hashing, `validate`, `transform`,
// `deserializeEntry`, and the `Response` it builds per call.
//
//   node bench/micro.ts

import { bench, boxplot, compact, do_not_optimize, group, run, summary } from "mitata";

import { createMemoryStorage, defineCachedFunction, defineCachedHandler } from "../src/index.ts";
import { hash } from "../src/hash.ts";

import type { StorageInterface } from "../src/index.ts";
import { filler, makeEvent } from "./harness/scenario.ts";

const noop = () => {};
const store = () => createMemoryStorage({ maxBytes: Infinity, maxSize: Infinity });

const SIZES = [1024, 8 * 1024, 40 * 1024, 256 * 1024];
const BODIES = new Map(SIZES.map((size) => [size, filler(size)]));

// --- Handler hit path, by payload size ---

group("handler hit vs payload size", () => {
  summary(() => {
    for (const size of SIZES) {
      const body = BODIES.get(size)!;
      const raw = () => new Response(body, { headers: { "content-type": "text/html" } });
      const cached = defineCachedHandler(raw, {
        name: `h${size}`,
        maxAge: 600,
        storage: store(),
      });
      const url = `https://bench.example/size/${size}`;
      // Warm the entry so the benchmark only ever measures a hit.
      void cached(makeEvent(url, undefined, noop));

      compact(() => {
        bench(`${size / 1024} KiB · direct`, async () => {
          const res = raw();
          await res.arrayBuffer();
        });
        bench(`${size / 1024} KiB · cached hit`, async () => {
          const res = (await cached(makeEvent(url, undefined, noop))) as Response;
          await res.arrayBuffer();
        });
      });
    }
  });
});

// --- What each option adds to the hit path ---

group("handler hit path, 8 KiB", () => {
  const body = BODIES.get(8 * 1024)!;
  const raw = () => new Response(body);
  const url = "https://bench.example/opt?a=1&b=2&utm_source=x";

  const variants: Array<[string, ReturnType<typeof defineCachedHandler>]> = [
    ["plain", defineCachedHandler(raw, { name: "v1", maxAge: 600, storage: store() })],
    [
      "no status header",
      defineCachedHandler(raw, {
        name: "v2",
        maxAge: 600,
        cacheStatusHeader: false,
        storage: store(),
      }),
    ],
    [
      "allowQuery",
      defineCachedHandler(raw, {
        name: "v3",
        maxAge: 600,
        allowQuery: ["a", "b"],
        storage: store(),
      }),
    ],
    // The default filters the query away, so this measures what keeping it costs instead.
    [
      "allowQuery: true",
      defineCachedHandler(raw, {
        name: "v3b",
        maxAge: 600,
        allowQuery: true,
        storage: store(),
      }),
    ],
    [
      "allowCookies",
      defineCachedHandler(raw, {
        name: "v4",
        maxAge: 600,
        allowCookies: ["tier"],
        storage: store(),
      }),
    ],
    [
      "varies: 3 headers",
      defineCachedHandler(raw, {
        name: "v5",
        maxAge: 600,
        varies: ["accept-language", "accept-encoding", "x-country"],
        storage: store(),
      }),
    ],
    [
      "swr (stale read)",
      defineCachedHandler(raw, {
        name: "v6",
        maxAge: 0.001,
        swr: true,
        staleMaxAge: 600,
        storage: store(),
      }),
    ],
    [
      "3 base tiers",
      defineCachedHandler(raw, {
        name: "v7",
        maxAge: 600,
        base: ["/t1", "/t2", "/t3"],
        storage: store(),
      }),
    ],
    [
      "custom getKey",
      defineCachedHandler(raw, { name: "v8", maxAge: 600, getKey: () => "k", storage: store() }),
    ],
  ];

  const headers = {
    cookie: "tier=pro; sid=abc",
    "accept-language": "en-GB",
    "accept-encoding": "br",
    "x-country": "GB",
  };

  summary(() => {
    compact(() => {
      bench("direct", async () => {
        const res = raw();
        await res.arrayBuffer();
      });
      for (const [label, handler] of variants) {
        void handler(makeEvent(url, { headers }, noop));
        bench(label, async () => {
          const res = (await handler(makeEvent(url, { headers }, noop))) as Response;
          await res.arrayBuffer();
        });
      }
    });
  });
});

// --- A binary body takes the base64 path only where the backend cannot hold bytes ---

group("text vs binary body, 40 KiB", () => {
  const text = BODIES.get(40 * 1024)!;
  const bytes = new Uint8Array(40 * 1024).fill(0x80);
  // Same store, minus the declaration: this is what a JSON-serializing backend gets.
  const base64Store = (): StorageInterface => {
    const inner = store();
    return { get: (key) => inner.get(key) as any, set: inner.set.bind(inner) };
  };
  const textHandler = defineCachedHandler(() => new Response(text), {
    name: "b1",
    maxAge: 600,
    storage: store(),
  });
  const binaryHandler = defineCachedHandler(() => new Response(bytes), {
    name: "b2",
    maxAge: 600,
    storage: store(),
  });
  const base64Handler = defineCachedHandler(() => new Response(bytes), {
    name: "b3",
    maxAge: 600,
    storage: base64Store(),
  });
  const url = "https://bench.example/body";
  void textHandler(makeEvent(url, undefined, noop));
  void binaryHandler(makeEvent(url, undefined, noop));
  void base64Handler(makeEvent(url, undefined, noop));

  boxplot(() => {
    bench("text hit", async () => {
      const res = (await textHandler(makeEvent(url, undefined, noop))) as Response;
      await res.arrayBuffer();
    });
    bench("binary hit (stored bytes)", async () => {
      const res = (await binaryHandler(makeEvent(url, undefined, noop))) as Response;
      await res.arrayBuffer();
    });
    bench("binary hit (base64)", async () => {
      const res = (await base64Handler(makeEvent(url, undefined, noop))) as Response;
      await res.arrayBuffer();
    });
  });
});

// A store is where base64 was actually paid: the encode, and then the etag digest over a
// string 4/3 the size of the bytes. Every iteration uses a fresh key, so every one is a miss.
group("binary store, 40 KiB", () => {
  const bytes = new Uint8Array(40 * 1024).fill(0x80);
  // Bounded by entry count so a long run does not retain every body it wrote.
  const bounded = () => createMemoryStorage({ maxBytes: Infinity, maxSize: 64 });
  const asBase64 = (): StorageInterface => {
    const inner = bounded();
    return { get: (key) => inner.get(key) as any, set: inner.set.bind(inner) };
  };
  const binaryHandler = defineCachedHandler(() => new Response(bytes), {
    name: "s1",
    maxAge: 600,
    storage: bounded(),
  });
  const base64Handler = defineCachedHandler(() => new Response(bytes), {
    name: "s2",
    maxAge: 600,
    storage: asBase64(),
  });
  let n = 0;

  boxplot(() => {
    bench("binary store (stored bytes)", async () => {
      const res = (await binaryHandler(
        makeEvent(`https://bench.example/s/${n++}`, undefined, noop),
      )) as Response;
      await res.arrayBuffer();
    });
    bench("binary store (base64)", async () => {
      const res = (await base64Handler(
        makeEvent(`https://bench.example/s/${n++}`, undefined, noop),
      )) as Response;
      await res.arrayBuffer();
    });
  });
});

// --- Cached functions, and the key machinery underneath both paths ---

group("cached function hit", () => {
  const value = { id: 1, items: Array.from({ length: 50 }, (_, i) => ({ i, name: `n${i}` })) };
  const produce = (..._args: unknown[]) => value;
  const cached = defineCachedFunction(produce, {
    name: "f1",
    maxAge: 600,
    getKey: (id) => String(id),
    storage: store(),
  });
  // No `getKey`, so the default hashes every argument.
  const hashedKey = defineCachedFunction(produce, { name: "f2", maxAge: 600, storage: store() });
  void cached("k");
  void hashedKey("k", 2, { deep: true });

  summary(() => {
    compact(() => {
      // Without this the direct call is eliminated and the comparison is meaningless.
      bench("direct", () => do_not_optimize(produce()));
      bench("cached hit, explicit key", async () => do_not_optimize(await cached("k")));
      bench("cached hit, hashed args", async () =>
        do_not_optimize(await hashedKey("k", 2, { deep: true })));
    });
  });
});

group("hash", () => {
  const small = ["https://example.com/p/42", "GET"];
  const body = BODIES.get(40 * 1024)!;
  compact(() => {
    bench("hash(key tuple)", () => do_not_optimize(hash(small)));
    bench("hash(40 KiB body)", () => do_not_optimize(hash(body)));
  });
});

await run();
