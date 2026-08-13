import { createHash } from "node:crypto";
import { bench, summary, compact, run } from "mitata";
import { digest } from "../src/crypto.ts";
import { defineCachedFunction, createMemoryStorage } from "../src/index.ts";
import type { StorageInterface } from "../src/index.ts";

// --- Simulated costs (ms) ---

const costs = {
  /** Cost of the original function invocation */
  fn: 200,
  /** Cost of a storage write */
  write: 5,
  /** Cost of a storage read */
  read: 1,
};

// --- Simulated storage ---

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function createSimulatedStorage(): StorageInterface {
  const inner = createMemoryStorage();
  return {
    async get(key) {
      await sleep(costs.read);
      return inner.get(key);
    },
    async set(key, value, opts) {
      await sleep(costs.write);
      return inner.set(key, value, opts);
    },
  };
}

/**
 * Routes get/set to the right simulated storage based on key prefix.
 * Each storage is registered with a prefix and has its own simulated latency.
 */
function createRoutedStorage(
  routes: [prefix: string, storage: StorageInterface][],
): StorageInterface {
  const resolve = (key: string) => {
    for (const [prefix, s] of routes) {
      if (key.startsWith(prefix)) return s;
    }
    return routes[0]![1]; // fallback to first
  };
  return {
    get(key) {
      return resolve(key).get(key);
    },
    set(key, value, opts) {
      return resolve(key).set(key, value, opts);
    },
  };
}

async function simulatedFn() {
  await sleep(costs.fn);
  return "value";
}

// --- Setup shared routed storage ---
// Each scenario gets its own prefix so they don't collide, and every cached function below
// is handed this one `storage` explicitly — storage is per cached function now (no global
// singleton), so sharing has to be opted into.

const storeSingle = createSimulatedStorage();
const storeTier1Fast = createSimulatedStorage();
const storeTier1Slow = createSimulatedStorage();
const storeTier2Fast = createSimulatedStorage();
const storeTier2Slow = createSimulatedStorage();
const storeMiss = createSimulatedStorage();

const storage = createRoutedStorage([
  ["/single", storeSingle],
  ["/t1-fast", storeTier1Fast],
  ["/t1-slow", storeTier1Slow],
  ["/t2-fast", storeTier2Fast],
  ["/t2-slow", storeTier2Slow],
  ["/miss", storeMiss],
]);

// --- Prepare cached functions ---

// 1. Single base — cache hit
const cachedSingle = defineCachedFunction(simulatedFn, {
  maxAge: 60,
  swr: false,
  base: "/single",
  name: "bench",
  getKey: () => "k",
  storage,
});
await cachedSingle(); // warm up

// 2. Multi-tier — hit tier 1 (value in fast tier)
const cachedTier1 = defineCachedFunction(simulatedFn, {
  maxAge: 60,
  swr: false,
  base: ["/t1-fast", "/t1-slow"],
  name: "bench",
  getKey: () => "k",
  storage,
});
await cachedTier1(); // warm up — writes to both tiers

// 3. Multi-tier — fallback tier 2 (value only in slow tier)
// First, write the entry to slow tier only
const tier2Writer = defineCachedFunction(simulatedFn, {
  maxAge: 60,
  swr: false,
  base: "/t2-slow",
  name: "bench",
  getKey: () => "k",
  integrity: "shared",
  storage,
});
await tier2Writer(); // populate slow tier

const cachedTier2 = defineCachedFunction(simulatedFn, {
  maxAge: 60,
  swr: false,
  base: ["/t2-fast", "/t2-slow"],
  name: "bench",
  getKey: () => "k",
  integrity: "shared",
  storage,
});

// 4. Cache miss (maxAge: 0 forces re-evaluation every time)
const cachedMiss = defineCachedFunction(simulatedFn, {
  maxAge: 0,
  swr: false,
  base: "/miss",
  name: "bench",
  getKey: () => "k",
  storage,
});

// --- Benchmark ---

summary(() => {
  compact(() => {
    bench("no cache (baseline)", async () => {
      await simulatedFn();
    });

    bench("single base — cache hit", async () => {
      await cachedSingle();
    });

    bench("multi-tier — hit tier 1", async () => {
      await cachedTier1();
    });

    bench("multi-tier — fallback tier 2", async () => {
      // Clear fast tier so it falls through to slow
      await storeTier2Fast.set("/t2-fast:functions:bench:k.json", null);
      await cachedTier2();
    });

    bench("cache miss", async () => {
      await cachedMiss();
    });
  });
});

// --- Digest ---
//
// The two halves of the `#crypto` condition, on the two shapes ocache actually hashes: a
// cache key (short, several per request) and a response body (`serialize` SHA-256s every one
// for its weak etag, on the write path of every miss). `src/crypto.ts` is what edge/worker
// builds run; `node:crypto` is what Node builds run, and it is the ceiling — a JS digest is
// not going to beat a native one, it only has to stay far enough below the cost of the I/O
// it sits next to.

const shortKey = "x".repeat(64);
const largeBody = "x".repeat(100_000);
const nodeDigest = (message: string) =>
  createHash("sha256").update(message, "utf8").digest("base64url");

summary(() => {
  compact(() => {
    bench("digest — 64 B key (compact)", () => digest(shortKey));
    bench("digest — 64 B key (node:crypto)", () => nodeDigest(shortKey));
    bench("digest — 100 kB body (compact)", () => digest(largeBody));
    bench("digest — 100 kB body (node:crypto)", () => nodeDigest(largeBody));
  });
});

await run();
