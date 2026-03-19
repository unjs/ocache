import { bench, summary, run } from "mitata";
import {
  defineCachedFunction,
  setStorage,
  createMemoryStorage,
} from "../src/index.ts";
import type { StorageInterface } from "../src/index.ts";

// --- Simulated multi-tier storage ---

function createFastStorage(): StorageInterface {
  return createMemoryStorage();
}

function createSlowStorage(): StorageInterface {
  const inner = createMemoryStorage();
  return {
    async get(key) {
      await sleep(1);
      return inner.get(key);
    },
    async set(key, value, opts) {
      await sleep(1);
      return inner.set(key, value, opts);
    },
  };
}

function createTieredStorage(
  fast: StorageInterface,
  fastPrefix: string,
  slow: StorageInterface,
  slowPrefix: string,
): StorageInterface {
  return {
    get(key) {
      if (key.startsWith(fastPrefix)) return fast.get(key);
      if (key.startsWith(slowPrefix)) return slow.get(key);
      return fast.get(key);
    },
    set(key, value, opts) {
      if (key.startsWith(fastPrefix)) return fast.set(key, value, opts);
      if (key.startsWith(slowPrefix)) return slow.set(key, value, opts);
      return fast.set(key, value, opts);
    },
  };
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// --- Prepare cached functions ---

// 1. Single base (memory)
setStorage(createFastStorage());
const cachedMemory = defineCachedFunction(() => "value", {
  maxAge: 60,
  base: "/cache",
  name: "bench-mem",
  getKey: () => "k",
});
await cachedMemory();

// 2. Single base (slow ~1ms)
setStorage(createSlowStorage());
const cachedSlow = defineCachedFunction(() => "value", {
  maxAge: 60,
  base: "/cache",
  name: "bench-slow",
  getKey: () => "k",
});
await cachedSlow();

// 3. Multi-tier — hit tier 1
const fast3 = createFastStorage();
const slow3 = createSlowStorage();
setStorage(createTieredStorage(fast3, "/tmp", slow3, "/cache"));
const cachedTier1 = defineCachedFunction(() => "value", {
  maxAge: 60,
  base: ["/tmp", "/cache"],
  name: "bench-t1",
  getKey: () => "k",
});
await cachedTier1();

// 4. Multi-tier — fallback tier 2
const fast4 = createFastStorage();
const slow4 = createSlowStorage();
const tiered4 = createTieredStorage(fast4, "/tmp", slow4, "/cache");
setStorage(tiered4);
const writer4 = defineCachedFunction(() => "value", {
  maxAge: 60,
  base: "/cache",
  name: "bench-t2",
  getKey: () => "k",
  integrity: "shared",
});
await writer4();
const cachedTier2 = defineCachedFunction(() => "value", {
  maxAge: 60,
  base: ["/tmp", "/cache"],
  name: "bench-t2",
  getKey: () => "k",
  integrity: "shared",
});

// 5. Cache miss
setStorage(createFastStorage());
const cachedMiss = defineCachedFunction(() => "value", {
  maxAge: 0,
  base: "/cache",
  name: "bench-miss",
  getKey: () => "k",
});

// --- Benchmark ---

summary(() => {
  bench("single base (memory) — cache hit", async () => {
    await cachedMemory();
  });

  bench("single base (slow ~1ms) — cache hit", async () => {
    await cachedSlow();
  });

  bench("multi-tier — hit tier 1", async () => {
    await cachedTier1();
  });

  bench("multi-tier — fallback tier 2", async () => {
    await fast4.set("/tmp:functions:bench-t2:k.json", null);
    await cachedTier2();
  });

  bench("cache miss (maxAge: 0)", async () => {
    await cachedMiss();
  });
});

await run();
