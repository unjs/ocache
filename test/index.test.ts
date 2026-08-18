import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  cachedFunction as _cachedFunction,
  defineCachedFunction as _defineCachedFunction,
  defineCachedHandler as _defineCachedHandler,
  resolveCacheKeys,
  invalidateCache,
  expireCache,
  createMemoryStorage,
  type StorageInterface,
  type HTTPEvent,
} from "../src/index.ts";

// There is no global storage any more: every cached function/handler owns its own memory
// storage unless it is handed one, which is what makes two independent consumers unable to
// collide (covered explicitly in `describe("storage")`). Most tests here predate that and
// want ONE shared, inspectable backend, so the wrappers below inject `testStorage` as the
// `storage` option. It goes in as a *factory* — resolved on first use — so a test can still
// swap the backend after defining its cached function, exactly as the old `useTestStorage()`
// calls did. Use the `_`-prefixed imports directly to exercise the real defaults.
let testStorage: StorageInterface;

beforeEach(() => {
  testStorage = createMemoryStorage();
});

/** Replaces the storage the wrappers below hand out (the old global `setStorage`). */
function useTestStorage(storage: StorageInterface): void {
  testStorage = storage;
}

// Mutates rather than clones: the standalone `invalidateCache`/`expireCache` helpers reach
// a cached function's store by being handed the very same options object, so the wrapper
// must not break that identity.
function _withTestStorage<O extends { storage?: any }>(opts: O): O {
  opts.storage ??= () => testStorage;
  return opts;
}

const cachedFunction: typeof _cachedFunction = (fn: any, opts: any = {}) =>
  _cachedFunction(fn, _withTestStorage(opts));
const defineCachedFunction: typeof _defineCachedFunction = cachedFunction;
const defineCachedHandler: typeof _defineCachedHandler = (handler: any, opts: any = {}) =>
  _defineCachedHandler(handler, _withTestStorage(opts));

describe("cachedFunction", () => {
  it("caches function results", async () => {
    let callCount = 0;
    const fn = cachedFunction(
      () => {
        callCount++;
        return "result";
      },
      { maxAge: 10 },
    );

    const result1 = await fn();
    const result2 = await fn();

    expect(result1).toBe("result");
    expect(result2).toBe("result");
    expect(callCount).toBe(1);
  });

  it("uses custom getKey", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      (key: string) => {
        callCount++;
        return `value-${key}`;
      },
      { maxAge: 10, getKey: (key) => key },
    );

    expect(await fn("a")).toBe("value-a");
    expect(await fn("b")).toBe("value-b");
    expect(await fn("a")).toBe("value-a");
    expect(callCount).toBe(2);
  });

  it("shouldBypassCache skips caching", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        return "value";
      },
      { maxAge: 10, shouldBypassCache: () => true },
    );

    await fn();
    await fn();
    expect(callCount).toBe(2);
  });

  it("shouldInvalidateCache forces refresh", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        return `value-${callCount}`;
      },
      { maxAge: 10, shouldInvalidateCache: () => true },
    );

    const r1 = await fn();
    await fn();
    expect(callCount).toBe(2);
    expect(r1).toBe("value-1");
  });

  it("transform modifies cached value", async () => {
    const fn = defineCachedFunction(() => "raw", {
      maxAge: 10,
      transform: (entry) => `transformed-${entry.value}`,
    });

    expect(await fn()).toBe("transformed-raw");
  });

  it("keeps a falsy transform result", async () => {
    for (const value of [0, false, "", Number.NaN]) {
      const fn = defineCachedFunction(() => "raw", {
        maxAge: 10,
        transform: () => value,
      });

      expect(await fn()).toBe(value);
    }
  });

  it("falls back to the cached value when transform returns undefined", async () => {
    const fn = defineCachedFunction(() => "raw", {
      maxAge: 10,
      transform: () => undefined,
    });

    expect(await fn()).toBe("raw");
  });

  it("exposes cache status (hit/miss/stale) to transform", async () => {
    const statuses: (string | undefined)[] = [];
    let n = 0;
    const fn = defineCachedFunction(() => `v${++n}`, {
      maxAge: 100,
      swr: true, // opt in — SWR is off by default
      getKey: () => "k",
      transform: (entry) => {
        statuses.push(entry.status);
        return entry.value;
      },
    });

    await fn(); // resolved fresh
    await fn(); // served from cache
    await fn.expire(); // mark stale for background refresh
    await fn(); // served stale under SWR

    expect(statuses).toEqual(["miss", "hit", "stale"]);
  });

  it("reports revalidated when an expired entry is re-resolved in the foreground (swr disabled)", async () => {
    const statuses: (string | undefined)[] = [];
    let n = 0;
    const fn = defineCachedFunction(() => `v${++n}`, {
      maxAge: 100,
      swr: false,
      getKey: () => "k",
      transform: (entry) => {
        statuses.push(entry.status);
        return entry.value;
      },
    });

    await fn(); // nothing cached -> miss
    await fn(); // fresh cached value -> hit
    await fn.expire(); // mark the existing entry stale
    await fn(); // no SWR -> prior value re-resolved in foreground -> revalidated

    expect(statuses).toEqual(["miss", "hit", "revalidated"]);
  });

  it("never serves an entry with a foreign integrity as stale under SWR", async () => {
    const statuses: (string | undefined)[] = [];
    const fn = defineCachedFunction(() => "mine", {
      maxAge: 100,
      swr: true,
      getKey: () => "k",
      transform: (entry) => {
        statuses.push(entry.status);
        return entry.value;
      },
    });
    const [key] = await fn.resolveKeys();
    // Another function's value under the same key: unusable, not merely stale.
    await testStorage.set(key!, { value: "theirs", mtime: Date.now(), integrity: "foreign" });

    expect(await fn()).toBe("mine");
    expect(statuses).toEqual(["revalidated"]);
  });

  it("does not persist per-call status to storage (incl. on a hit)", async () => {
    const fn = defineCachedFunction(() => "v", { maxAge: 100, getKey: () => "k" });
    await fn(); // miss (writes entry)
    await fn(); // hit — must not mutate the stored entry with `status`
    const [key] = await fn.resolveKeys();
    const stored = (await testStorage.get(key!)) as Record<string, unknown>;
    expect(Object.keys(stored)).not.toContain("status");
  });

  it("does not persist status through expireCache", async () => {
    const fn = defineCachedFunction(() => "v", {
      maxAge: 100,
      staleMaxAge: 100,
      swr: true,
      getKey: () => "k",
    });
    await fn(); // miss
    await fn(); // hit (sets per-call status on the returned entry)
    await fn.expire();
    const [key] = await fn.resolveKeys();
    const stored = (await testStorage.get(key!)) as Record<string, unknown>;
    expect(stored.stale).toBe(true);
    expect(Object.keys(stored)).not.toContain("status");
  });

  it("handles resolver errors", async () => {
    const fn = defineCachedFunction(
      () => {
        throw new Error("resolver error");
      },
      { maxAge: 10, swr: false },
    );

    await expect(fn()).rejects.toThrow("resolver error");
    await expect(fn()).rejects.toThrow("resolver error");
  });

  it("deduplicates concurrent requests", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 50));
        return "value";
      },
      { maxAge: 10 },
    );

    const [r1, r2] = await Promise.all([fn(), fn()]);
    expect(r1).toBe("value");
    expect(r2).toBe("value");
    expect(callCount).toBe(1);
  });

  // Regression: issue #3 — swr=false concurrent requests on expired entry should still dedup
  it("swr=false deduplicates concurrent requests on expired entry", async () => {
    let resolveCount = 0;
    const fn = defineCachedFunction(
      async () => {
        resolveCount++;
        const v = resolveCount;
        await new Promise((r) => setTimeout(r, 50));
        return `v${v}`;
      },
      { maxAge: 0.001, swr: false },
    );

    // Prime the cache
    expect(await fn()).toBe("v1");
    expect(resolveCount).toBe(1);
    await new Promise((r) => setTimeout(r, 10));

    // Entry is now expired. Two concurrent requests should dedup the resolver
    const [r1, r2] = await Promise.all([fn(), fn()]);
    // Both should get the same value from a single resolver call
    expect(r1).toBe("v2");
    expect(r2).toBe("v2");
    expect(resolveCount).toBe(2); // only one additional resolver call, not two
  });

  it("validates cache entries", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        return callCount;
      },
      {
        maxAge: 10,
        swr: false,
        validate: (entry) => (entry.value ?? 0) > 1,
      },
    );

    const r1 = await fn();
    expect(r1).toBe(1);
    const r2 = await fn();
    expect(r2).toBe(2);
  });

  it("passes call args to validate", async () => {
    // Regression for nitrojs/nitro#3525: validate must receive the args the cached
    // function was called with, so an entry can be validated against the current call
    // (e.g. comparing a request parameter against `entry.mtime`).
    let callCount = 0;
    const seenArgs: Array<unknown[]> = [];
    const fn = defineCachedFunction(
      (_id: string, lastUpdated: number) => {
        callCount++;
        return { callCount, lastUpdated };
      },
      {
        maxAge: 10,
        swr: false,
        getKey: (id) => id,
        validate: (entry, { args }) => {
          seenArgs.push(args);
          const [, lastUpdated] = args;
          // Invalidate the cached entry when the caller reports newer data.
          return (entry.value?.lastUpdated ?? 0) >= lastUpdated;
        },
      },
    );

    // First call resolves fresh (miss) — validate still runs on the empty read entry.
    expect(await fn("a", 100)).toEqual({ callCount: 1, lastUpdated: 100 });
    // Same args -> cached value passes validation.
    expect(await fn("a", 100)).toEqual({ callCount: 1, lastUpdated: 100 });
    expect(callCount).toBe(1);

    // A newer `lastUpdated` makes validate return false -> re-resolve.
    expect(await fn("a", 200)).toEqual({ callCount: 2, lastUpdated: 200 });
    expect(callCount).toBe(2);

    // validate always saw the args from the current call.
    expect(seenArgs.every((args) => args.length === 2)).toBe(true);
    expect(seenArgs.at(-1)).toEqual(["a", 200]);
  });

  it("supports asynchronous validate", async () => {
    // Mirrors issue #32: validate needs to check the cached value against an
    // external source (e.g. fetching a signed URL to confirm it is still valid).
    let callCount = 0;
    let remoteValid = true;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        return callCount;
      },
      {
        maxAge: 10,
        swr: false,
        validate: async (entry) => {
          // Simulate an async check against a remote source
          await new Promise((r) => setTimeout(r, 1));
          return remoteValid && (entry.value ?? 0) > 0;
        },
      },
    );

    // First call resolves fresh (miss)
    expect(await fn()).toBe(1);
    // Cached value passes async validation -> served from cache
    expect(await fn()).toBe(1);
    expect(callCount).toBe(1);

    // Remote now reports the cached value as invalid -> re-resolve
    remoteValid = false;
    expect(await fn()).toBe(2);
    expect(callCount).toBe(2);
  });

  it("supports asynchronous validate with SWR", async () => {
    // When async validate reports the cached value as invalid, the entry is
    // treated as fully invalid: SWR does NOT serve the stale value (it can't be
    // trusted), and the call re-resolves in the foreground instead.
    let callCount = 0;
    let remoteValid = true;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        return `v${callCount}`;
      },
      {
        maxAge: 1,
        staleMaxAge: 10,
        swr: true,
        validate: async (entry) => {
          await new Promise((r) => setTimeout(r, 1));
          return remoteValid && entry.value !== undefined;
        },
      },
    );

    expect(await fn()).toBe("v1");
    // Within maxAge, async validate passes -> cache hit
    expect(await fn()).toBe("v1");
    expect(callCount).toBe(1);

    // Async validate now reports invalid -> re-resolve in foreground (no stale served)
    remoteValid = false;
    expect(await fn()).toBe("v2");
    expect(callCount).toBe(2);
  });

  it("handles cache read errors gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    useTestStorage({
      get: () => Promise.reject(new Error("read error")),
      set: () => {},
    });

    const fn = defineCachedFunction(() => "value", { maxAge: 10 });
    expect(await fn()).toBe("value");
    expect(errorSpy).toHaveBeenCalledWith("[cache] Cache read error.", expect.any(Error));
    errorSpy.mockRestore();
  });

  it("handles sync cache read errors gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    useTestStorage({
      get: () => {
        throw new Error("sync read error");
      },
      set: () => {},
    });

    const fn = defineCachedFunction(() => "value", { maxAge: 10 });
    expect(await fn()).toBe("value");
    expect(errorSpy).toHaveBeenCalledWith("[cache] Cache read error.", expect.any(Error));
    errorSpy.mockRestore();
  });

  it("handles cache write errors gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    useTestStorage({
      get: () => null,
      set: () => Promise.reject(new Error("write error")),
    });

    const fn = defineCachedFunction(() => "value", { maxAge: 10, swr: false });
    expect(await fn()).toBe("value");
    await new Promise((r) => setTimeout(r, 10));
    expect(errorSpy).toHaveBeenCalledWith("[cache] Cache write error.", expect.any(Error));
    errorSpy.mockRestore();
  });

  it("handles sync cache write errors gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    useTestStorage({
      get: () => null,
      set: () => {
        throw new Error("sync write error");
      },
    });

    const fn = defineCachedFunction(() => "value", { maxAge: 10, swr: false });
    expect(await fn()).toBe("value");
    await new Promise((r) => setTimeout(r, 10));
    expect(errorSpy).toHaveBeenCalledWith("[cache] Cache write error.", expect.any(Error));
    errorSpy.mockRestore();
  });

  it("handles cache eviction errors gracefully", async () => {
    const errors: unknown[] = [];
    useTestStorage({
      get: () => null,
      set: () => Promise.reject(new Error("evict error")),
    });

    const fn = defineCachedFunction(
      async () => {
        throw new Error("resolver error");
      },
      { maxAge: 10, getKey: () => "evict-key", onError: (e) => errors.push(e) },
    );

    // Original resolver error must propagate, not the eviction error
    await expect(fn()).rejects.toThrow("resolver error");
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("evict error");
  });

  it("handles sync cache eviction errors gracefully", async () => {
    const errors: unknown[] = [];
    useTestStorage({
      get: () => null,
      set: () => {
        throw new Error("sync evict error");
      },
    });

    const fn = defineCachedFunction(
      async () => {
        throw new Error("resolver error");
      },
      { maxAge: 10, getKey: () => "evict-key", onError: (e) => errors.push(e) },
    );

    // A sync throw from storage.set must not mask the original resolver error
    await expect(fn()).rejects.toThrow("resolver error");
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("sync evict error");
  });

  it("handles malformed cache data", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    useTestStorage({
      get: () => "not-an-object" as any,
      set: () => {},
    });

    const fn = defineCachedFunction(() => "value", { maxAge: 10 });
    expect(await fn()).toBe("value");
    expect(errorSpy).toHaveBeenCalledWith("[cache]", expect.any(Error));
    errorSpy.mockRestore();
  });

  it("uses waitUntil for background writes when available", async () => {
    const waitUntilFn = vi.fn();
    const fn = defineCachedFunction<string, [any]>((_event) => "value", {
      maxAge: 10,
      getKey: () => "test-key",
    });

    const req = new Request("http://localhost/test");
    (req as any).waitUntil = waitUntilFn;

    await fn({ req });
    expect(waitUntilFn).toHaveBeenCalled();
  });

  it("maxAge: 0 always expires (never caches)", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        return `v${callCount}`;
      },
      { maxAge: 0 },
    );

    expect(await fn()).toBe("v1");
    expect(await fn()).toBe("v2");
    expect(callCount).toBe(2);
  });

  // Named "caches indefinitely" for years, but `{}` merges the `maxAge: 1` default, so this
  // is the 1-second cache, not a no-expiry one — the only test that ever looked like it
  // covered cache-forever, and it never did (see "the no-lifetime invariant" describe).
  it("no maxAge option caches with the 1s default", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(() => {
      callCount++;
      return `v${callCount}`;
    }, {});

    expect(await fn()).toBe("v1");
    expect(await fn()).toBe("v1");
    expect(callCount).toBe(1);
  });

  it("SWR returns stale value and revalidates in background", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        return `v${callCount}`;
      },
      { maxAge: 0.001, swr: true },
    );

    expect(await fn()).toBe("v1");
    await new Promise((r) => setTimeout(r, 10));
    // Entry is now expired. With SWR, the stale value should be returned
    // but the resolver is called in the background.
    // However, since there's no waitUntil and the value is expired,
    // the _resolvePromise runs but entry.value is already set, so SWR returns it.
    const r2 = await fn();
    // SWR mode: if entry.value exists, it returns early with the stale value
    // The resolve promise runs in the background
    expect(callCount).toBe(2);
    // The stale value, exactly as for an async resolver (the sibling test below). It used to
    // be `v2` here: a *sync* resolver settled its shared promise within the microtask ticks
    // the serve path spends on `validate`, so the background refresh's write to the live
    // entry landed before this call returned. `maxResolveTime` puts one more promise between
    // the resolution and that write, so the accident no longer fires and both resolver shapes
    // now agree on what SWR means.
    expect(r2).toBe("v1");
  });

  it("SWR returns stale value for async resolver", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 50));
        return `v${callCount}`;
      },
      { maxAge: 0.001, swr: true },
    );

    expect(await fn()).toBe("v1");
    await new Promise((r) => setTimeout(r, 10));
    // Now expired. SWR should return stale value while async resolver runs in bg
    const r2 = await fn();
    expect(r2).toBe("v1"); // stale value
    await new Promise((r) => setTimeout(r, 60));
    expect(callCount).toBe(2); // resolver was called in background
  });

  it("swr=false clears entry before resolving on expiry", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        return `v${callCount}`;
      },
      { maxAge: 0.001, swr: false },
    );

    expect(await fn()).toBe("v1");
    await new Promise((r) => setTimeout(r, 10));
    expect(await fn()).toBe("v2");
    expect(callCount).toBe(2);
  });

  it("sets storage TTL when swr is false", async () => {
    const setSpy = vi.fn();
    useTestStorage({
      get: () => null,
      set: setSpy,
    });

    const fn = defineCachedFunction(() => "value", { maxAge: 60, swr: false });
    await fn();
    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(Object), { ttl: 60 });
  });

  it("handles SWR error in background gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let callCount = 0;
    const fn = defineCachedFunction(
      async () => {
        callCount++;
        if (callCount > 1) {
          await new Promise((r) => setTimeout(r, 5));
          throw new Error("bg error");
        }
        return "value";
      },
      { maxAge: 0.001, swr: true },
    );

    expect(await fn()).toBe("value");
    await new Promise((r) => setTimeout(r, 10));
    expect(await fn()).toBe("value");
    await new Promise((r) => setTimeout(r, 20));
    expect(errorSpy).toHaveBeenCalledWith("[cache] SWR handler error.", expect.any(Error));
    errorSpy.mockRestore();
  });

  it("SWR with staleMaxAge serves stale within window then expires", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 5));
        return `v${callCount}`;
      },
      { maxAge: 0.01, swr: true, staleMaxAge: 0.02 },
    );

    // Initial call
    expect(await fn()).toBe("v1");
    expect(callCount).toBe(1);

    // Wait for maxAge to expire but within staleMaxAge window
    await new Promise((r) => setTimeout(r, 15));
    // SWR should return stale value while revalidating in background
    const r2 = await fn();
    expect(r2).toBe("v1"); // stale value served
    expect(callCount).toBe(2); // resolver triggered in background

    // Wait for background resolve to finish
    await new Promise((r) => setTimeout(r, 10));

    // Wait for both maxAge + staleMaxAge to fully expire
    await new Promise((r) => setTimeout(r, 40));
    // Now entry is fully expired — SWR should NOT serve stale, must await fresh value
    const r3 = await fn();
    expect(r3).toBe("v3");
    expect(callCount).toBe(3);
  });

  // Regression: nitro#1992 / nitro#4060 — SWR should stop serving stale when background
  // revalidation throws (e.g. handler returns 404 error).
  // After a bg revalidation error, the stale cache entry should be removed from storage
  // so that the NEXT request does not serve the old stale value again.
  it("SWR evicts stale entry from storage when background revalidation throws", async () => {
    const errors: unknown[] = [];
    let callCount = 0;
    let shouldThrow = false;
    const fn = defineCachedFunction(
      async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 5));
        if (shouldThrow) {
          throw new Error("handler 404");
        }
        return `v${callCount}`;
      },
      {
        maxAge: 0.001,
        swr: true,
        staleMaxAge: 10,
        getKey: () => "swr-throw-key",
        onError: (e) => errors.push(e),
      },
    );

    // Prime cache
    expect(await fn()).toBe("v1");
    expect(callCount).toBe(1);

    // Wait for maxAge to expire
    await new Promise((r) => setTimeout(r, 10));

    // Now make the resolver throw
    shouldThrow = true;

    // SWR returns stale "v1" while revalidation runs in background
    const r2 = await fn();
    expect(r2).toBe("v1");

    // Wait for background revalidation to complete (and throw)
    await new Promise((r) => setTimeout(r, 20));
    expect(callCount).toBe(2);

    // The stale entry should have been removed from storage after the bg error.
    const keys = await fn.resolveKeys();
    const staleEntry = await testStorage.get(keys[0]!);
    // BUG: stale entry persists in storage — it should be null after failed revalidation
    expect(staleEntry).toBeNull();
  });

  // Regression: nitro#1992 — SWR should stop serving stale when background
  // revalidation returns a value that fails validation (e.g. empty/404 response).
  // After a bg revalidation with invalid result, the stale cache entry should be
  // removed from storage so the NEXT request does not serve the old stale value.
  it("SWR evicts stale entry from storage when revalidation result fails validation", async () => {
    let callCount = 0;
    let returnEmpty = false;
    const fn = defineCachedFunction(
      async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 5));
        if (returnEmpty) {
          return undefined as any; // simulates empty/null/404 response
        }
        return `v${callCount}`;
      },
      {
        maxAge: 0.001,
        swr: true,
        staleMaxAge: 10,
        getKey: () => "swr-invalid-key",
        // Default validate rejects undefined values
      },
    );

    // Prime cache
    expect(await fn()).toBe("v1");
    expect(callCount).toBe(1);

    // Wait for maxAge to expire
    await new Promise((r) => setTimeout(r, 10));

    // Now make resolver return invalid value
    returnEmpty = true;

    // SWR returns stale while revalidating in background
    const r2 = await fn();
    expect(r2).toBe("v1");

    // Wait for bg revalidation to complete
    await new Promise((r) => setTimeout(r, 20));

    // The stale entry should have been removed from storage because the
    // bg revalidation produced an invalid result (undefined).
    const keys = await fn.resolveKeys();
    const staleEntry = await testStorage.get(keys[0]!);
    // BUG: stale entry persists in storage — it should be null after failed revalidation
    expect(staleEntry).toBeNull();
  });

  it("SWR without staleMaxAge serves stale indefinitely", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 5));
        return `v${callCount}`;
      },
      { maxAge: 0.01, swr: true },
    );

    expect(await fn()).toBe("v1");
    await new Promise((r) => setTimeout(r, 50));
    // Even after long time, SWR without staleMaxAge should still serve stale
    const r2 = await fn();
    expect(r2).toBe("v1"); // stale value
    expect(callCount).toBe(2); // revalidating in background
  });

  it("sets storage TTL to maxAge + staleMaxAge when SWR with staleMaxAge", async () => {
    const setSpy = vi.fn();
    useTestStorage({
      get: () => null,
      set: setSpy,
    });

    const fn = defineCachedFunction(() => "value", {
      maxAge: 60,
      swr: true,
      staleMaxAge: 120,
    });
    await fn();
    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(Object), { ttl: 180 });
  });

  // The ISR shape, asserted from the storage side: the entry IS written (so it can be served
  // stale later — see "SWR without staleMaxAge serves stale indefinitely") but with no TTL,
  // so nothing deletes it at `maxAge`. Arming `{ ttl: maxAge }` here (finding 14.3's proposed
  // fix) would drop the entry the instant it goes stale and turn SWR into foreground
  // revalidation; the bound on this shape is storage capacity (14.1), not a timer.
  it("does not set storage TTL when SWR without staleMaxAge", async () => {
    const setSpy = vi.fn();
    useTestStorage({
      get: () => null,
      set: setSpy,
    });

    const fn = defineCachedFunction(() => "value", {
      maxAge: 60,
      swr: true,
    });
    await fn();
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ value: "value" }),
      undefined,
    );
  });

  it("SWR with staleMaxAge: 0 never serves stale", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      async () => {
        callCount++;
        return `v${callCount}`;
      },
      { maxAge: 0.01, swr: true, staleMaxAge: 0 },
    );

    expect(await fn()).toBe("v1");
    await new Promise((r) => setTimeout(r, 20));
    // staleMaxAge: 0 means the stale window is zero — entry is fully expired
    const r2 = await fn();
    expect(r2).toBe("v2");
    expect(callCount).toBe(2);
  });

  it("SWR with maxAge: 0 and staleMaxAge: 0 blocks revalidation instead of serving stale", async () => {
    let callCount = 0;
    const fn = defineCachedFunction<string, [any]>(
      async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 20));
        return `v${callCount}`;
      },
      { maxAge: 0, swr: true, staleMaxAge: 0, getKey: () => "k" },
    );
    // Event with waitUntil so the first entry is actually persisted before the 2nd read.
    const makeEv = () => ({
      req: Object.assign(new Request("http://localhost/"), { waitUntil: () => {} }),
    });

    expect(await fn(makeEv())).toBe("v1");
    await new Promise((r) => setTimeout(r, 5));
    // A zero stale window must revalidate in the foreground, never serve the stale value —
    // previously the fully-expired check skipped maxAge: 0 (ttl === 0), so this returned the
    // stale "v1" (with x-cache "STALE") instead of blocking for the fresh "v2".
    const r2 = await fn(makeEv());
    expect(r2).toBe("v2");
    expect(callCount).toBe(2);
  });

  it("waitUntil is used for SWR background revalidation", async () => {
    const waitUntilFn = vi.fn();
    let callCount = 0;
    const fn = defineCachedFunction<string, [any]>(
      async (_event) => {
        callCount++;
        await new Promise((r) => setTimeout(r, 5));
        return `v${callCount}`;
      },
      { maxAge: 0.001, swr: true, getKey: () => "swr-key" },
    );

    const req1 = new Request("http://localhost/test");
    (req1 as any).waitUntil = waitUntilFn;
    await fn({ req: req1 });

    await new Promise((r) => setTimeout(r, 10));

    const req2 = new Request("http://localhost/test");
    (req2 as any).waitUntil = waitUntilFn;
    await fn({ req: req2 });

    expect(waitUntilFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// Regression: unjs/ocache#53 — defaultCacheOptions() merged `name: "_"` before the
// `opts.name || fn.name || "_"` fallback ran, making `fn.name` dead code. Every unnamed
// cached function then resolved to the same storage key (`/cache:functions:_:.json`),
// silently colliding across distinct functions.
describe("cache key name resolution (#53)", () => {
  it("uses fn.name in the storage key when no name option is given", async () => {
    const getUser = defineCachedFunction(async function getUser() {
      return "user";
    });
    const getPost = defineCachedFunction(async function getPost() {
      return "post";
    });

    const userKey = (await getUser.resolveKeys())[0]!;
    const postKey = (await getPost.resolveKeys())[0]!;

    expect(userKey).toBe("/cache:functions:getUser:.json");
    expect(postKey).toBe("/cache:functions:getPost:.json");
    expect(userKey).not.toBe(postKey);
  });

  it("does not collide cached values across distinct named functions", async () => {
    const getUser = defineCachedFunction(async function getUser() {
      return "user-value";
    });
    const getPost = defineCachedFunction(async function getPost() {
      return "post-value";
    });

    expect(await getUser()).toBe("user-value");
    expect(await getPost()).toBe("post-value");
  });

  it("explicit name option still overrides fn.name", async () => {
    const fn = defineCachedFunction(
      async function actualName() {
        return 1;
      },
      { name: "custom" },
    );
    expect((await fn.resolveKeys())[0]).toBe("/cache:functions:custom:.json");
  });

  it("anonymous function falls back to a stable hash of its source", async () => {
    const fn = defineCachedFunction(async () => 1);
    const key = (await fn.resolveKeys())[0]!;
    // The base64url alphabet includes `-`, which the key escape drops — so a slice carrying one
    // takes the escaped-plus-hash form (see "cache key name escaping"). Both are accepted.
    expect(key).toMatch(/^\/cache:functions:anon_\w{1,16}(\.[\w-]+)?:\.json$/);
    // Stable across separate definitions of the identical function source.
    const same = defineCachedFunction(async () => 1);
    expect((await same.resolveKeys())[0]).toBe(key);
  });

  it("distinct anonymous functions get distinct keys (no thrash)", async () => {
    let aCalls = 0;
    let bCalls = 0;
    const a = defineCachedFunction(
      () => {
        aCalls++;
        return "A";
      },
      { maxAge: 1000 },
    );
    const b = defineCachedFunction(
      () => {
        bCalls++;
        return "B";
      },
      { maxAge: 1000 },
    );

    const aKey = (await a.resolveKeys())[0]!;
    const bKey = (await b.resolveKeys())[0]!;
    expect(aKey).not.toBe(bKey);

    // Interleaved calls must not evict each other: each resolves exactly once.
    for (let i = 0; i < 3; i++) {
      expect(await a()).toBe("A");
      expect(await b()).toBe("B");
    }
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
  });
});

// Regression: `defineCachedHandler` merged `defaultCacheOptions()` (`name: "_"`) before
// delegating to `cachedFunction`, so the `opts.name || fn.name || anon_<hash>` resolution
// above was unreachable and EVERY handler keyed as `_`. Two handlers sharing one storage
// (the configuration the `storage` docs recommend) then collided on the same path: same
// source => same integrity => one served the other's cached response; different sources =>
// each read failed the other's integrity check => 0% hit rate.
describe("handler cache key name resolution", () => {
  const handlerEvent = (path: string) => ({ req: new Request(`http://localhost${path}`) });

  it("gives two handlers sharing one storage distinct keys on the same path", async () => {
    const storage = createMemoryStorage();
    const acme = _defineCachedHandler(() => new Response("tenant=ACME"), { maxAge: 60, storage });
    const globex = _defineCachedHandler(() => new Response("tenant=GLOBEX; other source"), {
      maxAge: 60,
      storage,
    });

    const acmeKey = (await acme.resolveKeys(handlerEvent("/dashboard")))[0]!;
    const globexKey = (await globex.resolveKeys(handlerEvent("/dashboard")))[0]!;
    expect(acmeKey).not.toBe(globexKey);
    expect(acmeKey).toMatch(/^\/cache:handlers:anon_\w{1,16}(\.[\w-]+)?:dashboard\./);

    // …and they never serve each other's responses, in either order.
    expect(await ((await acme(handlerEvent("/dashboard"))) as Response).text()).toBe("tenant=ACME");
    expect(await ((await globex(handlerEvent("/dashboard"))) as Response).text()).toBe(
      "tenant=GLOBEX; other source",
    );
    expect(await ((await acme(handlerEvent("/dashboard"))) as Response).text()).toBe("tenant=ACME");
  });

  it("uses handler.name in the storage key when no name option is given", async () => {
    const storage = createMemoryStorage();
    const dashboard = _defineCachedHandler(
      async function dashboard() {
        return new Response("dash");
      },
      { maxAge: 60, storage },
    );
    const profile = _defineCachedHandler(
      async function profile() {
        return new Response("profile");
      },
      { maxAge: 60, storage },
    );

    expect((await dashboard.resolveKeys(handlerEvent("/x")))[0]).toMatch(
      /^\/cache:handlers:dashboard:/,
    );
    expect((await profile.resolveKeys(handlerEvent("/x")))[0]).toMatch(
      /^\/cache:handlers:profile:/,
    );
  });

  it("explicit name option still overrides handler.name", async () => {
    const storage = createMemoryStorage();
    const handler = _defineCachedHandler(
      async function actualName() {
        return new Response("v");
      },
      { maxAge: 60, name: "custom", storage },
    );
    expect((await handler.resolveKeys(handlerEvent("/x")))[0]).toMatch(/^\/cache:handlers:custom:/);
  });

  // DOCUMENTED CAVEAT, not a bug: the anonymous fallback hashes the handler *source*, and
  // two handlers built by one factory have identical source — only their closed-over
  // variables differ, which no source hash can see. They therefore share a name (and, since
  // the integrity hash is derived from the same source, share entries outright when they
  // also share a storage). A per-instance discriminator (counter/WeakMap/random) is not an
  // option: keys must be stable across process restarts for persistent/shared backends.
  // The fix is an explicit `name`, asserted in the second half of this test.
  it("same-factory handlers share a key unless given an explicit name", async () => {
    const storage = createMemoryStorage();
    const make = (tenant: string) =>
      _defineCachedHandler(() => new Response(`tenant=${tenant}`), { maxAge: 60, storage });

    const acme = make("ACME");
    const globex = make("GLOBEX");
    expect((await acme.resolveKeys(handlerEvent("/dash")))[0]).toBe(
      (await globex.resolveKeys(handlerEvent("/dash")))[0],
    );
    // Same source => same integrity too, so the collision is a cross-handler HIT.
    expect(await ((await acme(handlerEvent("/dash"))) as Response).text()).toBe("tenant=ACME");
    expect(await ((await globex(handlerEvent("/dash"))) as Response).text()).toBe("tenant=ACME");

    // The documented fix: name the instances.
    const namedMake = (tenant: string) =>
      _defineCachedHandler(() => new Response(`tenant=${tenant}`), {
        maxAge: 60,
        name: `tenant-${tenant}`,
        storage,
      });
    const acme2 = namedMake("ACME");
    const globex2 = namedMake("GLOBEX");
    expect((await acme2.resolveKeys(handlerEvent("/dash2")))[0]).not.toBe(
      (await globex2.resolveKeys(handlerEvent("/dash2")))[0],
    );
    expect(await ((await acme2(handlerEvent("/dash2"))) as Response).text()).toBe("tenant=ACME");
    expect(await ((await globex2(handlerEvent("/dash2"))) as Response).text()).toBe(
      "tenant=GLOBEX",
    );
  });
});

// `buildCacheKey` joins `[base, group, name, key]` with `:` and used to escape everything but
// `name` — harmless while every handler keyed as the literal `_`, but `name` now comes from
// `fn.name`, which is not a controlled alphabet (`named.bind(null)` alone yields `bound named`).
// An unescaped `:` in it could rebuild another handler's `HEAD:` variant key verbatim.
describe("cache key name escaping", () => {
  const handlerEvent = (path: string, method = "GET") => ({
    req: new Request(`http://localhost${path}`, { method }),
  });

  it("leaves an ordinary identifier name byte-identical", async () => {
    // The whole point of escaping this late: no existing entry moves unless its name actually
    // carries an escapable character.
    const fn = defineCachedFunction(async function getUser() {
      return "u";
    });
    expect((await fn.resolveKeys())[0]).toBe("/cache:functions:getUser:.json");

    const named = defineCachedFunction(() => "v", { name: "my_fn_2", getKey: () => "k" });
    expect((await named.resolveKeys())[0]).toBe("/cache:functions:my_fn_2:k.json");
  });

  it("keeps a `:` in the name out of the key's segment structure", async () => {
    const fn = defineCachedFunction(() => "v", { name: "a:b", getKey: () => "k", maxAge: 60 });
    const key = (await fn.resolveKeys())[0]!;
    // base : group : name : key — exactly four segments, whatever the name contained.
    expect(key.split(":")).toHaveLength(4);
    expect(key).toMatch(/^\/cache:functions:ab\.[\w-]+:k\.json$/);
  });

  it("keeps a space in the name (a bound function) out of the key", async () => {
    function render() {
      return "v";
    }
    const fn = defineCachedFunction(render.bind(null), { getKey: () => "k" });
    const key = (await fn.resolveKeys())[0]!;
    expect(key.split(":")).toHaveLength(4);
    expect(key).not.toContain(" ");
    expect(key).toMatch(/^\/cache:functions:boundrender\.[\w-]+:k\.json$/);
  });

  it("round-trips an escaped name through resolveKeys/invalidate/expire", async () => {
    const storage = createMemoryStorage();
    let calls = 0;
    const opts = { name: "a:b c", getKey: () => "k", maxAge: 60, storage };
    const fn = _defineCachedFunction(() => `v${++calls}`, opts);

    expect(await fn()).toBe("v1");
    expect(await fn()).toBe("v1");

    // The key the write path used is the key the helpers reconstruct.
    const key = (await fn.resolveKeys())[0]!;
    expect(await storage.get(key)).toMatchObject({ value: "v1" });
    expect((await resolveCacheKeys({ options: opts }))[0]).toBe(key);

    await fn.expire();
    expect(await storage.get(key)).toMatchObject({ value: "v1", stale: true });
    expect(await fn()).toBe("v2");

    await fn.invalidate();
    expect(await storage.get(key)).toBeNull();
    expect(await fn()).toBe("v3");

    // …and so does the standalone helper, handed the same name.
    await invalidateCache({ options: opts });
    expect(await storage.get(key)).toBeNull();
    expect(await fn()).toBe("v4");
  });

  it("does not collide two names differing only in where the escapable character sits", async () => {
    const storage = createMemoryStorage();
    const ab = _defineCachedFunction(() => "A", { name: "a:bc", getKey: () => "k", storage });
    const bc = _defineCachedFunction(() => "B", { name: "ab:c", getKey: () => "k", storage });

    expect((await ab.resolveKeys())[0]).not.toBe((await bc.resolveKeys())[0]);
    expect(await ab()).toBe("A");
    expect(await bc()).toBe("B");
    expect(await ab()).toBe("A");
  });

  // The sharp case: pre-fix, a handler named `page:HEAD` built exactly the key a `page`
  // handler's HEAD variant writes — `/cache:handlers:page:HEAD:<resource>.json` — so one
  // anonymous HEAD seeded the other handler's GET entry (h3#1524 finding #3, one segment over).
  it("cannot forge another handler's HEAD variant key from the name", async () => {
    const storage = createMemoryStorage();
    const trap = _defineCachedHandler(() => new Response("trap"), {
      maxAge: 60,
      name: "page:HEAD",
      storage,
    });
    const page = _defineCachedHandler(() => new Response("page"), {
      maxAge: 60,
      name: "page",
      storage,
    });

    const [pageGet, pageHead] = await page.resolveKeys(handlerEvent("/x"));
    const trapGet = (await trap.resolveKeys(handlerEvent("/x")))[0]!;
    // The key the trap's name spelled out verbatim before it was escaped.
    expect(pageHead).toBe(pageGet!.replace("/cache:handlers:page:", "/cache:handlers:page:HEAD:"));
    expect(trapGet).not.toBe(pageHead);
    expect(trapGet).not.toBe(pageGet);

    // Neither serves the other, in either order.
    await page(handlerEvent("/x", "HEAD"));
    expect(await ((await trap(handlerEvent("/x"))) as Response).text()).toBe("trap");
    expect(await ((await page(handlerEvent("/x"))) as Response).text()).toBe("page");
  });

  it("round-trips an escaped handler name through the revalidation helpers", async () => {
    const storage = createMemoryStorage();
    let calls = 0;
    const handler = _defineCachedHandler(() => new Response(`call-${++calls}`), {
      maxAge: 60,
      name: "tenant a:b",
      storage,
    });

    expect(await ((await handler(handlerEvent("/r"))) as Response).text()).toBe("call-1");
    expect(await ((await handler(handlerEvent("/r"))) as Response).text()).toBe("call-1");

    const keys = await handler.resolveKeys(handlerEvent("/r"));
    expect(keys[0]).toMatch(/^\/cache:handlers:tenantab\.[\w-]+:r\./);
    expect(await storage.get(keys[0]!)).toBeTruthy();

    await handler.invalidate(handlerEvent("/r"));
    expect(await storage.get(keys[0]!)).toBeNull();
    expect(await ((await handler(handlerEvent("/r"))) as Response).text()).toBe("call-2");
  });
});

describe("getMaxAge (dynamic per-entry TTL)", () => {
  it("derives maxAge from the resolved value for the freshness check", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        // First resolve is short-lived, later resolves long-lived
        return { value: `v${callCount}`, expiresIn: callCount === 1 ? 0.01 : 10 };
      },
      {
        swr: false,
        getKey: () => "dyn-key",
        // Number shorthand for maxAge
        getMaxAge: (entry) => entry.value?.expiresIn,
      },
    );

    expect((await fn()).value).toBe("v1");
    expect(callCount).toBe(1);

    // Within the per-entry maxAge (0.01s) — served from cache
    expect((await fn()).value).toBe("v1");
    expect(callCount).toBe(1);

    // Wait past the first entry's short maxAge — re-resolves
    await new Promise((r) => setTimeout(r, 20));
    expect((await fn()).value).toBe("v2");
    expect(callCount).toBe(2);

    // Second entry has a long maxAge — stays cached past the first entry's window
    await new Promise((r) => setTimeout(r, 20));
    expect((await fn()).value).toBe("v2");
    expect(callCount).toBe(2);
  });

  it("persists the resolved TTL on the stored entry", async () => {
    const fn = defineCachedFunction(() => ({ n: 1 }), {
      maxAge: 5,
      getKey: () => "persist-key",
      getMaxAge: () => ({ maxAge: 42, staleMaxAge: 7 }),
    });

    await fn();

    const keys = await fn.resolveKeys();
    const entry = (await testStorage.get(keys[0]!)) as any;
    expect(entry.maxAge).toBe(42);
    expect(entry.staleMaxAge).toBe(7);
  });

  it("falls back to static options when getMaxAge returns undefined", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        return callCount;
      },
      {
        maxAge: 10,
        swr: false,
        getKey: () => "fallback-key",
        getMaxAge: () => undefined,
      },
    );

    expect(await fn()).toBe(1);
    // Static maxAge of 10s still applies — served from cache
    expect(await fn()).toBe(1);
    expect(callCount).toBe(1);

    const keys = await fn.resolveKeys();
    const entry = (await testStorage.get(keys[0]!)) as any;
    expect(entry.maxAge).toBeUndefined();
  });

  it("uses the per-entry stale window for SWR", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 5));
        return `v${callCount}`;
      },
      {
        swr: true,
        getKey: () => "swr-dyn-key",
        getMaxAge: () => ({ maxAge: 0.01, staleMaxAge: 10 }),
      },
    );

    expect(await fn()).toBe("v1");
    expect(callCount).toBe(1);

    // Past per-entry maxAge but within staleMaxAge — serves stale, revalidates in background
    await new Promise((r) => setTimeout(r, 15));
    expect(await fn()).toBe("v1");
    expect(callCount).toBe(2);
  });

  it("continues writing the entry when getMaxAge throws (reports via onError)", async () => {
    const errors: unknown[] = [];
    let callCount = 0;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        return callCount;
      },
      {
        maxAge: 10,
        swr: false,
        getKey: () => "throw-key",
        getMaxAge: () => {
          throw new Error("boom");
        },
        onError: (e) => errors.push(e),
      },
    );

    expect(await fn()).toBe(1);
    // getMaxAge threw, but the entry is still cached using static options
    expect(await fn()).toBe(1);
    expect(callCount).toBe(1);
    expect(errors.length).toBe(1);
  });

  it("clamps a negative maxAge to 0 (re-resolves every access, never cached forever)", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        return callCount;
      },
      {
        maxAge: 10,
        swr: false,
        getKey: () => "negative-key",
        // A negative TTL (e.g. an already-expired token) must not pin the entry as fresh
        getMaxAge: () => -5,
      },
    );

    expect(await fn()).toBe(1);
    expect(await fn()).toBe(2);
    expect(callCount).toBe(2);

    // A clamped-to-zero lifetime is not stored at all now: the entry could never be served
    // (zero maxAge reads as expired on arrival), and writing it left storage holding an entry
    // with neither an expiry nor a TTL — dead weight only a manual purge removed.
    const keys = await fn.resolveKeys();
    expect(await testStorage.get(keys[0]!)).toBeNull();
  });

  it("respects per-entry TTL when expiring via expireCache", async () => {
    const options = {
      // Standalone helpers (expireCache) can't see `fn`, so an anonymous function's
      // hash-derived name wouldn't line up — pass an explicit `name` to keep keys aligned.
      name: "expire-dyn",
      swr: true,
      getKey: () => "expire-dyn-key",
      getMaxAge: () => ({ maxAge: 60, staleMaxAge: 120 }),
    };
    const fn = defineCachedFunction(() => "value", options);

    await fn();
    const keys = await fn.resolveKeys();
    expect(((await testStorage.get(keys[0]!)) as any).stale).toBeUndefined();

    await expireCache({ options, args: [] });
    const entry = (await testStorage.get(keys[0]!)) as any;
    expect(entry.stale).toBe(true);
    // Entry value is preserved for SWR to keep serving
    expect(entry.value).toBe("value");
  });
});

// One rule, checked from both sides: a write gets a storage TTL covering exactly the window
// the entry may still be served in, and an entry with neither an expiry nor a TTL is never
// written at all (findings 14.3 and 10.6).
describe("storage TTL and the no-lifetime invariant", () => {
  let testId = 0;
  const makeEvent = (path: string) => ({ req: new Request(`http://localhost${path}`) });
  const uniquePath = () => `/ttl-${++testId}-${Date.now()}`;

  // The ISR semantic end to end: `revalidate` marks an entry eligible for regeneration, it
  // never deletes it. Finding 14.3 proposed bounding this shape with a `{ ttl: maxAge }`
  // storage TTL — that would delete the entry at the exact moment this test reads it stale,
  // so SWR would degrade to foreground revalidation. The bound is storage capacity (14.1).
  it("swr with no staleMaxAge serves STALE past maxAge and refreshes in the background", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`v${callCount}`);
      },
      { maxAge: 0.05, swr: true },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    expect(r1.headers.get("x-cache")).toBe("MISS");
    expect(await r1.text()).toBe("v1");

    const [key] = await handler.resolveKeys(makeEvent(path));
    await new Promise((r) => setTimeout(r, 80));
    // Past `maxAge` and still resident: no storage TTL was armed, so nothing reclaimed it.
    expect(await testStorage.get(key!)).not.toBeNull();

    const r2 = (await handler(makeEvent(path))) as Response;
    expect(r2.headers.get("x-cache")).toBe("STALE");
    expect(await r2.text()).toBe("v1");

    await new Promise((r) => setTimeout(r, 20));
    expect(callCount).toBe(2); // refreshed in the background
    const r3 = (await handler(makeEvent(path))) as Response;
    expect(r3.headers.get("x-cache")).toBe("HIT");
    expect(await r3.text()).toBe("v2");
  });

  it("swr with staleMaxAge and a zero maxAge caches nothing, for a function", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        return `v${callCount}`;
      },
      { swr: true, staleMaxAge: 600, maxAge: 0, getKey: () => "swr-zero-maxage" },
    );

    // A zero lifetime under SWR used to store an entry with no expiry and no storage TTL —
    // cached forever while advertising itself as immediately stale. Nothing is stored now.
    // (`maxAge: undefined` is NOT this config: an explicitly-undefined option reads as unset,
    // so it takes the `maxAge: 1` default — see "explicitly-undefined options".)
    expect(await fn()).toBe("v1");
    expect(await fn()).toBe("v2");
    expect(callCount).toBe(2);
    const keys = await fn.resolveKeys();
    expect(await testStorage.get(keys[0]!)).toBeNull();
  });

  it("swr with staleMaxAge and a zero maxAge caches nothing, for a handler (and says so)", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`v${callCount}`);
      },
      { swr: true, staleMaxAge: 600, maxAge: 0 },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    const r2 = (await handler(makeEvent(path))) as Response;

    // The zero lifetime is advertised (`s-maxage=0`), and `validate` reads it back as the
    // storage opt-out it is — so the handler runs every time and nothing is stored.
    expect(r1.headers.get("cache-control")).toBe(
      "max-age=0, s-maxage=0, stale-while-revalidate=600",
    );
    expect(await r2.text()).toBe("v2");
    expect(r2.headers.get("x-cache")).toBe("MISS");
    expect(callCount).toBe(2);
    const keys = await handler.resolveKeys(makeEvent(path));
    expect(await testStorage.get(keys[0]!)).toBeNull();
  });

  it("swr with a getMaxAge hook and no static maxAge still caches (the hook is the lifetime)", async () => {
    const setSpy = vi.spyOn(testStorage, "set");
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`v${callCount}`);
      },
      // The documented per-route ISR shape: the window comes from the value, not a static
      // option, so this is not a "missing maxAge" and must not read as a zero lifetime.
      { swr: true, getMaxAge: () => 60 },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    const r2 = (await handler(makeEvent(path))) as Response;

    expect(r1.headers.get("x-cache")).toBe("MISS");
    expect(r2.headers.get("x-cache")).toBe("HIT");
    expect(callCount).toBe(1);
    // Stored, and — being the SWR-with-no-`staleMaxAge` (ISR) shape — with no storage TTL.
    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(Object), undefined);
  });

  it("a getMaxAge hook that supplies no lifetime falls back to the refused write", async () => {
    const setSpy = vi.spyOn(testStorage, "set");
    let callCount = 0;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        return `v${callCount}`;
      },
      // The hook declines to give this entry a lifetime, so the static option decides — and
      // that one is a refused write.
      { swr: true, maxAge: 0, getMaxAge: () => undefined, getKey: () => "hook-nothing" },
    );

    expect(await fn()).toBe("v1");
    expect(await fn()).toBe("v2");
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("never writes an entry with neither an expiry nor a storage TTL", async () => {
    const setSpy = vi.spyOn(testStorage, "set");
    let callCount = 0;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        return `v${callCount}`;
      },
      { maxAge: 0, swr: false, getKey: () => "no-lifetime" },
    );

    expect(await fn()).toBe("v1");
    await new Promise((r) => setTimeout(r, 20));
    // A zero (or nullish) lifetime used to store an entry with no `expires` and no TTL and
    // serve it as a permanent HIT — indistinguishable from a leak. Refused outright now, so
    // the value is simply re-resolved.
    expect(await fn()).toBe("v2");
    expect(callCount).toBe(2);
    expect(setSpy).not.toHaveBeenCalled();
    const keys = await fn.resolveKeys();
    expect(await testStorage.get(keys[0]!)).toBeNull();
  });

  it("evicts a pre-existing no-lifetime entry instead of rewriting it", async () => {
    const fn = defineCachedFunction(() => "fresh", {
      maxAge: 0,
      getKey: () => "legacy",
    });
    const [key] = await fn.resolveKeys();
    // What an older ocache left behind: a value with no expiry, no TTL, and a stale integrity.
    await testStorage.set(key!, { value: "legacy", mtime: Date.now(), integrity: "old" });

    expect(await fn()).toBe("fresh");

    expect(await testStorage.get(key!)).toBeNull();
  });

  it("treats staleMaxAge: 0 as a named zero window, not as unset", async () => {
    const setSpy = vi.spyOn(testStorage, "set");
    let callCount = 0;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        return `v${callCount}`;
      },
      { maxAge: 0.05, swr: true, staleMaxAge: 0, getKey: () => "zero-stale" },
    );

    // Stored and served fresh...
    expect(await fn()).toBe("v1");
    expect(await fn()).toBe("v1");
    expect(callCount).toBe(1);
    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(Object), { ttl: 0.05 });

    // ...but never served stale: the zero window revalidates in the foreground.
    await new Promise((r) => setTimeout(r, 60));
    expect(await fn()).toBe("v2");
    expect(callCount).toBe(2);
  });

  it("stores a must-revalidate response with a TTL of maxAge (per-entry staleMaxAge: 0)", async () => {
    const setSpy = vi.spyOn(testStorage, "set");
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`v${callCount}`, {
          headers: { "cache-control": "public, max-age=60, must-revalidate" },
        });
      },
      { maxAge: 60, swr: true, staleMaxAge: 600 },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    const r2 = (await handler(makeEvent(path))) as Response;

    // The internal `getMaxAge` wrapper persists `staleMaxAge: 0` on this entry, and a
    // per-entry `0` is a real window — not a missing one — so the TTL is `maxAge` alone
    // (60), never `maxAge + 600` from the static option it overrides.
    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(Object), { ttl: 60 });
    expect(r1.headers.get("x-cache")).toBe("MISS");
    expect(r2.headers.get("x-cache")).toBe("HIT");
    expect(callCount).toBe(1);
  });
});

// The synthesized `Cache-Control` states the lifetime ocache actually enforces for *this*
// entry: the one `getMaxAge` resolved onto it, else the static option (finding 10.2); with a
// `max-age` beside the shared-cache-only `s-maxage` (10.3); and never a bare, unparseable
// `stale-while-revalidate` (10.4).
describe("synthesized Cache-Control lifetimes", () => {
  let testId = 0;
  const makeEvent = (path: string) => ({ req: new Request(`http://localhost${path}`) });
  const uniquePath = () => `/cc-${++testId}-${Date.now()}`;

  /** Runs a handler once and reports the header it advertised. */
  async function advertised(opts: Record<string, unknown>, res?: () => Response) {
    const path = uniquePath();
    const handler = defineCachedHandler(res ?? (() => new Response("ok")), opts as any);
    const first = (await handler(makeEvent(path))) as Response;
    return first.headers.get("cache-control");
  }

  it("advertises the maxAge a getMaxAge hook returned as a number", async () => {
    // The static option said an hour; the hook says two seconds and ocache expires its own
    // entry on the two. Downstream used to be told the hour regardless.
    expect(await advertised({ maxAge: 3600, getMaxAge: () => 2 })).toBe("max-age=2");
  });

  it("advertises both lifetimes a getMaxAge hook returned as an object", async () => {
    expect(
      await advertised({
        maxAge: 3600,
        staleMaxAge: 7200,
        swr: true,
        getMaxAge: () => ({ maxAge: 2, staleMaxAge: 30 }),
      }),
    ).toBe("max-age=2, s-maxage=2, stale-while-revalidate=30");
  });

  it("falls back to the static options when the hook returns nothing", async () => {
    expect(
      await advertised({ maxAge: 60, staleMaxAge: 120, swr: true, getMaxAge: () => undefined }),
    ).toBe("max-age=60, s-maxage=60, stale-while-revalidate=120");
  });

  it("falls back per field: a hook giving only maxAge keeps the static staleMaxAge", async () => {
    // Exactly the precedence `cache.ts` applies to the freshness check and the storage TTL
    // (`entry.x ?? opts.x`), field by field — not all-or-nothing.
    expect(
      await advertised({
        maxAge: 60,
        staleMaxAge: 120,
        swr: true,
        getMaxAge: () => ({ maxAge: 5 }),
      }),
    ).toBe("max-age=5, s-maxage=5, stale-while-revalidate=120");
  });

  it("advertises a per-entry staleMaxAge of 0 as stale-while-revalidate=0", async () => {
    // A zero window is a real window ("never serve this stale"), and `cache.ts` honors it as
    // one — so it is advertised, exactly as a zero `maxAge` is.
    expect(await advertised({ maxAge: 60, swr: true, getMaxAge: () => ({ staleMaxAge: 0 }) })).toBe(
      "max-age=60, s-maxage=60, stale-while-revalidate=0",
    );
  });

  it("advertises a dynamic zero lifetime, and then stores nothing (no gap)", async () => {
    const setSpy = vi.spyOn(testStorage, "set");
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`v${callCount}`);
      },
      { maxAge: 600, swr: true, getMaxAge: () => 0 },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    const r2 = (await handler(makeEvent(path))) as Response;

    // The advertisement now moves with the storage decision: a hook clamping to 0 refuses the
    // write (`storageTtl`), and `validate` reads the same zero lifetime back out of our own
    // header. Before, the entry was refused while `s-maxage=600` shipped anyway.
    expect(r1.headers.get("cache-control")).toBe("max-age=0, s-maxage=0");
    expect(await r2.text()).toBe("v2");
    expect(callCount).toBe(2);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("never emits a bare stale-while-revalidate, whatever the shape", async () => {
    const shapes = [
      { maxAge: 60, swr: true },
      { swr: true, getMaxAge: () => 60 },
      { maxAge: 60, swr: true, staleMaxAge: undefined },
      { maxAge: 60, swr: true, getMaxAge: () => ({ maxAge: 30 }) },
    ];
    for (const shape of shapes) {
      const cc = await advertised(shape);
      // A delta-seconds or nothing — the bare token is unparseable (RFC 5861 §3), so a
      // conforming cache drops the whole directive and the window evaporates unannounced.
      expect(cc).not.toMatch(/stale-while-revalidate(?!=)/);
    }
  });

  it("keeps max-age alone when swr is off, whatever the hook says", async () => {
    // `s-maxage` is only synthesized under `swr`; without it `max-age` already governs both
    // cache kinds, so nothing is added.
    expect(await advertised({ maxAge: 60, staleMaxAge: 600, getMaxAge: () => 30 })).toBe(
      "max-age=30",
    );
    expect(await advertised({ maxAge: 0 })).toBe("max-age=0");
  });

  it("does not clobber a handler cache-control, whatever the hook resolved", async () => {
    expect(
      await advertised(
        { maxAge: 60, swr: true, staleMaxAge: 600, getMaxAge: () => 5 },
        () => new Response("ok", { headers: { "cache-control": "public, max-age=600" } }),
      ),
    ).toBe("public, max-age=600");
  });

  it("a must-revalidate response is stored on its own staleMaxAge: 0 and advertises nothing of ours", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`v${callCount}`, {
          headers: { "cache-control": "public, max-age=60, must-revalidate" },
        });
      },
      { maxAge: 60, swr: true, staleMaxAge: 600 },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    const r2 = (await handler(makeEvent(path))) as Response;

    // The internal wrapper's per-entry `staleMaxAge: 0` reaches the synthesis path like any
    // other resolved lifetime — but there is nothing to synthesize: the response carries the
    // handler's own header, which is where the `must-revalidate` came from in the first place.
    expect(r1.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
    expect(r2.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
    expect(r2.headers.get("x-cache")).toBe("HIT");
    expect(callCount).toBe(1);
  });

  it("sendCacheControl: false still suppresses everything, hook or no hook", async () => {
    expect(
      await advertised({ maxAge: 60, swr: true, getMaxAge: () => 5, sendCacheControl: false }),
    ).toBeNull();
  });
});

// `{ ...defaults(), ...opts }` copies undefined-valued own properties, so an explicit
// `undefined` used to clobber a default an absent key would have kept — the spelling plumbing
// produces (`{ maxAge: routeConfig.maxAge }` with an unset rule), never one anybody types.
// `definedOptions` drops them at both merge sites so the two spellings are indistinguishable.
describe("explicitly-undefined options are treated as unset", () => {
  let testId = 0;
  const makeEvent = (path: string) => ({ req: new Request(`http://localhost${path}`) });

  /** Runs a cached function twice; reports resolver calls and the TTL of every storage write. */
  async function runFn(opts: Record<string, unknown>) {
    const name = `undef-fn-${++testId}`;
    const setSpy = vi.spyOn(testStorage, "set");
    let calls = 0;
    const fn = defineCachedFunction(
      () => {
        calls++;
        return `v${calls}`;
      },
      // A per-run name/key: same-source functions would otherwise share both key and integrity.
      { name, getKey: () => name, ...opts },
    );
    await fn();
    await fn();
    const writes = setSpy.mock.calls.filter(([, value]) => value != null).map(([, , o]) => o);
    setSpy.mockRestore();
    return { calls, writes };
  }

  /** The same for a handler, plus what it advertised and how the second request was served. */
  async function runHandler(opts: Record<string, unknown>) {
    const path = `/undef-h-${++testId}`;
    const setSpy = vi.spyOn(testStorage, "set");
    let calls = 0;
    const handler = defineCachedHandler(
      () => {
        calls++;
        return new Response(`v${calls}`);
      },
      { name: `undef-h-${testId}`, ...opts },
    );
    await handler(makeEvent(path));
    const res = (await handler(makeEvent(path))) as Response;
    const writes = setSpy.mock.calls.filter(([, value]) => value != null).map(([, , o]) => o);
    setSpy.mockRestore();
    return {
      calls,
      writes,
      body: await res.text(),
      cacheControl: res.headers.get("cache-control"),
      status: res.headers.get("x-cache"),
    };
  }

  it("maxAge: undefined caches exactly like an absent maxAge (function)", async () => {
    // The measured divergence: `{}` resolved once and wrote `{ ttl: 1 }`, while
    // `{ maxAge: undefined }` resolved on every call and wrote nothing at all.
    expect(await runFn({ maxAge: undefined })).toEqual(await runFn({}));
    expect(await runFn({})).toEqual({ calls: 1, writes: [{ ttl: 1 }] });
  });

  it("maxAge: undefined caches exactly like an absent maxAge (handler)", async () => {
    const absent = await runHandler({});
    const explicit = await runHandler({ maxAge: undefined });
    expect(explicit).toEqual(absent);
    expect(absent).toMatchObject({
      calls: 1,
      writes: [{ ttl: 1 }],
      body: "v1",
      cacheControl: "max-age=1",
      status: "HIT",
    });
  });

  it("swr: undefined and staleMaxAge: undefined behave like absent ones", async () => {
    const absent = await runFn({ maxAge: 10 });
    expect(await runFn({ maxAge: 10, swr: undefined })).toEqual(absent);
    expect(await runFn({ maxAge: 10, staleMaxAge: undefined })).toEqual(absent);
    expect(await runFn({ maxAge: 10, swr: undefined, staleMaxAge: undefined })).toEqual(absent);
    expect(absent).toEqual({ calls: 1, writes: [{ ttl: 10 }] });

    // Same for the handler, where `swr` also decides which directive is synthesized.
    const swrAbsent = await runHandler({ maxAge: 60, staleMaxAge: 600 });
    expect(await runHandler({ maxAge: 60, staleMaxAge: 600, swr: undefined })).toEqual(swrAbsent);
    expect(swrAbsent.cacheControl).toBe("max-age=60");
  });

  it("storage: undefined still gets the per-instance default storage", async () => {
    let calls = 0;
    // The raw import: the test wrapper's `storage ??=` would fill an undefined one in itself.
    const fn = _defineCachedFunction(
      () => {
        calls++;
        return `v${calls}`;
      },
      { maxAge: 10, storage: undefined, name: "undef-storage", getKey: () => "k" },
    );

    expect(await fn()).toBe("v1");
    expect(await fn()).toBe("v1");
    expect(calls).toBe(1);
  });

  it("an option set to a real value still wins over the default", async () => {
    // The guard against over-stripping: only `undefined` goes, never a falsy value.
    expect(await runFn({ maxAge: 10 })).toEqual({ calls: 1, writes: [{ ttl: 10 }] });
    expect(await runFn({ maxAge: 60, swr: true, staleMaxAge: 600 })).toEqual({
      calls: 1,
      writes: [{ ttl: 660 }],
    });
    expect(await runHandler({ maxAge: 30 })).toMatchObject({ cacheControl: "max-age=30" });
    // `swr: false` and `maxAge: 0` are values, not absences: the zero lifetime is advertised
    // and keeps the response out of storage (the 10.6 invariant, unaffected by the strip).
    expect(await runFn({ maxAge: 0, swr: false })).toEqual({ calls: 2, writes: [] });
    expect(await runHandler({ maxAge: 0, swr: false })).toMatchObject({
      calls: 2,
      writes: [],
      cacheControl: "max-age=0",
      status: "MISS",
    });
  });

  it("preserves an explicit null lifetime, which is not the same as undefined", async () => {
    // Only `undefined` reads as unset. A `null` maxAge stays nullish, so it names no lifetime
    // and the write is refused — the opposite outcome from `maxAge: undefined` above.
    expect(await runFn({ maxAge: null })).toEqual({ calls: 2, writes: [] });
    expect(await runFn({ maxAge: undefined })).toEqual({ calls: 1, writes: [{ ttl: 1 }] });
  });
});

describe("serialize (write-time hook)", () => {
  it("stores the serialized value; transform restores it on read", async () => {
    const fn = defineCachedFunction(() => ({ n: 1 }), {
      maxAge: 100,
      getKey: () => "k",
      // Persist a compact string form...
      serialize: (entry) => JSON.stringify(entry.value),
      // ...and reconstruct the object on the way out.
      transform: (entry) => JSON.parse(entry.value as any),
    });

    // Miss: resolved, serialized, then transformed back.
    expect(await fn()).toEqual({ n: 1 });
    // Hit: read serialized form from storage, transformed back.
    expect(await fn()).toEqual({ n: 1 });

    // Storage holds the serialized (string) form, not the raw object.
    const keys = await fn.resolveKeys();
    const entry = (await testStorage.get(keys[0]!)) as any;
    expect(entry.value).toBe('{"n":1}');
  });

  it("runs exactly once for concurrent deduplicated calls and shares the serialized value", async () => {
    let serializeCalls = 0;
    let resolverCalls = 0;
    const fn = defineCachedFunction(
      () => {
        resolverCalls++;
        return "raw";
      },
      {
        maxAge: 100,
        getKey: () => "k",
        serialize: (entry) => {
          serializeCalls++;
          return `serialized-${entry.value}`;
        },
        transform: (entry) => `out-${entry.value}`,
      },
    );

    // Fire concurrent calls that all dedupe onto the same resolution.
    const results = await Promise.all([fn(), fn(), fn()]);

    expect(resolverCalls).toBe(1);
    expect(serializeCalls).toBe(1);
    // Every caller (leader + followers) sees the serialized value, so transform is consistent.
    expect(results).toEqual(["out-serialized-raw", "out-serialized-raw", "out-serialized-raw"]);
  });

  it("consumes a one-shot ReadableStream body under concurrent calls", async () => {
    const streamToString = async (stream: ReadableStream) => {
      const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
      let out = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += value;
      }
      return out;
    };

    // A single stream instance shared across all concurrent callers: it can be
    // consumed exactly once, so if the resolver or serialize ran more than once the
    // second read would throw ("locked")/yield an empty body and this test would fail.
    const sharedStream = new Response("hello stream").body as ReadableStream;
    let resolverCalls = 0;
    const fn = defineCachedFunction(
      () => {
        resolverCalls++;
        return { body: sharedStream };
      },
      {
        maxAge: 100,
        getKey: () => "k",
        serialize: async (entry) => ({ body: await streamToString(entry.value!.body) }),
        transform: (entry) => (entry.value as any).body,
      },
    );

    const results = await Promise.all([fn(), fn(), fn()]);
    expect(resolverCalls).toBe(1);
    expect(results).toEqual(["hello stream", "hello stream", "hello stream"]);
  });

  it("runs after getMaxAge, so getMaxAge still sees the raw resolved value", async () => {
    let seenByGetMaxAge: unknown;
    const fn = defineCachedFunction(() => ({ expiresIn: 42 }), {
      swr: true,
      getKey: () => "k",
      getMaxAge: (entry) => {
        seenByGetMaxAge = entry.value;
        return entry.value?.expiresIn;
      },
      serialize: (entry) => JSON.stringify(entry.value),
      transform: (entry) => JSON.parse(entry.value as any),
    });

    expect(await fn()).toEqual({ expiresIn: 42 });
    // getMaxAge inspected the raw object, not the serialized string.
    expect(seenByGetMaxAge).toEqual({ expiresIn: 42 });

    // The per-entry maxAge derived from the raw value is persisted alongside the serialized value.
    const keys = await fn.resolveKeys();
    const entry = (await testStorage.get(keys[0]!)) as any;
    expect(entry.maxAge).toBe(42);
    expect(entry.value).toBe('{"expiresIn":42}');
  });

  it("receives the call arguments via the ctx object", async () => {
    const fn = defineCachedFunction((a: number, b: number) => a + b, {
      maxAge: 100,
      getKey: (a, b) => `${a}-${b}`,
      serialize: (entry, { args }) => `${entry.value}:${args[0]}:${args[1]}`,
      transform: (entry) => entry.value,
    });

    expect(await fn(2, 3)).toBe("5:2:3");
  });

  it("propagates serialize errors and does not cache the entry", async () => {
    let resolverCalls = 0;
    const fn = defineCachedFunction(
      () => {
        resolverCalls++;
        return "value";
      },
      {
        maxAge: 100,
        getKey: () => "k",
        serialize: () => {
          throw new Error("cannot serialize");
        },
      },
    );

    await expect(fn()).rejects.toThrow("cannot serialize");

    // Nothing was persisted, so a second call re-resolves.
    const keys = await fn.resolveKeys();
    expect(await testStorage.get(keys[0]!)).toBeNull();
    await expect(fn()).rejects.toThrow("cannot serialize");
    expect(resolverCalls).toBe(2);
  });
});

describe("storage", () => {
  it("createMemoryStorage handles TTL expiry", async () => {
    const storage = createMemoryStorage();
    storage.set("unique-ttl-key", { value: "test" }, { ttl: 0.01 });
    expect(storage.get("unique-ttl-key")).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(storage.get("unique-ttl-key")).toBeNull();
  });

  it("set with null deletes the entry", () => {
    const storage = createMemoryStorage();
    storage.set("key", "hello");
    expect(storage.get("key")).toBe("hello");
    storage.set("key", null);
    expect(storage.get("key")).toBeNull();
  });

  it("set with undefined deletes the entry", () => {
    const storage = createMemoryStorage();
    storage.set("key", "hello");
    expect(storage.get("key")).toBe("hello");
    storage.set("key", undefined);
    expect(storage.get("key")).toBeNull();
  });

  it("set null on nonexistent key is a no-op", () => {
    const storage = createMemoryStorage();
    storage.set("nonexistent", null);
    expect(storage.get("nonexistent")).toBeNull();
  });

  it("evicts least-recently-used entries when maxSize is exceeded", () => {
    const storage = createMemoryStorage({ maxSize: 2 });
    storage.set("a", 1);
    storage.set("b", 2);
    storage.set("c", 3); // exceeds maxSize -> evicts "a" (oldest)
    expect(storage.get("a")).toBeNull();
    expect(storage.get("b")).toBe(2);
    expect(storage.get("c")).toBe(3);
  });

  it("get marks an entry as recently used so it survives eviction", () => {
    const storage = createMemoryStorage({ maxSize: 2 });
    storage.set("a", 1);
    storage.set("b", 2);
    // Touch "a" so "b" becomes the least-recently-used.
    expect(storage.get("a")).toBe(1);
    storage.set("c", 3); // evicts "b"
    expect(storage.get("a")).toBe(1);
    expect(storage.get("b")).toBeNull();
    expect(storage.get("c")).toBe(3);
  });

  it("re-setting an existing key refreshes its recency and does not grow the map", () => {
    const storage = createMemoryStorage({ maxSize: 2 });
    storage.set("a", 1);
    storage.set("b", 2);
    storage.set("a", 10); // update "a" -> now most-recent
    storage.set("c", 3); // evicts "b"
    expect(storage.get("a")).toBe(10);
    expect(storage.get("b")).toBeNull();
    expect(storage.get("c")).toBe(3);
  });

  it("applies a default maxSize when none is provided", () => {
    const storage = createMemoryStorage();
    for (let i = 0; i < 12_000; i++) {
      storage.set(`key-${i}`, i);
    }
    // Oldest entries beyond the default ceiling (10 000) are evicted.
    expect(storage.get("key-0")).toBeNull();
    expect(storage.get("key-1999")).toBeNull();
    expect(storage.get("key-2000")).toBe(2000);
    expect(storage.get("key-11999")).toBe(11_999);
  });

  it("grows unbounded when maxSize is Infinity", () => {
    const storage = createMemoryStorage({ maxSize: Number.POSITIVE_INFINITY });
    for (let i = 0; i < 2000; i++) {
      storage.set(`key-${i}`, i);
    }
    expect(storage.get("key-0")).toBe(0);
    expect(storage.get("key-1999")).toBe(1999);
  });

  // Finding 14.1: `maxSize` bounds entry *count*, never bytes — measured, 10 000 × 1 MB
  // documents retained 10 GB of RSS, and because that is external/large-object memory the
  // process is OOM-killed rather than throwing a catchable RangeError. `maxBytes` is the
  // bound; it matters most for `{ swr: true, maxAge: N }` (the ISR shape), whose entries
  // carry an expiry but no storage TTL and are retained until the backend evicts them.
  describe("maxBytes", () => {
    // A per-entry weight in exact units, so a test can state its budget in bytes instead of
    // depending on the built-in estimate.
    const byLength = (value: unknown) => (typeof value === "string" ? value.length : 1);

    it("evicts least-recently-used entries once the byte budget is exceeded", () => {
      const storage = createMemoryStorage({ maxBytes: 10, sizeOf: byLength });
      storage.set("a", "12345");
      storage.set("b", "12345"); // total 10 — at the budget, not over it
      // Touch "a" so "b" is the least-recently-used.
      expect(storage.get("a")).toBe("12345");
      storage.set("c", "12345"); // 15 > 10 -> evicts "b"
      expect(storage.get("b")).toBeNull();
      expect(storage.get("a")).toBe("12345");
      expect(storage.get("c")).toBe("12345");
    });

    // The regression the finding asks for: a byte budget evicts before RSS grows unbounded.
    // 120 entries is far under the 10 000-entry ceiling, so only the byte budget can evict.
    it("bounds total bytes under the default budget where maxSize alone would not", () => {
      const storage = createMemoryStorage();
      const body = "x".repeat(1024 * 1024); // ~2 MB estimated per entry
      for (let i = 0; i < 120; i++) {
        storage.set(`key-${i}`, { body: `${i}-${body}` });
      }
      let live = 0;
      for (let i = 0; i < 120; i++) {
        if (storage.get(`key-${i}`) !== null) {
          live++;
        }
      }
      expect(storage.get("key-0")).toBeNull();
      expect(storage.get("key-119")).not.toBeNull();
      // 100 MB / ~2 MB ≈ 48 entries retained, nowhere near 120.
      expect(live).toBeGreaterThan(30);
      expect(live).toBeLessThan(60);
    });

    it("counts the key's own bytes", () => {
      // The finding's second measurement is pure key weight: 10 000 × 8 KB
      // attacker-chosen paths, 93 MB heap / 296 MB RSS in 6 s, with 1-byte values.
      const storage = createMemoryStorage({ maxBytes: 100_000 });
      for (let i = 0; i < 20; i++) {
        storage.set(`/${"p".repeat(8000)}/${i}`, 1);
      }
      let live = 0;
      for (let i = 0; i < 20; i++) {
        if (storage.get(`/${"p".repeat(8000)}/${i}`) !== null) {
          live++;
        }
      }
      // ~16 KB per key -> ~6 fit in 100 KB.
      expect(live).toBeGreaterThan(2);
      expect(live).toBeLessThan(10);
    });

    it("charges binary payloads their byte length", () => {
      const storage = createMemoryStorage({ maxBytes: 4096 });
      storage.set("a", new Uint8Array(3000));
      storage.set("b", new Uint8Array(3000)); // 6000 > 4096 -> evicts "a"
      expect(storage.get("a")).toBeNull();
      expect(storage.get("b")).not.toBeNull();
    });

    it("disables the byte budget when maxBytes is 0 or Infinity", () => {
      for (const maxBytes of [0, Number.POSITIVE_INFINITY, -1]) {
        const sizeOf = vi.fn(() => 50 * 1024 * 1024);
        const storage = createMemoryStorage({ maxBytes, sizeOf });
        for (let i = 0; i < 10; i++) {
          storage.set(`key-${i}`, i);
        }
        expect(storage.get("key-0")).toBe(0);
        expect(storage.get("key-9")).toBe(9);
        // With no budget armed, the estimate is never even computed.
        expect(sizeOf).not.toHaveBeenCalled();
      }
    });

    it("honors a custom sizeOf, which owns the whole per-entry charge", () => {
      const seen: string[] = [];
      const storage = createMemoryStorage({
        maxBytes: 100,
        sizeOf: (_value, key) => {
          seen.push(key);
          return key.length * 10;
        },
      });
      storage.set("aaaa", "x"); // 40
      storage.set("bbbb", "x"); // 80
      storage.set("cccc", "x"); // 120 > 100 -> evicts "aaaa"
      expect(seen).toEqual(["aaaa", "bbbb", "cccc"]);
      expect(storage.get("aaaa")).toBeNull();
      expect(storage.get("bbbb")).toBe("x");
      expect(storage.get("cccc")).toBe("x");
    });

    it("falls back to the built-in estimate when sizeOf throws or returns a non-number", () => {
      const hooks = [
        () => {
          throw new Error("boom");
        },
        () => Number.NaN,
        () => -1,
        () => "big" as unknown as number,
      ];
      for (const sizeOf of hooks) {
        const storage = createMemoryStorage({ maxBytes: 10_000, sizeOf });
        storage.set("a", "small");
        // 50 000 chars -> 100 000 estimated bytes, over the whole budget on its own.
        storage.set("big", "x".repeat(50_000));
        expect(storage.get("big")).toBeNull();
        expect(storage.get("a")).toBe("small");
      }
    });

    // The running total is maintained incrementally, so every path that removes an entry has
    // to release its bytes. A leak converges on evicting everything, silently.
    it("does not leak bytes when a key is overwritten", () => {
      const storage = createMemoryStorage({ maxBytes: 10, sizeOf: byLength });
      for (let i = 0; i < 10; i++) {
        storage.set("a", "123456789"); // 9 bytes, ten times over — total must stay 9
      }
      storage.set("b", "1");
      expect(storage.get("a")).toBe("123456789");
      expect(storage.get("b")).toBe("1");
    });

    it("does not leak bytes when an entry expires via its TTL timer", async () => {
      const storage = createMemoryStorage({ maxBytes: 10, sizeOf: byLength });
      storage.set("a", "123456789", { ttl: 0.01 });
      await new Promise((r) => setTimeout(r, 30));
      // Fits only if the timer released "a"'s 9 bytes.
      storage.set("b", "123456789");
      expect(storage.get("b")).toBe("123456789");
    });

    it("does not leak bytes when an entry expires lazily on read", () => {
      vi.useFakeTimers();
      try {
        const storage = createMemoryStorage({ maxBytes: 10, sizeOf: byLength });
        storage.set("a", "123456789", { ttl: 60 });
        // Move the clock without running timers, so the entry is reclaimed by `get`'s lazy
        // expiry check rather than by its `setTimeout`.
        vi.setSystemTime(Date.now() + 120_000);
        expect(storage.get("a")).toBeNull();
        storage.set("b", "123456789");
        expect(storage.get("b")).toBe("123456789");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not leak bytes when an entry is deleted by a nullish set", () => {
      const storage = createMemoryStorage({ maxBytes: 10, sizeOf: byLength });
      storage.set("a", "123456789");
      storage.set("a", null);
      storage.set("b", "123456789");
      expect(storage.get("a")).toBeNull();
      expect(storage.get("b")).toBe("123456789");
    });

    it("does not leak bytes across LRU evictions", () => {
      const storage = createMemoryStorage({ maxBytes: 10, sizeOf: byLength });
      for (let i = 0; i < 50; i++) {
        storage.set(`k${i}`, "123456789"); // only one 9-byte entry fits at a time
      }
      expect(storage.get("k49")).toBe("123456789");
      expect(storage.get("k48")).toBeNull();
    });

    it("refuses an entry larger than the whole budget instead of flushing the cache", () => {
      const storage = createMemoryStorage({ maxBytes: 10, sizeOf: byLength });
      storage.set("a", "12345");
      storage.set("b", "12345");
      storage.set("huge", "1234567890123456789"); // 19 > 10
      expect(storage.get("huge")).toBeNull();
      // The hot set survives: one oversized value must not evict everything else.
      expect(storage.get("a")).toBe("12345");
      expect(storage.get("b")).toBe("12345");
    });

    it("drops the previous value when an oversized entry replaces it", () => {
      const storage = createMemoryStorage({ maxBytes: 10, sizeOf: byLength });
      storage.set("a", "12345");
      storage.set("a", "1234567890123456789");
      // `set` was asked to replace it; serving the old value afterwards would be a lie.
      expect(storage.get("a")).toBeNull();
    });

    it("applies maxSize and maxBytes together", () => {
      // Entry ceiling binds first.
      const byCount = createMemoryStorage({ maxSize: 2, maxBytes: 1000, sizeOf: () => 10 });
      byCount.set("a", 1);
      byCount.set("b", 2);
      byCount.set("c", 3);
      expect(byCount.get("a")).toBeNull();
      expect(byCount.get("b")).toBe(2);
      expect(byCount.get("c")).toBe(3);

      // Byte ceiling binds first.
      const byBytes = createMemoryStorage({ maxSize: 100, maxBytes: 25, sizeOf: () => 10 });
      byBytes.set("a", 1);
      byBytes.set("b", 2);
      byBytes.set("c", 3);
      expect(byBytes.get("a")).toBeNull();
      expect(byBytes.get("b")).toBe(2);
      expect(byBytes.get("c")).toBe(3);
    });

    // A one-byte window keeps the whole ArrayBuffer alive, so charging `byteLength`
    // would let `new Uint8Array(new ArrayBuffer(64 MB), 0, 1)` retain 64 MB for 1 byte.
    it("charges a view for the buffer it retains, not for its window", () => {
      const storage = createMemoryStorage({ maxBytes: 4096 });
      storage.set("window", new Uint8Array(new ArrayBuffer(10_000), 0, 1));
      expect(storage.get("window")).toBeNull();

      // Views sharing one buffer are charged once, and a DataView is charged too.
      const shared = new ArrayBuffer(3000);
      const fits = createMemoryStorage({ maxBytes: 4096 });
      fits.set("views", [new Uint8Array(shared), new DataView(shared)]);
      expect(fits.get("views")).not.toBeNull();
      fits.set("second", new Uint8Array(3000)); // 6000 > 4096 -> evicts "views"
      expect(fits.get("views")).toBeNull();
    });

    // Charging only the key would make anything hidden behind a throwing getter free.
    it("refuses a value whose size cannot be measured", () => {
      const storage = createMemoryStorage({ maxBytes: 10_000 });
      const throwingGetter = Object.defineProperty({}, "boom", {
        get() {
          throw new Error("no");
        },
        enumerable: true,
      });
      storage.set("a", "small");
      storage.set("throws", throwingGetter);
      expect(storage.get("throws")).toBeNull();
      // The rest of the cache is untouched.
      expect(storage.get("a")).toBe("small");

      // Replacing a stored value with an unmeasurable one drops it, as an oversized set does.
      storage.set("a", throwingGetter);
      expect(storage.get("a")).toBeNull();

      // `sizeOf` owns the charge, so it can still cache such a value.
      const sized = createMemoryStorage({ maxBytes: 10_000, sizeOf: () => 16 });
      sized.set("throws", throwingGetter);
      expect(sized.get("throws")).toBe(throwingGetter);

      // With no byte budget armed, nothing is measured.
      const unbounded = createMemoryStorage({ maxBytes: 0 });
      unbounded.set("throws", throwingGetter);
      expect(unbounded.get("throws")).toBe(throwingGetter);
    });

    it("estimates exotic values without throwing", () => {
      const storage = createMemoryStorage({ maxBytes: 10 * 1024 * 1024 });
      const cyclic: Record<string, unknown> = { name: "cyclic" };
      cyclic.self = cyclic;
      cyclic.again = [cyclic, { deep: cyclic }];
      class Instance {
        field = "x";
        get computed() {
          return "y";
        }
      }
      const values: unknown[] = [
        cyclic,
        new Instance(),
        new Uint8Array([1, 2, 3]),
        new DataView(new ArrayBuffer(8)),
        new ArrayBuffer(16),
        new Map<unknown, unknown>([["k", { v: 1 }]]),
        new Set([1, "two", { three: 3 }]),
        [1, [2, [3, [4]]]],
        new Date(),
        /re/g,
        10n,
        Symbol("s"),
        () => {},
        Number.NaN,
        Object.create(null),
      ];
      for (const [i, value] of values.entries()) {
        expect(() => storage.set(`exotic-${i}`, value)).not.toThrow();
        expect(storage.get(`exotic-${i}`)).toBe(value);
      }
    });
  });

  // Regression: nitro#2138 — expired cache entries never get flushed from memory.
  // When entries expire via TTL, they should eventually be removed from the underlying
  // Map even if nobody reads them again, to prevent unbounded memory growth.
  it("expired entries are proactively flushed after TTL", async () => {
    const storage = createMemoryStorage();
    const origSet = storage.set.bind(storage);
    const origGet = storage.get.bind(storage);

    // Wrap set to track deletes that happen via setTimeout (proactive flush)
    const map = new Map<string, true>();
    storage.set = (key: string, value: any, opts?: any) => {
      if (value !== null && value !== undefined) {
        map.set(key, true);
      }
      return origSet(key, value, opts);
    };

    // Store entries with short TTL
    for (let i = 0; i < 10; i++) {
      storage.set(`key-${i}`, { value: `val-${i}` }, { ttl: 0.01 });
    }

    expect(map.size).toBe(10);

    // Wait for TTL + proactive cleanup
    await new Promise((r) => setTimeout(r, 50));

    // Verify entries are gone — proactive flush should have removed them
    // even though we never called get() on them
    for (let i = 0; i < 10; i++) {
      expect(origGet(`key-${i}`)).toBeNull();
    }
  });

  // The `storage` option and the per-instance default that replaced the global
  // `setStorage()`/`useStorage()` singleton. These use the raw `_`-prefixed imports so the
  // test harness doesn't inject a shared storage over the behavior under test.
  describe("storage option", () => {
    // Regression (h3#1524 audit, finding #2): two independent apps, each building the same
    // cached function from a shared module (so same name, same key, same integrity) but
    // owning its own cache, used to land in the one global storage and serve each other's
    // values. Nothing but the per-instance default prevents that — a caller cannot pick a
    // "unique enough" name for an app it doesn't know exists.
    it("gives each cached function its own storage by default", async () => {
      const calls: string[] = [];
      const makeApp = (app: string) =>
        _defineCachedFunction(
          () => {
            calls.push(app);
            return `body-from-${app}`;
          },
          { maxAge: 10, name: "render", getKey: () => "/index" },
        );

      const a = makeApp("a");
      const b = makeApp("b");

      expect(await a()).toBe("body-from-a");
      expect(await b()).toBe("body-from-b");
      // Each still serves its own value from its own cache.
      expect(await a()).toBe("body-from-a");
      expect(await b()).toBe("body-from-b");
      expect(calls).toEqual(["a", "b"]);
    });

    it("shares entries between cached functions given the same storage", async () => {
      const storage = createMemoryStorage();
      const calls: string[] = [];
      const makeApp = (app: string) =>
        _defineCachedFunction(
          () => {
            calls.push(app);
            return `body-from-${app}`;
          },
          { maxAge: 10, name: "render", getKey: () => "/index", storage },
        );

      const a = makeApp("a");
      const b = makeApp("b");

      expect(await a()).toBe("body-from-a");
      // Sharing is opt-in and explicit: `b` reads the entry `a` wrote.
      expect(await b()).toBe("body-from-a");
      expect(calls).toEqual(["a"]);
    });

    it("writes to a ready storage instance", async () => {
      const storage = createMemoryStorage();
      const fn = _defineCachedFunction(() => "value", {
        maxAge: 10,
        name: "ready",
        getKey: () => "k",
        storage,
      });

      expect(await fn()).toBe("value");
      expect(await storage.get("/cache:functions:ready:k.json")).toMatchObject({ value: "value" });
      expect((await fn.resolveKeys())[0]).toBe("/cache:functions:ready:k.json");
    });

    it("resolves a storage factory lazily and only once", async () => {
      const storage = createMemoryStorage();
      let factoryCalls = 0;
      const fn = _defineCachedFunction(() => "value", {
        maxAge: 10,
        name: "lazy",
        getKey: () => "k",
        storage: () => {
          factoryCalls++;
          return storage;
        },
      });

      // Late binding: the factory must not run at definition time — a handler is commonly
      // defined at module load, before the real backend has been configured.
      expect(factoryCalls).toBe(0);

      // A purge issued before anything was cached must resolve the *same* store the read/
      // write path will use, not run the factory a second time on its own copy of the opts.
      await fn.invalidate();
      expect(factoryCalls).toBe(1);

      await fn();
      await fn();
      await fn();
      await fn.invalidate();
      await fn.expire();
      await fn();

      expect(factoryCalls).toBe(1);
      expect(await storage.get("/cache:functions:lazy:k.json")).toBeTruthy();
    });

    it("standalone helpers reach the default storage via the same options object", async () => {
      let calls = 0;
      // No `storage`: this instance builds its own. The helpers can only find it because
      // the resolved instance is memoized back onto this very object (same mechanism as
      // the resolved `name`).
      const opts = { maxAge: 10, name: "standalone-default", getKey: () => "k" };
      const fn = _defineCachedFunction(() => `v${++calls}`, opts);

      expect(await fn()).toBe("v1");
      expect(await fn()).toBe("v1");

      await invalidateCache({ options: opts });
      expect(await fn()).toBe("v2");

      await expireCache({ options: opts });
      expect(await fn()).toBe("v3");

      // A *different* object — even a structurally identical literal — carries no resolved
      // storage, so it cannot know which backend to purge. That used to resolve a fresh
      // empty store and report success while the stale entry kept being served; it throws
      // instead, so the mistake is impossible to miss.
      await expect(
        invalidateCache({ options: { name: "standalone-default", getKey: () => "k" } }),
      ).rejects.toThrow(/requires `options.storage`/);
      await expect(
        expireCache({ options: { name: "standalone-default", getKey: () => "k" } }),
      ).rejects.toThrow(/requires `options.storage`/);
      expect(await fn()).toBe("v3");
    });

    it("does not perturb the integrity hash", async () => {
      const s1 = createMemoryStorage();
      const s2 = createMemoryStorage();
      const fn = () => "value";
      const key = "/cache:functions:integrity:k.json";

      // Identical in every way except where entries live, and in which *form* the storage
      // was passed — `serialize` hashes a factory and a ready instance differently, so this
      // would diverge if `storage` reached the integrity hash.
      const a = _defineCachedFunction(fn, {
        maxAge: 10,
        name: "integrity",
        getKey: () => "k",
        storage: s1,
      });
      const b = _defineCachedFunction(fn, {
        maxAge: 10,
        name: "integrity",
        getKey: () => "k",
        storage: () => s2,
      });

      await a();
      await b();

      const entryA = (await s1.get(key)) as any;
      const entryB = (await s2.get(key)) as any;
      expect(entryA.integrity).toBe(entryB.integrity);
    });

    it("handler revalidation methods act on the handler's own storage", async () => {
      const storage = createMemoryStorage();
      let callCount = 0;
      const handler = _defineCachedHandler(() => new Response(`call-${++callCount}`), {
        maxAge: 60,
        swr: true,
        staleMaxAge: 60,
        storage,
      });
      const event = () => ({ req: new Request("http://localhost/resource") });

      const r1 = (await handler(event())) as Response;
      expect(await r1.text()).toBe("call-1");

      // Keys resolve against this handler's own store — and the entry is really there.
      const keys = await handler.resolveKeys(event());
      expect(keys).toHaveLength(2); // GET + HEAD variants of the resource
      expect(await storage.get(keys[0]!)).toBeTruthy();

      await handler.expire(event());
      expect(await storage.get(keys[0]!)).toMatchObject({ stale: true });

      await handler.invalidate(event());
      expect(await storage.get(keys[0]!)).toBeNull();

      const r2 = (await handler(event())) as Response;
      expect(await r2.text()).toBe("call-2");
    });

    it("handler revalidation resolves the handler's storage once, before the first request", async () => {
      const storage = createMemoryStorage();
      let factoryCalls = 0;
      const handler = _defineCachedHandler(() => new Response("ok"), {
        maxAge: 60,
        storage: () => {
          factoryCalls++;
          return storage;
        },
      });
      const event = () => ({ req: new Request("http://localhost/cold") });

      // `_variantOptions` spreads one fresh options object per method variant; without
      // resolving the handler's storage into `_opts` first, each copy would resolve its own
      // (running the factory once per variant, then again on the first request).
      await handler.invalidate(event());
      expect(factoryCalls).toBe(1);

      await handler(event());
      const keys = await handler.resolveKeys(event());
      expect(await storage.get(keys[0]!)).toBeTruthy();

      await handler.invalidate(event());
      expect(await storage.get(keys[0]!)).toBeNull();
      expect(factoryCalls).toBe(1);
    });

    it("handler revalidation reaches the handler's own default storage", async () => {
      let callCount = 0;
      // No `storage`: the handler owns a private memory storage nobody else can reach, so
      // its purge methods are the only way in.
      const handler = _defineCachedHandler(() => new Response(`call-${++callCount}`), {
        maxAge: 60,
      });
      const event = () => ({ req: new Request("http://localhost/default-store") });

      expect(await ((await handler(event())) as Response).text()).toBe("call-1");
      expect(await ((await handler(event())) as Response).text()).toBe("call-1");

      await handler.invalidate(event());
      expect(await ((await handler(event())) as Response).text()).toBe("call-2");
    });
  });
});

describe("defineCachedHandler", () => {
  let testId = 0;
  function makeEvent(path: string, opts?: RequestInit & { headers?: Record<string, string> }) {
    return {
      req: new Request(`http://localhost${path}`, opts),
    };
  }
  function uniquePath() {
    return `/test-${++testId}-${Date.now()}`;
  }
  // The `HEAD:` component is inserted right after the name segment. That segment is the
  // resolved handler name (`fn.name` / `anon_<hash>` — see "handler cache key name
  // resolution (#53)"), not the old shared `_` literal, so match it structurally. `[^:]+` is
  // exact rather than merely usual: `buildCacheKey` escapes the name, so that segment can
  // never itself contain a `:` (see "cache key name escaping").
  function headVariantKey(getKey: string) {
    const key = getKey.replace(/^(\/cache:handlers:[^:]+:)/, "$1HEAD:");
    // Guard against the helper silently matching nothing and asserting a no-op.
    expect(key).not.toBe(getKey);
    return key;
  }

  it("caches GET responses", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("hello", { status: 200 });
      },
      { maxAge: 10 },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    const r2 = (await handler(makeEvent(path))) as Response;

    expect(await r1.text()).toBe("hello");
    expect(await r2.text()).toBe("hello");
    expect(callCount).toBe(1);
  });

  it("sets X-Cache header (MISS then HIT) when cacheStatusHeader is true", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), {
      maxAge: 100,
      cacheStatusHeader: true,
    });

    const r1 = (await handler(makeEvent(path))) as Response;
    const r2 = (await handler(makeEvent(path))) as Response;

    expect(r1.headers.get("x-cache")).toBe("MISS");
    expect(r2.headers.get("x-cache")).toBe("HIT");
  });

  it("supports a custom cacheStatusHeader name", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), {
      maxAge: 100,
      cacheStatusHeader: "x-nitro-cache",
    });

    const r1 = (await handler(makeEvent(path))) as Response;
    const r2 = (await handler(makeEvent(path))) as Response;

    expect(r1.headers.get("x-nitro-cache")).toBe("MISS");
    expect(r2.headers.get("x-nitro-cache")).toBe("HIT");
  });

  it("sets the X-Cache header by default", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), { maxAge: 100 });

    const r1 = (await handler(makeEvent(path))) as Response;
    const r2 = (await handler(makeEvent(path))) as Response;
    expect(r1.headers.get("x-cache")).toBe("MISS");
    expect(r2.headers.get("x-cache")).toBe("HIT");
  });

  it("disables the cache-status header when cacheStatusHeader is false", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), {
      maxAge: 100,
      cacheStatusHeader: false,
    });

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("x-cache")).toBeNull();
  });

  it("propagates cache-status header on 304 responses", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), {
      maxAge: 100,
      cacheStatusHeader: true,
    });

    const r1 = (await handler(makeEvent(path))) as Response;
    const etag = r1.headers.get("etag")!;
    const r2 = (await handler(makeEvent(path, { headers: { "if-none-match": etag } }))) as Response;

    expect(r2.status).toBe(304);
    expect(r2.headers.get("x-cache")).toBe("HIT");
  });

  it("bypasses cache for non-GET methods", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("ok");
      },
      { maxAge: 10 },
    );

    await handler(makeEvent(path, { method: "POST" }));
    await handler(makeEvent(path, { method: "POST" }));
    expect(callCount).toBe(2);
  });

  it("allows HEAD requests to use cache (keyed apart from GET)", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("ok");
      },
      { maxAge: 10 },
    );

    await handler(makeEvent(path));
    // A HEAD response is a different representation (a spec-compliant host strips its
    // body), so it gets its own entry — one origin dispatch per method per TTL.
    await handler(makeEvent(path, { method: "HEAD" }));
    expect(callCount).toBe(2);
    await handler(makeEvent(path, { method: "HEAD" }));
    expect(callCount).toBe(2);
  });

  it("honors a user-supplied shouldBypassCache (issue #50)", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("ok");
      },
      {
        maxAge: 10,
        // Bypass whenever the request carries a `?bypass` query param.
        shouldBypassCache: (event) => new URL(event.req.url).searchParams.has("bypass"),
      },
    );

    // GET without the flag caches as usual.
    await handler(makeEvent(path));
    await handler(makeEvent(path));
    expect(callCount).toBe(1);

    // GET with the flag must bypass the cache and reach the handler every time.
    await handler(makeEvent(`${path}?bypass`));
    await handler(makeEvent(`${path}?bypass`));
    expect(callCount).toBe(3);
  });

  it("composes the built-in method bypass with a user shouldBypassCache", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("ok");
      },
      {
        maxAge: 10,
        // User check only bypasses on a header; non-GET/HEAD must still bypass
        // via the built-in method check even though this returns false for them.
        shouldBypassCache: (event) => event.req.headers.get("x-bypass") === "1",
      },
    );

    // POST still bypasses (built-in method check), user check returns false.
    await handler(makeEvent(path, { method: "POST" }));
    await handler(makeEvent(path, { method: "POST" }));
    expect(callCount).toBe(2);

    // GET with the user flag bypasses too.
    await handler(makeEvent(path, { headers: { "x-bypass": "1" } }));
    expect(callCount).toBe(3);
  });

  it("passes a bypassed (POST) response through untouched — no buffering or synthesized headers", async () => {
    const path = uniquePath();
    const original = new Response("post-body", { status: 201, statusText: "Created" });
    const handler = defineCachedHandler(() => original, { maxAge: 10 });

    const res = (await handler(makeEvent(path, { method: "POST" }))) as Response;

    // The exact live Response instance flows back out — not a rebuilt copy.
    expect(res).toBe(original);
    expect(res.status).toBe(201);
    expect(res.statusText).toBe("Created");
    // No serialize step ran, so no cache headers were synthesized onto it.
    expect(res.headers.has("etag")).toBe(false);
    expect(res.headers.has("last-modified")).toBe(false);
    expect(res.headers.has("cache-control")).toBe(false);
    expect(res.headers.has("x-cache")).toBe(false);
    // Body is still readable (never consumed by res.text()).
    expect(await res.text()).toBe("post-body");
  });

  it("never answers a bypassed (POST) request with 304", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), { maxAge: 10 });

    // A GET first, to obtain an etag we can echo back as a conditional validator.
    const getRes = (await handler(makeEvent(path))) as Response;
    const etag = getRes.headers.get("etag")!;
    expect(etag).toBeTruthy();

    // A POST carrying the matching validator must still reach the handler and get 200,
    // never a bogus 304 (which isn't valid semantics for a non-cacheable method).
    const postRes = (await handler(
      makeEvent(path, { method: "POST", headers: { "if-none-match": etag } }),
    )) as Response;
    expect(postRes.status).toBe(200);
    expect(await postRes.text()).toBe("ok");
  });

  it("preserves a binary bypassed response body (no res.text() corruption)", async () => {
    const path = uniquePath();
    const bytes = new Uint8Array([0xff, 0x00, 0x80, 0xfe, 0x01]);
    const handler = defineCachedHandler(
      () => new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
      { maxAge: 10 },
    );

    const res = (await handler(makeEvent(path, { method: "POST" }))) as Response;
    const out = new Uint8Array(await res.arrayBuffer());
    expect([...out]).toEqual([...bytes]);
  });

  it("caches a binary (non-UTF-8) response body without corruption", async () => {
    let callCount = 0;
    const path = uniquePath();
    // Bytes that are NOT valid UTF-8 (0x80/0xff lead bytes, embedded NUL) — res.text()
    // would replace them with U+FFFD and mangle the payload irreversibly.
    const bytes = new Uint8Array([0xff, 0x00, 0x80, 0xfe, 0x01, 0x89, 0x50, 0x4e, 0x47]);
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      },
      { maxAge: 10 },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    const r2 = (await handler(makeEvent(path))) as Response;

    expect([...new Uint8Array(await r1.arrayBuffer())]).toEqual([...bytes]);
    // The cache HIT reconstructs the exact same bytes from storage.
    expect([...new Uint8Array(await r2.arrayBuffer())]).toEqual([...bytes]);
    expect(callCount).toBe(1);
    expect(r2.headers.get("x-cache")).toBe("HIT");
    expect(r2.headers.get("content-type")).toBe("image/png");
  });

  it("stores binary bodies as base64 (survives a JSON-roundtripping storage backend)", async () => {
    const path = uniquePath();
    // A storage backend that JSON-serializes entries (like most real ones) — a raw
    // Uint8Array wouldn't survive this, but a base64 string does.
    const inner = createMemoryStorage();
    useTestStorage({
      get: (key) => {
        const raw = inner.get<string>(key) as string | null;
        return raw == null ? null : JSON.parse(raw);
      },
      set: (key, value) => inner.set(key, JSON.stringify(value)),
    });

    const bytes = new Uint8Array([0xff, 0x00, 0x80, 0xfe]);
    const handler = defineCachedHandler(() => new Response(bytes), { maxAge: 10 });

    await handler(makeEvent(path));
    const r2 = (await handler(makeEvent(path))) as Response;
    expect([...new Uint8Array(await r2.arrayBuffer())]).toEqual([...bytes]);
    expect(r2.headers.get("x-cache")).toBe("HIT");
  });

  it("preserves multi-byte UTF-8 text bodies across a cache hit", async () => {
    const path = uniquePath();
    const text = "héllo 世界 🚀 — café";
    const handler = defineCachedHandler(() => new Response(text), { maxAge: 10 });

    await handler(makeEvent(path));
    const r2 = (await handler(makeEvent(path))) as Response;
    expect(await r2.text()).toBe(text);
    expect(r2.headers.get("x-cache")).toBe("HIT");
  });

  it("reaches the handler with the bypassed request body intact", async () => {
    const path = uniquePath();
    let received: string | undefined;
    const handler = defineCachedHandler(
      async (event) => {
        received = await event.req.text();
        return new Response("ack");
      },
      { maxAge: 10 },
    );

    await handler(makeEvent(path, { method: "POST", body: "payload" }));
    // The narrowed Request rebuilt for cacheable calls drops the body; a bypassed
    // request must reach the handler untouched, body included.
    expect(received).toBe("payload");
  });

  it("sets cache-control header with SWR and staleMaxAge", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), {
      maxAge: 60,
      swr: true,
      staleMaxAge: 120,
    });

    const res = (await handler(makeEvent(path))) as Response;
    // `max-age` accompanies `s-maxage`: the latter is shared-cache-only, so a private cache
    // was left with no freshness lifetime at all and revalidated on every navigation.
    expect(res.headers.get("cache-control")).toBe(
      "max-age=60, s-maxage=60, stale-while-revalidate=120",
    );
  });

  it("sets cache-control with SWR without staleMaxAge, and never a bare stale-while-revalidate", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), { maxAge: 60, swr: true });

    const res = (await handler(makeEvent(path))) as Response;
    // The ISR shape. `stale-while-revalidate` needs a delta-seconds (RFC 5861 §3) and this
    // shape's stale window is unbounded, so nothing is advertised rather than a bare token a
    // conforming cache must ignore anyway (or an invented number ocache couldn't promise).
    expect(res.headers.get("cache-control")).toBe("max-age=60, s-maxage=60");
  });

  it("sets max-age when swr is false", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), { maxAge: 60, swr: false });

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("cache-control")).toBe("max-age=60");
  });

  it("does not clobber an explicit cache-control from the handler", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => new Response("ok", { headers: { "cache-control": "public, max-age=600" } }),
      { maxAge: 60, swr: true, staleMaxAge: 120 },
    );

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("cache-control")).toBe("public, max-age=600");
  });

  it("suppresses cache-control synthesis when sendCacheControl is false (server-only caching)", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("ok");
      },
      { maxAge: 60, swr: true, staleMaxAge: 120, sendCacheControl: false },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    const r2 = (await handler(makeEvent(path))) as Response;

    // No cache-control is advertised to clients/CDNs...
    expect(r1.headers.get("cache-control")).toBeNull();
    expect(r2.headers.get("cache-control")).toBeNull();
    // ...but the response is still stored and served from cache (only one handler run),
    // and the etag is still synthesized.
    expect(callCount).toBe(1);
    expect(r2.headers.get("x-cache")).toBe("HIT");
    expect(r1.headers.get("etag")).toBeTruthy();
  });

  it("still sends an explicit handler cache-control when sendCacheControl is false", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => new Response("ok", { headers: { "cache-control": "public, max-age=600" } }),
      { maxAge: 60, sendCacheControl: false },
    );

    const res = (await handler(makeEvent(path))) as Response;
    // sendCacheControl only governs ocache's own synthesis; a handler-set header is untouched.
    expect(res.headers.get("cache-control")).toBe("public, max-age=600");
  });

  it("synthesizes cache-control by default (sendCacheControl defaults to true)", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), { maxAge: 60 });

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("cache-control")).toBe("max-age=60");
  });

  it("does not cache responses with Cache-Control: no-store", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("ok", { headers: { "cache-control": "no-store" } });
      },
      { maxAge: 10 },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    const r2 = (await handler(makeEvent(path))) as Response;

    expect(await r1.text()).toBe("ok");
    expect(await r2.text()).toBe("ok");
    expect(r1.headers.get("cache-control")).toBe("no-store");
    // Never served from cache: the handler runs on every request.
    expect(callCount).toBe(2);
    expect(r2.headers.get("x-cache")).toBe("MISS");
  });

  it("does not write to storage (no redundant eviction) on a no-store miss", async () => {
    const setSpy = vi.fn();
    useTestStorage({ get: () => null, set: setSpy });

    const handler = defineCachedHandler(
      () => new Response("ok", { headers: { "cache-control": "no-store" } }),
      { maxAge: 10 },
    );

    await handler(makeEvent(uniquePath()));

    // Nothing was stored (rejected) and nothing was there to evict, so no write at all.
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("does not cache responses with Cache-Control: private", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("ok", { headers: { "cache-control": "private, max-age=60" } });
      },
      { maxAge: 10 },
    );

    await handler(makeEvent(path));
    await handler(makeEvent(path));

    expect(callCount).toBe(2);
  });

  // Response-side Cache-Control is *the* documented way for a handler to opt a response out
  // of the cache, but only `no-store`/`private` (the two tests above) were ever recognized.
  // `no-cache` and `max-age=0`/`s-maxage=0` — the commonest ways a developer writes "don't
  // reuse this" — were stored and replayed while the directive was faithfully echoed to the
  // client, i.e. the response advertised non-reusability while ocache was already sharing it.
  describe("response Cache-Control opt-outs", () => {
    /** Runs the same request twice and reports what the handler and the cache did. */
    async function twice(cacheControl: string | undefined, opts: any = { maxAge: 10 }) {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(() => {
        callCount++;
        return new Response(`v${callCount}`, {
          headers: cacheControl ? { "cache-control": cacheControl } : undefined,
        });
      }, opts);

      const r1 = (await handler(makeEvent(path))) as Response;
      const r2 = (await handler(makeEvent(path))) as Response;
      return {
        callCount,
        first: { body: await r1.text(), status: r1.headers.get("x-cache") },
        second: { body: await r2.text(), status: r2.headers.get("x-cache") },
        cacheControl: r2.headers.get("cache-control"),
      };
    }

    it("does not cache a response with Cache-Control: no-cache", async () => {
      const result = await twice("no-cache");
      // Rejected outright (see the TODO in `_cacheControlForbidsReuse` for the
      // store-and-always-revalidate alternative): the handler runs on every request.
      expect(result.callCount).toBe(2);
      expect(result.second.status).toBe("MISS");
      // Still returned to the caller, directive intact.
      expect(result.second.body).toBe("v2");
      expect(result.cacheControl).toBe("no-cache");
    });

    it("does not cache a response with Cache-Control: max-age=0", async () => {
      const result = await twice("max-age=0");
      expect(result.callCount).toBe(2);
      expect(result.second.status).toBe("MISS");
      expect(result.second.body).toBe("v2");
    });

    it("does not cache a response with Cache-Control: s-maxage=0", async () => {
      const result = await twice("public, s-maxage=0");
      expect(result.callCount).toBe(2);
      expect(result.second.status).toBe("MISS");
    });

    it("does not cache the common no-cache, max-age=0, must-revalidate combination", async () => {
      const result = await twice("no-cache, max-age=0, must-revalidate");
      expect(result.callCount).toBe(2);
      expect(result.second.status).toBe("MISS");
    });

    it('rejects the qualified no-cache="field" form too', async () => {
      // RFC 9111 §5.2.2.4 scopes the qualified form to the named fields, but ocache replays
      // a stored response's headers verbatim, so honoring it would mean stripping those
      // fields on every reuse. Rejecting is the fail-safe reading. Also a parser check: the
      // comma inside the quoted value must not be read as a directive separator.
      const result = await twice('no-cache="set-cookie, x-user"');
      expect(result.callCount).toBe(2);
      expect(result.second.status).toBe("MISS");
    });

    it("still caches a response with Cache-Control: max-age=600", async () => {
      const result = await twice("public, max-age=600");
      expect(result.callCount).toBe(1);
      expect(result.second.status).toBe("HIT");
      expect(result.second.body).toBe("v1");
    });

    it("does not read max-age=0600 as a zero lifetime", async () => {
      // Leading zeros are digits, not octal: `delta-seconds` here is 600. A substring or
      // prefix match on `max-age=0` would reject this.
      const result = await twice("public, max-age=0600");
      expect(result.callCount).toBe(1);
      expect(result.second.status).toBe("HIT");
    });

    it("caches max-age=0, s-maxage=600 — s-maxage governs for a shared cache", async () => {
      // The canonical "browsers revalidate, the shared cache keeps it" idiom. `s-maxage`
      // overrides `max-age` for a shared cache (RFC 9111 §5.2.2.10) and ocache is one, so
      // this is a request *to* be stored. Rejecting on the first zero of either directive
      // refused it outright.
      const result = await twice("public, max-age=0, s-maxage=600");
      expect(result.callCount).toBe(1);
      expect(result.second.status).toBe("HIT");
      expect(result.second.body).toBe("v1");
    });

    it("caches s-maxage=600, max-age=0 too — order does not decide it", async () => {
      const result = await twice("public, s-maxage=600, max-age=0");
      expect(result.callCount).toBe(1);
      expect(result.second.status).toBe("HIT");
    });

    it("still rejects s-maxage=0, max-age=600 (s-maxage governs both ways)", async () => {
      // Precedence, not "ignore a zero when the other directive is positive": with
      // `s-maxage` present it alone decides, so a zero there is an opt-out however large
      // `max-age` is.
      const result = await twice("public, s-maxage=0, max-age=600");
      expect(result.callCount).toBe(2);
      expect(result.second.status).toBe("MISS");
    });

    it("falls back to max-age when s-maxage is malformed", async () => {
      // An unparseable `delta-seconds` states nothing (RFC 9111 §5.2), so it must not
      // silently disable the zero-lifetime check by "being present".
      const result = await twice("public, s-maxage=oops, max-age=0");
      expect(result.callCount).toBe(2);
      expect(result.second.status).toBe("MISS");
    });

    it("does not reject on a zero in another directive's value", async () => {
      const result = await twice("public, max-age=600, stale-while-revalidate=0");
      expect(result.callCount).toBe(1);
      expect(result.second.status).toBe("HIT");
    });

    it("caches normally when the response has no Cache-Control at all", async () => {
      const result = await twice(undefined);
      expect(result.callCount).toBe(1);
      expect(result.second.status).toBe("HIT");
      expect(result.second.body).toBe("v1");
      // ocache synthesizes its own lifetime when the handler didn't set one.
      expect(result.cacheControl).toBe("max-age=10");
    });

    it("never stores a response with Vary: * — and never advertises one either", async () => {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        () => {
          callCount++;
          return new Response(`v${callCount}`, { headers: { vary: "*" } });
        },
        { maxAge: 60, swr: true, staleMaxAge: 600, name: "vary-wildcard" },
      );

      const r1 = (await handler(makeEvent(path))) as Response;
      const r2 = (await handler(makeEvent(path))) as Response;

      // `Vary: *` is the strongest "do not share this" signal short of `no-store`: no
      // stored response may ever match such a request (RFC 9111 §4.1). ocache keeps one
      // entry per key and does not key on the response's `Vary`, so it must not store it.
      expect(callCount).toBe(2);
      expect(r2.headers.get("x-cache")).toBe("MISS");
      expect(r1.headers.get("vary")).toBe("*");
      const keys = await handler.resolveKeys(makeEvent(path));
      expect(await testStorage.get(keys[0]!)).toBeNull();

      // And no synthesized lifetime: unlike every other opt-out, a `Vary: *` response
      // carries no `Cache-Control` of its own, so the "don't clobber the handler's header"
      // check does not suppress synthesis here — the gate has to name `Vary: *` itself.
      // Without that it shipped `s-maxage=60, stale-while-revalidate=600` for a response the
      // origin was going to be asked for every single time.
      expect(r1.headers.get("cache-control")).toBeNull();
      expect(r2.headers.get("cache-control")).toBeNull();
    });

    it.each(["no-store", "private", "no-cache"])(
      "does not synthesize a lifetime alongside an explicit %s",
      async (directive) => {
        // The other `validate` rejections need no gate of their own precisely because they
        // are spelled in a `Cache-Control` the handler set — and we never clobber one, so
        // synthesis is already suppressed. This locks that reasoning in: if the
        // "preserve if present" rule ever changed, these would start advertising
        // `s-maxage`/`stale-while-revalidate` for responses that are never stored.
        const result = await twice(directive, { maxAge: 60, swr: true, staleMaxAge: 600 });
        expect(result.callCount).toBe(2);
        expect(result.second.status).toBe("MISS");
        expect(result.cacheControl).toBe(directive);
      },
    );

    it("stores a response with Cache-Control: must-revalidate (not an opt-out)", async () => {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        () => {
          callCount++;
          return new Response(`v${callCount}`, {
            headers: { "cache-control": "public, max-age=60, must-revalidate" },
          });
        },
        { maxAge: 10, swr: true, staleMaxAge: 600, name: "must-revalidate-store" },
      );

      const r1 = (await handler(makeEvent(path))) as Response;
      const r2 = (await handler(makeEvent(path))) as Response;

      // `must-revalidate` constrains *stale* serving, not storage — a fresh entry is a
      // normal HIT.
      expect(await r1.text()).toBe("v1");
      expect(await r2.text()).toBe("v1");
      expect(callCount).toBe(1);
      expect(r2.headers.get("x-cache")).toBe("HIT");

      // Expressed as a per-entry `staleMaxAge: 0` (the mechanism that disables the SWR
      // window for this entry alone), persisted alongside the value.
      const keys = await handler.resolveKeys(makeEvent(path));
      const entry = (await testStorage.get(keys[0]!)) as any;
      expect(entry.staleMaxAge).toBe(0);
      expect(entry.value.body).toBe("v1");
    });

    it("never serves a stale must-revalidate entry, revalidating in the foreground", async () => {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        async () => {
          callCount++;
          // A slow resolver: under SWR a stale entry would be returned immediately (as the
          // sibling test below shows), so a fresh body here proves the foreground path.
          await new Promise((r) => setTimeout(r, 5));
          return new Response(`v${callCount}`, {
            headers: { "cache-control": "public, max-age=60, must-revalidate" },
          });
        },
        { maxAge: 0.02, swr: true, staleMaxAge: 10, name: "must-revalidate-stale" },
      );

      const r1 = (await handler(makeEvent(path))) as Response;
      expect(await r1.text()).toBe("v1");
      expect(callCount).toBe(1);

      // Past maxAge but well inside the configured 10s stale window.
      await new Promise((r) => setTimeout(r, 30));
      const r2 = (await handler(makeEvent(path))) as Response;

      expect(callCount).toBe(2);
      // The caller waited for the revalidated response instead of getting the stale one.
      expect(await r2.text()).toBe("v2");
      expect(r2.headers.get("x-cache")).not.toBe("STALE");
    });

    it("enforces must-revalidate even when the caller's getMaxAge throws", async () => {
      let callCount = 0;
      const path = uniquePath();
      const onError = vi.fn();
      const handler = defineCachedHandler(
        async () => {
          callCount++;
          await new Promise((r) => setTimeout(r, 5));
          return new Response(`v${callCount}`, {
            headers: { "cache-control": "public, max-age=60, must-revalidate" },
          });
        },
        {
          maxAge: 0.02,
          swr: true,
          staleMaxAge: 10,
          name: "must-revalidate-throwing-getmaxage",
          getMaxAge: () => {
            throw new Error("boom");
          },
          onError,
        },
      );

      expect(await ((await handler(makeEvent(path))) as Response).text()).toBe("v1");

      // ocache's own `staleMaxAge: 0` is computed independently of the caller's hook. With
      // the caller's call awaited unguarded, `cache.ts` caught the throw and left *both*
      // values undefined, taking the `must-revalidate` override down with it.
      const keys = await handler.resolveKeys(makeEvent(path));
      expect(((await testStorage.get(keys[0]!)) as any).staleMaxAge).toBe(0);

      // Reported, not swallowed — through the same `onError` channel `cache.ts` uses for
      // this hook, and exactly once.
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);

      await new Promise((r) => setTimeout(r, 30));
      const r2 = (await handler(makeEvent(path))) as Response;

      expect(callCount).toBe(2);
      expect(await r2.text()).toBe("v2");
      expect(r2.headers.get("x-cache")).not.toBe("STALE");
    });

    it("serves stale within the window without must-revalidate (contrast)", async () => {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        async () => {
          callCount++;
          await new Promise((r) => setTimeout(r, 5));
          return new Response(`v${callCount}`, {
            headers: { "cache-control": "public, max-age=60" },
          });
        },
        { maxAge: 0.02, swr: true, staleMaxAge: 10, name: "no-must-revalidate-stale" },
      );

      expect(await ((await handler(makeEvent(path))) as Response).text()).toBe("v1");

      await new Promise((r) => setTimeout(r, 30));
      const r2 = (await handler(makeEvent(path))) as Response;

      // Same setup minus `must-revalidate`: the stale body is served immediately while the
      // refresh runs in the background.
      expect(await r2.text()).toBe("v1");
      expect(r2.headers.get("x-cache")).toBe("STALE");
    });
  });

  it("does not cache responses rejected by shouldCache", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        // A permanent redirect passes the built-in checks (301 is on the cacheable-status
        // allowlist) but the caller wants redirects kept out of the cache. Deliberately
        // *not* a 302 — the built-ins reject that one themselves now, which would leave
        // this test passing without ever consulting `shouldCache`.
        return new Response("", { status: 301, headers: { location: "/elsewhere" } });
      },
      { maxAge: 10, shouldCache: (res) => res.status < 300 },
    );

    await handler(makeEvent(path));
    await handler(makeEvent(path));

    // Rejected by shouldCache -> never served from cache: handler runs every time.
    expect(callCount).toBe(2);
  });

  it("caches responses accepted by shouldCache", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("ok");
      },
      { maxAge: 10, shouldCache: (res) => res.status === 200 },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    const r2 = (await handler(makeEvent(path))) as Response;

    expect(await r1.text()).toBe("ok");
    expect(await r2.text()).toBe("ok");
    // Accepted by shouldCache -> second request served from cache.
    expect(callCount).toBe(1);
    expect(r2.headers.get("x-cache")).toBe("HIT");
  });

  it("shouldCache receives the response entry and supports async", async () => {
    const seen: Array<{ status: number; body: string | undefined }> = [];
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), {
      maxAge: 10,
      shouldCache: async (res) => {
        seen.push({ status: res.status, body: res.body });
        return true;
      },
    });

    await handler(makeEvent(path));

    expect(seen).toContainEqual({ status: 200, body: "ok" });
  });

  it("shouldCache cannot force-cache a response the built-in checks reject", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        // 500 is rejected by the built-in status check; shouldCache returning true
        // must not override that.
        return new Response("err", { status: 500 });
      },
      { maxAge: 10, shouldCache: () => true },
    );

    await handler(makeEvent(path));
    await handler(makeEvent(path));

    expect(callCount).toBe(2);
  });

  it("fails closed (does not cache, does not throw) when shouldCache throws", async () => {
    let callCount = 0;
    const onError = vi.fn();
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("ok");
      },
      {
        maxAge: 10,
        onError,
        shouldCache: () => {
          throw new Error("boom");
        },
      },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    const r2 = (await handler(makeEvent(path))) as Response;

    // The request still succeeds; the response is just never cached.
    expect(await r1.text()).toBe("ok");
    expect(await r2.text()).toBe("ok");
    expect(callCount).toBe(2);
    expect(onError).toHaveBeenCalled();
  });

  // Regression: a corrupt/partial stored entry whose `value` lacks a `headers`
  // field must degrade to a cache miss, not throw from validate()'s cache-control
  // check (which runs before the status/body guards).
  it("degrades to a miss on a corrupt cache entry with no headers", async () => {
    let callCount = 0;
    useTestStorage({
      get: () => ({ value: { status: 200 } }) as any,
      set: () => {},
    });

    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("ok");
      },
      { maxAge: 10 },
    );

    const res = (await handler(makeEvent(uniquePath()))) as Response;
    expect(await res.text()).toBe("ok");
    expect(callCount).toBe(1);
  });

  it("still caches responses with a cacheable explicit cache-control", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("ok", { headers: { "cache-control": "public, max-age=60" } });
      },
      { maxAge: 10 },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    const r2 = (await handler(makeEvent(path))) as Response;

    expect(callCount).toBe(1);
    expect(r1.headers.get("x-cache")).toBe("MISS");
    expect(r2.headers.get("x-cache")).toBe("HIT");
  });

  it("auto-generates an etag but never a last-modified", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("test-body"), { maxAge: 10 });

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("etag")).toMatch(/^W\/".*"$/);
    // Fill time is not a modification time: two bodies filled within one second would
    // share an HTTP-date and the second could be answered with a 304 for the first.
    expect(res.headers.has("last-modified")).toBe(false);
  });

  it("gives a binary body and the text of its base64 form distinct etags", async () => {
    const stored: any[] = [];
    const inner = createMemoryStorage();
    useTestStorage({
      get: (key) => inner.get(key),
      set: (key, value, opts) => {
        stored.push(value);
        return inner.set(key, value, opts);
      },
    });

    // The byte 0xff stores as the base64 text `/w==`, which is itself a valid text body.
    const textHandler = defineCachedHandler(() => new Response("/w=="), { maxAge: 10 });
    const binaryHandler = defineCachedHandler(() => new Response(new Uint8Array([0xff])), {
      maxAge: 10,
    });

    const textRes = (await textHandler(makeEvent(uniquePath()))) as Response;
    const binaryRes = (await binaryHandler(makeEvent(uniquePath()))) as Response;

    // Without this the etags could differ for an unrelated reason and the test would prove nothing.
    expect(stored.map((entry) => entry.value.body)).toEqual(["/w==", "/w=="]);
    expect(stored.map((entry) => entry.value.base64)).toEqual([undefined, true]);

    expect(textRes.headers.get("etag")).toBeTruthy();
    expect(binaryRes.headers.get("etag")).not.toBe(textRes.headers.get("etag"));
  });

  it("preserves existing etag from handler", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(
      () =>
        new Response("body", {
          headers: { etag: '"custom-etag"' },
        }),
      { maxAge: 10 },
    );

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("etag")).toBe('"custom-etag"');
  });

  it("preserves existing last-modified from handler", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(
      () =>
        new Response("body", {
          headers: { "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT" },
        }),
      { maxAge: 10 },
    );

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("last-modified")).toBe("Mon, 01 Jan 2024 00:00:00 GMT");
  });

  it("never answers if-modified-since from a synthesized date", async () => {
    const path = uniquePath();
    let callCount = 0;
    const handler = defineCachedHandler(() => new Response(`v${++callCount}`), { maxAge: 10 });

    const first = (await handler(makeEvent(path))) as Response;
    expect(first.headers.has("last-modified")).toBe(false);
    await handler.invalidate(makeEvent(path));

    // A second body filled in the same second once shared the first one's HTTP-date, so
    // an if-modified-since client holding v1 was told v2 had not changed.
    const res = (await handler(
      makeEvent(path, { headers: { "if-modified-since": new Date("2030-01-01").toUTCString() } }),
    )) as Response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("v2");
  });

  it("returns 304 for matching if-none-match", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => new Response("body", { headers: { etag: '"my-etag"' } }),
      { maxAge: 10 },
    );

    await handler(makeEvent(path));

    const res = (await handler(
      makeEvent(path, {
        headers: { "if-none-match": '"my-etag"' },
      }),
    )) as Response;
    expect(res.status).toBe(304);
  });

  it("returns 304 for if-modified-since", async () => {
    const pastDate = new Date("2020-01-01").toUTCString();
    const futureDate = new Date("2030-01-01").toUTCString();
    const path = uniquePath();

    const handler = defineCachedHandler(
      () =>
        new Response("body", {
          headers: { "last-modified": pastDate },
        }),
      { maxAge: 10 },
    );

    await handler(makeEvent(path));

    const res = (await handler(
      makeEvent(path, {
        headers: { "if-modified-since": futureDate },
      }),
    )) as Response;
    expect(res.status).toBe(304);
  });

  it("does not return 304 when if-modified-since is before last-modified", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(
      () =>
        new Response("body", {
          headers: { "last-modified": new Date("2025-01-01").toUTCString() },
        }),
      { maxAge: 10 },
    );

    await handler(makeEvent(path));

    const res = (await handler(
      makeEvent(path, {
        headers: { "if-modified-since": new Date("2020-01-01").toUTCString() },
      }),
    )) as Response;
    expect(res.status).toBe(200);
  });

  it("does not fall back to if-modified-since when if-none-match misses", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(
      () =>
        new Response("body", {
          headers: { etag: '"v2"', "last-modified": new Date("2020-01-01").toUTCString() },
        }),
      { maxAge: 10 },
    );

    await handler(makeEvent(path));

    // The client holds "v1", so the entry changed even though its date is older.
    const res = (await handler(
      makeEvent(path, {
        headers: {
          "if-none-match": '"v1"',
          "if-modified-since": new Date("2030-01-01").toUTCString(),
        },
      }),
    )) as Response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("body");
  });

  it("compares if-none-match weakly", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => new Response("body", { headers: { etag: '"my-etag"' } }),
      { maxAge: 10 },
    );

    await handler(makeEvent(path));

    const res = (await handler(
      makeEvent(path, { headers: { "if-none-match": 'W/"my-etag"' } }),
    )) as Response;
    expect(res.status).toBe(304);
  });

  it("returns 304 for a matching tag inside an if-none-match list", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => new Response("body", { headers: { etag: 'W/"a,b"' } }),
      { maxAge: 10 },
    );

    await handler(makeEvent(path));

    const res = (await handler(
      makeEvent(path, { headers: { "if-none-match": '"other", W/"a,b", "more"' } }),
    )) as Response;
    expect(res.status).toBe(304);
  });

  it("returns 200 when no tag in an if-none-match list matches", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("body", { headers: { etag: '"v3"' } }), {
      maxAge: 10,
    });

    await handler(makeEvent(path));

    const res = (await handler(
      makeEvent(path, { headers: { "if-none-match": '"v1", "v2"' } }),
    )) as Response;
    expect(res.status).toBe(200);
  });

  it("returns 304 for if-none-match: *", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("body", { headers: { etag: '"v1"' } }), {
      maxAge: 10,
    });

    await handler(makeEvent(path));

    const res = (await handler(makeEvent(path, { headers: { "if-none-match": "*" } }))) as Response;
    expect(res.status).toBe(304);
  });

  it("headersOnly mode delegates to handler", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("body");
      },
      { maxAge: 60, headersOnly: true },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    expect(callCount).toBe(1);
    expect(await r1.text()).toBe("body");
  });

  it("headersOnly returns 304 for the handler's own etag", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => new Response("body", { headers: { etag: '"v1"', vary: "accept-language" } }),
      { maxAge: 60, headersOnly: true },
    );

    const res = (await handler(
      makeEvent(path, { headers: { "if-none-match": 'W/"v1"' } }),
    )) as Response;
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    // A 304 must repeat the variant dimensions of the response it replaces.
    expect(res.headers.get("vary")).toBe("accept-language");
  });

  it("headersOnly serves the full response for a non-matching etag", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("body", { headers: { etag: '"v2"' } }), {
      maxAge: 60,
      headersOnly: true,
    });

    const res = (await handler(
      makeEvent(path, { headers: { "if-none-match": '"v1"' } }),
    )) as Response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("body");
  });

  it("headersOnly returns 304 for the handler's own last-modified", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(
      () =>
        new Response("body", {
          headers: { "last-modified": new Date("2020-01-01").toUTCString() },
        }),
      { maxAge: 60, headersOnly: true },
    );

    const res = (await handler(
      makeEvent(path, {
        headers: { "if-modified-since": new Date("2020-06-01").toUTCString() },
      }),
    )) as Response;
    expect(res.status).toBe(304);
  });

  it("headersOnly ignores conditions without handler validators", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("body"), {
      maxAge: 60,
      headersOnly: true,
    });

    const res = (await handler(
      makeEvent(path, {
        headers: {
          "if-modified-since": new Date("2030-01-01").toUTCString(),
        },
      }),
    )) as Response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("body");
  });

  it("headersOnly does not 304 a non-cacheable method or status", async () => {
    const path = uniquePath();
    const post = defineCachedHandler(() => new Response("body"), {
      maxAge: 60,
      headersOnly: true,
    });
    const missing = defineCachedHandler(() => new Response("nope", { status: 404 }), {
      maxAge: 60,
      headersOnly: true,
    });

    // `*` matches only where a current representation exists.
    const posted = (await post(
      makeEvent(path, { method: "POST", headers: { "if-none-match": "*" } }),
    )) as Response;
    expect(posted.status).toBe(200);

    const notFound = (await missing(
      makeEvent(path, { headers: { "if-none-match": "*" } }),
    )) as Response;
    expect(notFound.status).toBe(404);
  });

  it("headersOnly converts non-Response values and never stores them", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return { id: callCount };
      },
      {
        maxAge: 60,
        headersOnly: true,
        toResponse: (value) => Response.json(value),
      },
    );

    expect(await ((await handler(makeEvent(path))) as Response).json()).toEqual({ id: 1 });
    expect(await ((await handler(makeEvent(path))) as Response).json()).toEqual({ id: 2 });
  });

  it("handles non-Response return values", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => "plain text", { maxAge: 10 });

    const res = (await handler(makeEvent(path))) as Response;
    expect(await res.text()).toBe("plain text");
    expect(res.status).toBe(200);
  });

  it("uses varies headers for cache key differentiation", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`call-${callCount}`);
      },
      { maxAge: 10, varies: ["accept-language"] },
    );

    const r1 = (await handler(
      makeEvent(path, {
        headers: { "accept-language": "en" },
      }),
    )) as Response;
    const r2 = (await handler(
      makeEvent(path, {
        headers: { "accept-language": "fr" },
      }),
    )) as Response;

    expect(callCount).toBe(2);
    expect(await r1.text()).toBe("call-1");
    expect(await r2.text()).toBe("call-2");
  });

  it("emits a Vary response header for configured varies", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), {
      maxAge: 10,
      varies: ["Accept-Language", "X-Custom"],
    });

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("vary")).toBe("accept-language, x-custom");

    // Served from cache on the next request with the same variant
    const cached = (await handler(makeEvent(path))) as Response;
    expect(cached.headers.get("vary")).toBe("accept-language, x-custom");
  });

  it("does not emit a Vary header when varies is empty", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), { maxAge: 10 });

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("vary")).toBe(null);
  });

  it("merges configured varies into a handler-set Vary without duplicates", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(
      () =>
        new Response("ok", {
          headers: { vary: "User-Agent, Accept-Language" },
        }),
      { maxAge: 10, varies: ["accept-language", "x-custom"] },
    );

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("vary")).toBe("User-Agent, Accept-Language, x-custom");
  });

  it("leaves a wildcard Vary header untouched", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok", { headers: { vary: "*" } }), {
      maxAge: 10,
      varies: ["accept-language"],
    });

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("vary")).toBe("*");
  });

  it("leaves a Vary header untouched when `*` appears among other tokens", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => new Response("ok", { headers: { vary: "User-Agent, *" } }),
      { maxAge: 10, varies: ["accept-language"] },
    );

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("vary")).toBe("User-Agent, *");
  });

  describe("handler-declared Vary", () => {
    /**
     * ocache *writes* `Vary` but keys only on `varies`/`allowCookies`, so a handler that
     * declares a header ocache doesn't key on used to get one entry served to every value of
     * it — while that very `Vary` was attached for downstream caches to propagate. The
     * fail-closed fix: refuse the entry, and refuse to advertise a lifetime for it.
     */
    async function twice(
      responseVary: string | undefined,
      opts: any,
      reqHeaders: (i: number) => Record<string, string> = () => ({}),
    ) {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(() => {
        callCount++;
        return new Response(`v${callCount}`, {
          headers: responseVary ? { vary: responseVary } : undefined,
        });
      }, opts);

      const r1 = (await handler(makeEvent(path, { headers: reqHeaders(1) }))) as Response;
      const r2 = (await handler(makeEvent(path, { headers: reqHeaders(2) }))) as Response;
      return {
        callCount,
        first: { body: await r1.text(), status: r1.headers.get("x-cache") },
        second: { body: await r2.text(), status: r2.headers.get("x-cache") },
        cacheControl: r1.headers.get("cache-control"),
        vary: r1.headers.get("vary"),
      };
    }

    it("never stores a response whose Vary names an unkeyed header", async () => {
      const result = await twice("Accept-Language", { maxAge: 60 });

      expect(result.callCount).toBe(2);
      expect(result.second.status).toBe("MISS");
      expect(result.second.body).toBe("v2");
      // Still returned to the caller, its own `Vary` intact.
      expect(result.vary).toBe("Accept-Language");
    });

    it("re-runs the handler per request when it declares Vary: Accept-Language", async () => {
      // The finding's exact scenario: `en` rendered, then `de` got `x-cache: HIT` with the
      // English body. Failing closed costs the hit rate on this (misconfigured) route and
      // gives every request its own resolution again.
      //
      // The route is misconfigured in *both* directions — the handler varies on a header the
      // cache was never told about — so narrowing now hides `accept-language` too and both
      // callers get the default rendering. Declaring `varies: ["accept-language"]` fixes both
      // halves at once: the header reaches the handler, keys the entry and is advertised.
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        (event) => {
          callCount++;
          return new Response(`lang=${event.req.headers.get("accept-language") ?? "none"}`, {
            headers: { vary: "Accept-Language" },
          });
        },
        { maxAge: 60, name: "handler-vary-lang" },
      );

      const en = (await handler(
        makeEvent(path, { headers: { "accept-language": "en" } }),
      )) as Response;
      const de = (await handler(
        makeEvent(path, { headers: { "accept-language": "de" } }),
      )) as Response;

      expect(await en.text()).toBe("lang=none");
      expect(await de.text()).toBe("lang=none");
      // The finding's invariant, unchanged: the second caller is served the handler, not a
      // stored entry — so a route that *does* vary its rendering can never leak across it.
      expect(de.headers.get("x-cache")).toBe("MISS");
      expect(callCount).toBe(2);
      // And nothing under the key either variant reads.
      const keys = await handler.resolveKeys(makeEvent(path));
      expect(await testStorage.get(keys[0]!)).toBeNull();
    });

    it("never advertises a lifetime for a response whose Vary is unkeyed", async () => {
      // The gate, and the reason it is needed: unlike the `Cache-Control` opt-outs, a
      // handler declaring `Vary: Accept-Language` sets no `Cache-Control` of its own, so
      // the "don't clobber the handler's header" check does not suppress synthesis. Without
      // this the response was refused storage — origin takes every request — while being
      // advertised `s-maxage=60, stale-while-revalidate=600` to every shared cache.
      const result = await twice("Accept-Language", { maxAge: 60, swr: true, staleMaxAge: 600 });

      expect(result.callCount).toBe(2);
      expect(result.cacheControl).toBeNull();
    });

    it("caches normally when the handler's Vary is a subset of the advertised names", async () => {
      const result = await twice("Accept-Language", {
        maxAge: 60,
        varies: ["accept-language"],
      });

      expect(result.callCount).toBe(1);
      expect(result.second.status).toBe("HIT");
      expect(result.cacheControl).toBe("max-age=60");
      // Merged, not duplicated: the handler's casing wins, ours is deduped away.
      expect(result.vary).toBe("Accept-Language");
    });

    it("caches a handler-declared Vary: Cookie under allowCookies", async () => {
      // The two-list distinction: `allowCookies` drops `cookie` from `keyHeaderNames` (the
      // key carries the finer allowlisted subset) but keeps it in `varyHeaderNames`, which
      // is what this check reads — so the response is keyed at least as finely as it claims.
      const result = await twice("Cookie", { maxAge: 60, allowCookies: ["theme"] }, () => ({
        cookie: "theme=dark",
      }));

      expect(result.callCount).toBe(1);
      expect(result.second.status).toBe("HIT");
      expect(result.vary).toBe("Cookie");
    });

    it.each([
      "accept-language",
      "ACCEPT-LANGUAGE",
      "  Accept-Language  ",
      "accept-language,x-custom",
      "Accept-Language , X-Custom",
      "accept-language, x-custom,",
    ])("matches %o case-insensitively and whitespace-tolerantly", async (responseVary) => {
      const result = await twice(responseVary, {
        maxAge: 60,
        varies: ["accept-language", "x-custom"],
      });

      expect(result.callCount).toBe(1);
      expect(result.second.status).toBe("HIT");
    });

    it("rejects a Vary that mixes keyed and unkeyed names", async () => {
      const result = await twice("Accept-Language, User-Agent", {
        maxAge: 60,
        varies: ["accept-language"],
      });

      expect(result.callCount).toBe(2);
      expect(result.second.status).toBe("MISS");
      expect(result.cacheControl).toBeNull();
    });

    it("still rejects Vary: * — a different verdict on the same header", async () => {
      // Unchanged guard (landed with the `Cache-Control` opt-outs). `hasUnkeyedVary`
      // deliberately skips the `*` token, so this is `hasVaryWildcard` alone.
      const result = await twice("*", { maxAge: 60, varies: ["accept-language"] });

      expect(result.callCount).toBe(2);
      expect(result.second.status).toBe("MISS");
      expect(result.cacheControl).toBeNull();
      expect(result.vary).toBe("*");
    });

    it("caches normally when the handler declares no Vary at all", async () => {
      const result = await twice(undefined, { maxAge: 60 });

      expect(result.callCount).toBe(1);
      expect(result.second.status).toBe("HIT");
      expect(result.cacheControl).toBe("max-age=60");
      expect(result.vary).toBeNull();
    });

    it("caches an empty Vary header", async () => {
      // Nothing is named, so nothing is unkeyed — an empty list must not fail closed.
      const result = await twice(" , ", { maxAge: 60 });

      expect(result.callCount).toBe(1);
      expect(result.second.status).toBe("HIT");
    });
  });

  it("echoes the Vary header on a 304 response", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), {
      maxAge: 100,
      varies: ["accept-language"],
    });

    const r1 = (await handler(
      makeEvent(path, { headers: { "accept-language": "en" } }),
    )) as Response;
    expect(r1.headers.get("vary")).toBe("accept-language");
    const etag = r1.headers.get("etag")!;

    const r2 = (await handler(
      makeEvent(path, { headers: { "accept-language": "en", "if-none-match": etag } }),
    )) as Response;

    expect(r2.status).toBe(304);
    expect(r2.headers.get("vary")).toBe("accept-language");
  });

  it("only varies the cache key by allowlisted query params (allowQuery)", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`call-${callCount}`);
      },
      { maxAge: 10, allowQuery: ["color"] },
    );

    const r1 = (await handler(makeEvent(`${path}?color=red&lang=en`))) as Response;
    const r2 = (await handler(makeEvent(`${path}?color=red&lang=de&_=123`))) as Response;
    const r3 = (await handler(makeEvent(`${path}?color=blue`))) as Response;

    expect(callCount).toBe(2);
    expect(await r1.text()).toBe("call-1");
    expect(await r2.text()).toBe("call-1");
    expect(await r3.text()).toBe("call-2");
  });

  it("allowQuery is order-independent", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`call-${callCount}`);
      },
      { maxAge: 10, allowQuery: ["a", "b"] },
    );

    const r1 = (await handler(makeEvent(`${path}?a=1&b=2`))) as Response;
    const r2 = (await handler(makeEvent(`${path}?b=2&a=1`))) as Response;

    expect(callCount).toBe(1);
    expect(await r1.text()).toBe("call-1");
    expect(await r2.text()).toBe("call-1");
  });

  it("allowQuery handles repeated (array) params order-independently", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`call-${callCount}`);
      },
      { maxAge: 10, allowQuery: ["color"] },
    );

    const r1 = (await handler(makeEvent(`${path}?color=red&color=blue`))) as Response;
    const r2 = (await handler(makeEvent(`${path}?color=blue&color=red`))) as Response;
    const r3 = (await handler(makeEvent(`${path}?color=red`))) as Response;

    expect(callCount).toBe(2);
    expect(await r1.text()).toBe("call-1");
    expect(await r2.text()).toBe("call-1");
    expect(await r3.text()).toBe("call-2");
  });

  it("allowQuery strips non-allowlisted params from the URL the handler sees", async () => {
    const seen: string[] = [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        const url = event.url ?? new URL(event.req.url);
        seen.push(url.search);
        return new Response("ok");
      },
      { maxAge: 10, allowQuery: ["color"] },
    );

    await handler(makeEvent(`${path}?color=red&lang=de&_=123`));

    expect(seen).toEqual(["?color=red"]);
  });

  // The request authority (scheme/host/port) is part of the resource identity. One handler
  // instance serving several hostnames — the normal vhost deployment — used to store one
  // entry per path across all of them (tenant A's rendering served to tenant B, and an
  // attacker-supplied Host reaching a rendered absolute URL published under the shared key).
  describe("request authority in the cache key", () => {
    const originEvent = (origin: string, path: string, opts?: RequestInit) => ({
      req: new Request(`${origin}${path}`, opts),
    });

    it("keys two hosts apart on one handler instance", async () => {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        () => {
          callCount++;
          return new Response(`call-${callCount}`);
        },
        { maxAge: 10 },
      );

      const r1 = (await handler(originEvent("http://shop.example.com", path))) as Response;
      const r2 = (await handler(originEvent("http://evil.attacker.test", path))) as Response;

      expect(callCount).toBe(2);
      expect(await r1.text()).toBe("call-1");
      expect(r1.headers.get("x-cache")).toBe("MISS");
      expect(await r2.text()).toBe("call-2");
      expect(r2.headers.get("x-cache")).toBe("MISS");

      const [k1] = await handler.resolveKeys(originEvent("http://shop.example.com", path));
      const [k2] = await handler.resolveKeys(originEvent("http://evil.attacker.test", path));
      expect(k1).not.toBe(k2);
    });

    it("keys two schemes apart", async () => {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        () => {
          callCount++;
          return new Response(`call-${callCount}`);
        },
        { maxAge: 10 },
      );

      const r1 = (await handler(originEvent("http://a.example", path))) as Response;
      const r2 = (await handler(originEvent("https://a.example", path))) as Response;

      expect(callCount).toBe(2);
      expect(await r1.text()).toBe("call-1");
      expect(await r2.text()).toBe("call-2");
      expect(r2.headers.get("x-cache")).toBe("MISS");

      const [k1] = await handler.resolveKeys(originEvent("http://a.example", path));
      const [k2] = await handler.resolveKeys(originEvent("https://a.example", path));
      expect(k1).not.toBe(k2);
    });

    it("keys two ports apart", async () => {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        () => {
          callCount++;
          return new Response(`call-${callCount}`);
        },
        { maxAge: 10 },
      );

      const r1 = (await handler(originEvent("http://a.example:8080", path))) as Response;
      const r2 = (await handler(originEvent("http://a.example:9090", path))) as Response;

      expect(callCount).toBe(2);
      expect(await r1.text()).toBe("call-1");
      expect(await r2.text()).toBe("call-2");
      expect(r2.headers.get("x-cache")).toBe("MISS");

      const [k1] = await handler.resolveKeys(originEvent("http://a.example:8080", path));
      const [k2] = await handler.resolveKeys(originEvent("http://a.example:9090", path));
      expect(k1).not.toBe(k2);
    });

    it("never serves one host's rendered absolute URL to another", async () => {
      const path = uniquePath();
      const handler = defineCachedHandler(
        (event) => {
          const url = event.url ?? new URL(event.req.url);
          return new Response(`<link rel="canonical" href="${url.origin}${url.pathname}">`);
        },
        { maxAge: 10 },
      );

      await handler(originEvent("http://evil.attacker.test", path));
      const victim = (await handler(originEvent("http://shop.example.com", path))) as Response;

      const body = await victim.text();
      expect(body).toBe(`<link rel="canonical" href="http://shop.example.com${path}">`);
      expect(body).not.toContain("evil.attacker.test");
    });

    it("still HITs for the same origin and path", async () => {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        () => {
          callCount++;
          return new Response(`call-${callCount}`);
        },
        { maxAge: 10 },
      );

      await handler(originEvent("http://a.example", path));
      const r2 = (await handler(originEvent("http://a.example", path))) as Response;

      expect(callCount).toBe(1);
      expect(await r2.text()).toBe("call-1");
      expect(r2.headers.get("x-cache")).toBe("HIT");
    });

    it("normalizes the default port (http://h:80 is http://h)", async () => {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        () => {
          callCount++;
          return new Response(`call-${callCount}`);
        },
        { maxAge: 10 },
      );

      await handler(originEvent("http://a.example", path));
      const r2 = (await handler(originEvent("http://a.example:80", path))) as Response;

      expect(callCount).toBe(1);
      expect(r2.headers.get("x-cache")).toBe("HIT");
    });

    // An opaque origin (`URL.origin === "null"`) still carries a real authority for every
    // non-special scheme, so the key falls back to `protocol//host` rather than collapsing
    // every such request onto one shared "null" bucket.
    it("keys opaque-origin authorities apart", async () => {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        () => {
          callCount++;
          return new Response(`call-${callCount}`);
        },
        { maxAge: 10 },
      );

      expect(new URL(`x-proxy://a.example${path}`).origin).toBe("null");

      const r1 = (await handler(originEvent("x-proxy://a.example", path))) as Response;
      const r2 = (await handler(originEvent("x-proxy://b.example", path))) as Response;
      const r3 = (await handler(originEvent("x-proxy://a.example", path))) as Response;

      expect(callCount).toBe(2);
      expect(await r1.text()).toBe("call-1");
      expect(await r2.text()).toBe("call-2");
      expect(await r3.text()).toBe("call-1");
    });

    it("still narrows the search component by allowQuery within one origin", async () => {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        () => {
          callCount++;
          return new Response(`call-${callCount}`);
        },
        { maxAge: 10, allowQuery: ["color"] },
      );

      const r1 = (await handler(
        originEvent("http://a.example", `${path}?color=red&lang=en`),
      )) as Response;
      const r2 = (await handler(
        originEvent("http://a.example", `${path}?color=red&lang=de&_=1`),
      )) as Response;
      const r3 = (await handler(originEvent("http://a.example", `${path}?color=blue`))) as Response;
      // ...but the narrowed search is still scoped to one authority.
      const r4 = (await handler(
        originEvent("http://b.example", `${path}?color=red&lang=en`),
      )) as Response;

      expect(callCount).toBe(3);
      expect(await r1.text()).toBe("call-1");
      expect(await r2.text()).toBe("call-1");
      expect(await r3.text()).toBe("call-2");
      expect(await r4.text()).toBe("call-3");
    });
  });

  it("by default strips the Cookie header before the handler and never varies the key", async () => {
    const seen: (string | null)[] = [];
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        callCount++;
        seen.push(event.req.headers.get("cookie"));
        return new Response(`call-${callCount}`);
      },
      { maxAge: 10 },
    );

    const r1 = (await handler(
      makeEvent(path, { headers: { cookie: "sid=abc; theme=dark" } }),
    )) as Response;
    const r2 = (await handler(
      makeEvent(path, { headers: { cookie: "sid=xyz; theme=light" } }),
    )) as Response;

    // Different cookies share one entry (cookies don't vary the key) ...
    expect(callCount).toBe(1);
    expect(await r1.text()).toBe("call-1");
    expect(await r2.text()).toBe("call-1");
    // ... and the handler never saw the Cookie header.
    expect(seen).toEqual([null]);
  });

  it("varies the key by the allowlisted cookie subset only (allowCookies)", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`call-${callCount}`);
      },
      { maxAge: 10, allowCookies: ["theme"] },
    );

    // Same `theme`, different unrelated `sid` -> one entry (sid ignored).
    const r1 = (await handler(
      makeEvent(path, { headers: { cookie: "theme=dark; sid=1" } }),
    )) as Response;
    const r2 = (await handler(
      makeEvent(path, { headers: { cookie: "sid=2; theme=dark" } }),
    )) as Response;
    // Different `theme` -> a separate entry.
    const r3 = (await handler(makeEvent(path, { headers: { cookie: "theme=light" } }))) as Response;

    expect(callCount).toBe(2);
    expect(await r1.text()).toBe("call-1");
    expect(await r2.text()).toBe("call-1");
    expect(await r3.text()).toBe("call-2");
  });

  it("allowCookies keeps only allowlisted cookies in the Cookie header the handler sees", async () => {
    const seen: (string | null)[] = [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        seen.push(event.req.headers.get("cookie"));
        return new Response("ok");
      },
      { maxAge: 10, allowCookies: ["theme"] },
    );

    await handler(makeEvent(path, { headers: { cookie: "sid=secret; theme=dark" } }));

    expect(seen).toEqual(["theme=dark"]);
  });

  it("by default strips a Set-Cookie from the response and caches the rest", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`call-${callCount}`, {
          headers: { "set-cookie": `sid=${callCount}; HttpOnly` },
        });
      },
      { maxAge: 10, swr: false },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    const r2 = (await handler(makeEvent(path))) as Response;

    // The per-request cookie is stripped, so nothing per-client remains and the
    // response is cacheable — the second request is a hit.
    expect(callCount).toBe(1);
    // No caller receives a Set-Cookie (a shared cache must not carry per-client cookies).
    expect(r1.headers.get("set-cookie")).toBeNull();
    expect(r2.headers.get("set-cookie")).toBeNull();
    expect(await r1.text()).toBe("call-1");
    expect(await r2.text()).toBe("call-1");
  });

  it("does not share a per-request Set-Cookie across concurrent (coalesced) callers (issue #61)", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("ok", {
          headers: { "set-cookie": `sid=coalesced-${callCount}` },
        });
      },
      { maxAge: 10 },
    );

    // Two concurrent requests collapse onto one resolution. Neither must receive the
    // leader's minted session cookie.
    const [a, b] = (await Promise.all([handler(makeEvent(path)), handler(makeEvent(path))])) as [
      Response,
      Response,
    ];

    expect(a.headers.get("set-cookie")).toBeNull();
    expect(b.headers.get("set-cookie")).toBeNull();
  });

  it("strips an allowlisted Set-Cookie too, and still caches the rest", async () => {
    let allowedCalls = 0;
    const allowedPath = uniquePath();
    const allowedHandler = defineCachedHandler(
      () => {
        allowedCalls++;
        return new Response(`call-${allowedCalls}`, {
          headers: { "set-cookie": "theme=dark; Path=/" },
        });
      },
      { maxAge: 10, allowCookies: ["theme"] },
    );

    const a1 = (await allowedHandler(makeEvent(allowedPath))) as Response;
    await allowedHandler(makeEvent(allowedPath));
    // `allowCookies` governs the request side only: even its own names never survive as
    // Set-Cookie — not on the stored entry and not on the direct caller's MISS response.
    // The rest of the response is still cached, so the second request is a hit.
    expect(allowedCalls).toBe(1);
    expect(a1.headers.get("set-cookie")).toBeNull();
    expect(await a1.text()).toBe("call-1");

    let mixedCalls = 0;
    const mixedPath = uniquePath();
    const mixedHandler = defineCachedHandler(
      () => {
        mixedCalls++;
        const headers = new Headers();
        headers.append("set-cookie", "theme=dark");
        headers.append("set-cookie", `sid=${mixedCalls}`);
        return new Response(`call-${mixedCalls}`, { headers });
      },
      { maxAge: 10, swr: false, allowCookies: ["theme"] },
    );

    const m1 = (await mixedHandler(makeEvent(mixedPath))) as Response;
    await mixedHandler(makeEvent(mixedPath));
    // Both cookies go — the allowlisted `theme` alongside the unlisted `sid`.
    expect(mixedCalls).toBe(1);
    expect(m1.headers.getSetCookie()).toEqual([]);
  });

  it("never replays an allowlisted Set-Cookie to a later caller (h3#1524 audit, #15c)", async () => {
    // The session-fixation repro. The handler mints a session id on every call and
    // `sid` is allowlisted, so it used to be stored on the entry: the first visitor
    // (no `sid` cookie) seeded the *no-sid* key with `Set-Cookie: sid=s1`, and every
    // subsequent first-time visitor — same key, since they also have no `sid` — was
    // served that same `sid=s1` on a HIT. Measured as `MISS sid=s1 / HIT sid=s1`.
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        callCount++;
        const existing = event.req.headers.get("cookie");
        return new Response(existing ?? "anonymous", {
          headers: { "set-cookie": `sid=s${callCount}; Path=/; HttpOnly` },
        });
      },
      { maxAge: 10, swr: false, allowCookies: ["sid"] },
    );

    // Visitor A: no cookie yet -> MISS.
    const a = (await handler(makeEvent(path))) as Response;
    // Visitor B: also no cookie, so the very same cache key -> HIT.
    const b = (await handler(makeEvent(path))) as Response;

    expect(callCount).toBe(1);
    expect(a.headers.get("set-cookie")).toBeNull();
    expect(b.headers.get("set-cookie")).toBeNull();
    // And nothing was stored that a later hit could replay.
    const [key] = await handler.resolveKeys(makeEvent(path));
    const stored = (await testStorage.get(key!)) as { value: { headers: Record<string, string> } };
    expect(stored.value.headers["set-cookie"]).toBeUndefined();
  });

  it("allowCookies still keys on and forwards the cookie it no longer returns", async () => {
    // The two directions are decoupled: the allowlisted cookie is fully live on the
    // request side (visible to the handler, part of the key) while its Set-Cookie
    // counterpart is unconditionally dropped.
    const seen: (string | null)[] = [];
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        callCount++;
        seen.push(event.req.headers.get("cookie"));
        return new Response(`call-${callCount}`, {
          headers: { "set-cookie": "theme=dark; Path=/" },
        });
      },
      { maxAge: 10, swr: false, allowCookies: ["theme"] },
    );

    const dark = (await handler(
      makeEvent(path, { headers: { cookie: "sid=secret; theme=dark" } }),
    )) as Response;
    const light = (await handler(
      makeEvent(path, { headers: { cookie: "theme=light" } }),
    )) as Response;
    const darkAgain = (await handler(
      makeEvent(path, { headers: { cookie: "theme=dark; sid=other" } }),
    )) as Response;

    // Request side, unchanged: only `theme` reaches the handler, and it varies the key.
    expect(seen).toEqual(["theme=dark", "theme=light"]);
    expect(callCount).toBe(2);
    expect(await darkAgain.text()).toBe("call-1");
    // Response side: no Set-Cookie, on the misses or the hit.
    expect(dark.headers.get("set-cookie")).toBeNull();
    expect(light.headers.get("set-cookie")).toBeNull();
    expect(darkAgain.headers.get("set-cookie")).toBeNull();
  });

  it("passes Set-Cookie through untouched on a bypassed (non-GET/HEAD) request", async () => {
    // The documented escape hatch: mint per-request cookies from a route that never
    // reaches the cache. A bypassed call skips `serialize` entirely, so the handler's
    // live Response — Set-Cookie included — is returned as-is.
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        const headers = new Headers();
        headers.append("set-cookie", "sid=minted; Path=/; HttpOnly");
        headers.append("set-cookie", "csrf=token");
        return new Response("ok", { headers });
      },
      { maxAge: 10, allowCookies: ["theme"] },
    );

    const res = (await handler(makeEvent(path, { method: "POST" }))) as Response;

    expect(res.headers.getSetCookie()).toEqual(["sid=minted; Path=/; HttpOnly", "csrf=token"]);
  });

  it("rejects a stored entry carrying a Set-Cookie (defense-in-depth)", async () => {
    // Entries written before the unconditional strip existed (e.g. by an older ocache
    // that kept allowlisted cookies on the response), or by another writer sharing the
    // storage, must not be replayed until expiry — `validate` rejects any stored
    // Set-Cookie, allowlist or no allowlist.
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`call-${callCount}`);
      },
      { maxAge: 10, swr: false, allowCookies: ["theme"] },
    );

    // Seed a genuine entry (correct integrity/key), then poison it in place.
    await handler(makeEvent(path));
    expect(callCount).toBe(1);
    const [key] = await handler.resolveKeys(makeEvent(path));
    const stored = (await testStorage.get(key!)) as {
      value: { headers: Record<string, string> };
    };
    stored.value.headers["set-cookie"] = "theme=dark; Path=/";
    await testStorage.set(key!, stored);

    const res = (await handler(makeEvent(path))) as Response;

    // The poisoned entry is refused, so the handler runs again and its cookie-free
    // response is served instead.
    expect(callCount).toBe(2);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toBe("call-2");
  });

  it("strips Set-Cookie on runtimes without getSetCookie", async () => {
    // Simulate an environment whose Headers lacks getSetCookie (older Node / polyfills).
    // The strip is a bare `headers.delete("set-cookie")`, which drops every value
    // everywhere, so it must not depend on being able to enumerate cookies individually.
    const original = Object.getOwnPropertyDescriptor(Headers.prototype, "getSetCookie");
    // @ts-expect-error - deliberately removing the method for this test
    delete Headers.prototype.getSetCookie;
    try {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        () => {
          callCount++;
          return new Response(`call-${callCount}`, {
            headers: { "set-cookie": `sid=${callCount}` },
          });
        },
        { maxAge: 10, swr: false },
      );

      const r1 = (await handler(makeEvent(path))) as Response;
      const r2 = (await handler(makeEvent(path))) as Response;
      // Cookie stripped -> response cacheable, second request is a hit.
      expect(callCount).toBe(1);
      // And no Set-Cookie survives to any caller.
      expect(r1.headers.get("set-cookie")).toBeNull();
      expect(r2.headers.get("set-cookie")).toBeNull();
    } finally {
      if (original) {
        Object.defineProperty(Headers.prototype, "getSetCookie", original);
      }
    }
  });

  it("allowCookies supersedes varies: ['cookie']", async () => {
    let callCount = 0;
    const seen: (string | null)[] = [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        callCount++;
        seen.push(event.req.headers.get("cookie"));
        return new Response(`call-${callCount}`);
      },
      { maxAge: 10, varies: ["cookie"], allowCookies: ["theme"] },
    );

    // Only `theme` should drive the key — differing `sid` (which `varies:["cookie"]`
    // would otherwise fold in as the whole raw header) must not create a new entry.
    const r1 = (await handler(
      makeEvent(path, { headers: { cookie: "theme=dark; sid=1" } }),
    )) as Response;
    const r2 = (await handler(
      makeEvent(path, { headers: { cookie: "theme=dark; sid=2" } }),
    )) as Response;

    expect(callCount).toBe(1);
    expect(await r1.text()).toBe("call-1");
    expect(await r2.text()).toBe("call-1");
    // The handler still sees the allowlisted cookie (not stripped by the vary filter).
    expect(seen).toEqual(["theme=dark"]);
  });

  it("advertises Vary: cookie when allowCookies is set", async () => {
    // `allowCookies` keys on a hash of the allowlisted *subset* rather than on the raw
    // header, so `cookie` is dropped from the key list — but the response still varies by
    // the `Cookie` request header, which is the only granularity a downstream cache
    // understands. Without the advertisement a CDN stores one visitor's variant and serves
    // it to everyone under the `s-maxage` we synthesize.
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`call-${callCount}`);
      },
      { maxAge: 60, swr: true, allowCookies: ["theme"] },
    );

    const dark = (await handler(
      makeEvent(path, { headers: { cookie: "theme=dark; sid=1" } }),
    )) as Response;
    const light = (await handler(
      makeEvent(path, { headers: { cookie: "theme=light; sid=2" } }),
    )) as Response;
    const darkAgain = (await handler(
      makeEvent(path, { headers: { cookie: "sid=3; theme=dark" } }),
    )) as Response;

    // The advertisement ...
    expect(dark.headers.get("vary")).toBe("cookie");
    expect(light.headers.get("vary")).toBe("cookie");
    // ... accompanies a shared-cacheability claim, which is exactly why it must be there.
    expect(dark.headers.get("cache-control")).toBe("max-age=60, s-maxage=60");
    // ... and it is true: two `theme` values are two entries, while the unlisted `sid`
    // still doesn't split them (key composition unchanged).
    expect(callCount).toBe(2);
    expect(await dark.text()).toBe("call-1");
    expect(await light.text()).toBe("call-2");
    expect(await darkAgain.text()).toBe("call-1");
  });

  it("advertises Vary: cookie exactly once for varies: ['cookie'] + allowCookies", async () => {
    // The allowlist supersedes the coarse `varies` entry for *keying* only; the caller's
    // explicit `varies: ["cookie"]` must not silently lose its `Vary`, and must not be
    // duplicated by the allowlist adding the same name back.
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`call-${callCount}`);
      },
      { maxAge: 10, varies: ["cookie"], allowCookies: ["theme"] },
    );

    const r1 = (await handler(
      makeEvent(path, { headers: { cookie: "theme=dark; sid=1" } }),
    )) as Response;
    const r2 = (await handler(
      makeEvent(path, { headers: { cookie: "theme=dark; sid=2" } }),
    )) as Response;

    expect(r1.headers.get("vary")).toBe("cookie");
    expect(r2.headers.get("vary")).toBe("cookie");
    // Still keyed by the allowlisted subset, never the raw header: `sid` doesn't split.
    expect(callCount).toBe(1);
    expect(await r2.text()).toBe("call-1");
  });

  it("advertises Vary: cookie for varies: ['cookie'] without an allowlist", async () => {
    // Regression guard for the unchanged half: with no `allowCookies`, `cookie` is in both
    // lists and the raw header keys the entry.
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`call-${callCount}`);
      },
      { maxAge: 10, varies: ["cookie"] },
    );

    const r1 = (await handler(makeEvent(path, { headers: { cookie: "sid=1" } }))) as Response;
    const r2 = (await handler(makeEvent(path, { headers: { cookie: "sid=2" } }))) as Response;

    expect(r1.headers.get("vary")).toBe("cookie");
    expect(callCount).toBe(2);
    expect(await r2.text()).toBe("call-2");
  });

  it("forwards the raw Cookie header to the handler for varies: ['cookie'] (coarse opt-in)", async () => {
    // `varies: ["cookie"]` without an allowlist is a coarse opt-in, symmetric with
    // `varies: ["authorization"]` == `allowAuthorization: true`: the raw header composes the
    // key, so the handler may read it. It used to be hashed into the key *and* stripped from
    // the request, so every per-cookie entry held the identical cookie-less default
    // rendering — pure fragmentation, and a contradiction of the documented "`varies`
    // headers are forwarded to the handler" rule.
    let callCount = 0;
    const seen: (string | null)[] = [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        callCount++;
        const cookie = event.req.headers.get("cookie");
        seen.push(cookie);
        return new Response(`call-${callCount}:${cookie}`);
      },
      { maxAge: 10, varies: ["cookie"] },
    );

    const a = (await handler(
      makeEvent(path, { headers: { cookie: "sid=1; theme=dark" } }),
    )) as Response;
    const b = (await handler(
      makeEvent(path, { headers: { cookie: "sid=2; theme=light" } }),
    )) as Response;
    const aAgain = (await handler(
      makeEvent(path, { headers: { cookie: "sid=1; theme=dark" } }),
    )) as Response;

    // The handler sees the full raw header, unfiltered — this is the bug: it used to see
    // nothing at all.
    expect(seen).toEqual(["sid=1; theme=dark", "sid=2; theme=light"]);
    // Two distinct headers -> two entries AND two distinct renderings.
    expect(callCount).toBe(2);
    expect(await a.text()).toBe("call-1:sid=1; theme=dark");
    expect(await b.text()).toBe("call-2:sid=2; theme=light");
    // The same header again is a hit.
    expect(await aAgain.text()).toBe("call-1:sid=1; theme=dark");
    // And the response advertises the dimension it varies on.
    expect(a.headers.get("vary")).toBe("cookie");
  });

  it("derives the same key from an already-served event under varies: ['cookie'] (no drift)", async () => {
    // The documented issue-#71 pattern: serve, then purge with the very same event.
    // Narrowing mutates `event.req`, so while the Cookie header was stripped from the
    // handler-visible request but still hashed into the key, re-deriving the key from the
    // served event produced the *no-cookie* key — a different one than the entry had just
    // been written under, so the purge silently hit nothing and the stale entry kept being
    // served for the rest of the TTL.
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`call-${callCount}`);
      },
      { maxAge: 10, swr: false, varies: ["cookie"] },
    );

    const event = makeEvent(path, { headers: { cookie: "sid=1" } });
    await handler(event);
    expect(callCount).toBe(1);

    // Re-derived AFTER the event was served: still the key the entry lives under.
    const [key] = await handler.resolveKeys(event);
    expect(await testStorage.get(key!)).toBeDefined();

    await handler.invalidate(event);

    expect(await testStorage.get(key!)).toBeNull();
    // ... so the next request for that cookie is a genuine miss.
    const res = (await handler(makeEvent(path, { headers: { cookie: "sid=1" } }))) as Response;
    expect(callCount).toBe(2);
    expect(await res.text()).toBe("call-2");
  });

  it("allowCookies supersedes varies: ['cookie'] for handler visibility too", async () => {
    // The allowlist is the finer form and stays in charge in both directions: unlisted
    // cookies neither vary the key nor reach the handler, even with the coarse
    // `varies: ["cookie"]` opt-in also set.
    let callCount = 0;
    const seen: (string | null)[] = [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        callCount++;
        seen.push(event.req.headers.get("cookie"));
        return new Response(`call-${callCount}`);
      },
      { maxAge: 10, varies: ["cookie"], allowCookies: ["theme"] },
    );

    const dark = (await handler(
      makeEvent(path, { headers: { cookie: "theme=dark; sid=1" } }),
    )) as Response;
    const darkOtherSid = (await handler(
      makeEvent(path, { headers: { cookie: "sid=2; theme=dark" } }),
    )) as Response;
    const light = (await handler(
      makeEvent(path, { headers: { cookie: "theme=light; sid=3" } }),
    )) as Response;

    // Only `theme` is forwarded — the raw header never reaches the handler.
    expect(seen).toEqual(["theme=dark", "theme=light"]);
    // ... and only `theme` varies the key: the differing `sid` doesn't split the entry.
    expect(callCount).toBe(2);
    expect(await dark.text()).toBe("call-1");
    expect(await darkOtherSid.text()).toBe("call-1");
    expect(await light.text()).toBe("call-2");
  });

  it("keeps cookies out of caching entirely with neither varies: ['cookie'] nor allowCookies", async () => {
    // The untouched secure default: no cookie in the key, none visible to the handler, and
    // nothing advertised downstream.
    let callCount = 0;
    const seen: (string | null)[] = [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        callCount++;
        seen.push(event.req.headers.get("cookie"));
        return new Response(`call-${callCount}`);
      },
      { maxAge: 10 },
    );

    const r1 = (await handler(makeEvent(path, { headers: { cookie: "sid=1" } }))) as Response;
    const r2 = (await handler(makeEvent(path, { headers: { cookie: "sid=2" } }))) as Response;

    expect(seen).toEqual([null]);
    expect(callCount).toBe(1);
    expect(await r2.text()).toBe("call-1");
    expect(r1.headers.get("vary")).toBeNull();
    expect(r2.headers.get("vary")).toBeNull();
  });

  it("advertises the credential headers alongside cookie when both are opted into", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), {
      maxAge: 10,
      allowCookies: ["theme"],
      allowAuthorization: true,
    });

    const res = (await handler(
      makeEvent(path, { headers: { cookie: "theme=dark", authorization: "Bearer t" } }),
    )) as Response;

    expect(res.headers.get("vary")).toBe("authorization, cookie, proxy-authorization");
  });

  it("merges Vary: cookie into a handler-set Vary without clobbering it", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => new Response("ok", { headers: { vary: "User-Agent" } }),
      { maxAge: 10, allowCookies: ["theme"] },
    );

    const res = (await handler(makeEvent(path, { headers: { cookie: "theme=dark" } }))) as Response;

    expect(res.headers.get("vary")).toBe("User-Agent, cookie");
  });

  it("does not narrow requests that bypass caching (non-GET/HEAD)", async () => {
    const seen: Array<{ cookie: string | null; varied: string | null; url: string; body: string }> =
      [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      async (event) => {
        seen.push({
          cookie: event.req.headers.get("cookie"),
          varied: event.req.headers.get("x-var"),
          url: event.req.url,
          body: await event.req.text(),
        });
        return new Response("ok");
      },
      { maxAge: 10, allowCookies: ["theme"], allowQuery: ["q"], varies: ["x-var"] },
    );

    // A POST bypasses the cache entirely (never stored or key-derived), so the
    // request must reach the handler untouched: cookies not narrowed to the
    // allowlist, varied headers not filtered, query not narrowed, body preserved.
    await handler(
      makeEvent(`${path}?q=1&extra=2`, {
        method: "POST",
        headers: { cookie: "sid=secret; theme=dark", "x-var": "v" },
        body: "payload",
        duplex: "half",
      } as RequestInit & { headers: Record<string, string> }),
    );

    expect(seen).toEqual([
      {
        cookie: "sid=secret; theme=dark",
        varied: "v",
        url: `http://localhost${path}?q=1&extra=2`,
        body: "payload",
      },
    ]);
  });

  // --- Narrowing is gated on the *composed* bypass (finding 09) ---
  //
  // Narrowing used to consult the built-in method/Range check alone, so a GET the caller
  // excluded via `shouldBypassCache` still reached the handler stripped — breaking the one
  // escape hatch the credential defaults document ("set `allowAuthorization`, or bypass
  // those requests"): the handler served the anonymous page to every authenticated user.

  /** The finding's fixture: bypass on `Authorization`, narrow the query to `page`. */
  function bypassOnAuth(seen: Array<Record<string, string | null>>) {
    return defineCachedHandler(
      (event) => {
        seen.push({
          auth: event.req.headers.get("authorization"),
          cookie: event.req.headers.get("cookie"),
          url: event.req.url,
        });
        return new Response("ok");
      },
      {
        maxAge: 10,
        allowQuery: ["page"],
        shouldBypassCache: (event) => event.req.headers.has("authorization"),
      },
    );
  }

  it("does not narrow a request the caller's shouldBypassCache excluded (finding 09)", async () => {
    const seen: Array<Record<string, string | null>> = [];
    const path = uniquePath();
    const handler = bypassOnAuth(seen);

    await handler(
      makeEvent(`${path}?page=2&token=abc`, {
        headers: { authorization: "Bearer t0ken", cookie: "sid=s1" },
      }),
    );

    // Excluded from the cache, so it is never keyed: credentials and the full query must
    // arrive intact, exactly as they do for a POST.
    expect(seen).toEqual([
      {
        auth: "Bearer t0ken",
        cookie: "sid=s1",
        url: `http://localhost${path}?page=2&token=abc`,
      },
    ]);
  });

  it("still narrows a cacheable request when a caller shouldBypassCache is set", async () => {
    const seen: Array<Record<string, string | null>> = [];
    const path = uniquePath();
    const handler = bypassOnAuth(seen);

    // Same handler, same request minus the credential the bypass keys on: this one *is*
    // cached, so the unchanged guard applies — cookie stripped, query narrowed.
    await handler(makeEvent(`${path}?page=2&token=abc`, { headers: { cookie: "sid=s1" } }));

    expect(seen).toEqual([{ auth: null, cookie: null, url: `http://localhost${path}?page=2` }]);
  });

  it("evaluates an async caller shouldBypassCache exactly once per call", async () => {
    let hookCalls = 0;
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("ok");
      },
      {
        maxAge: 10,
        // Async, and counted: narrowing must read the verdict this produced, not ask again.
        shouldBypassCache: async (event) => {
          hookCalls++;
          await Promise.resolve();
          return event.req.headers.has("x-bypass");
        },
      },
    );

    await handler(makeEvent(path));
    expect(hookCalls).toBe(1);
    await handler(makeEvent(path, { headers: { "x-bypass": "1" } }));
    expect(hookCalls).toBe(2);
    expect(callCount).toBe(2);
  });

  it("evaluates a caller shouldBypassCache once per call under concurrent deduplication", async () => {
    let hookCalls = 0;
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      async () => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response("ok");
      },
      {
        maxAge: 10,
        shouldBypassCache: async (event) => {
          hookCalls++;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return event.req.headers.has("x-bypass");
        },
      },
    );

    await Promise.all(Array.from({ length: 5 }, () => handler(makeEvent(path))));

    // One hook call per request (the hook is per-request by contract — it may answer
    // differently for each), and one handler call for all five: they coalesce onto the
    // leader's resolution, whose narrowing reuses the verdict rather than re-asking.
    expect(hookCalls).toBe(5);
    expect(callCount).toBe(1);
  });

  it("keeps the bypass contract for a caller-excluded request: not stored, not serialized", async () => {
    let callCount = 0;
    const path = uniquePath();
    const original = new Response("live");
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return original;
      },
      { maxAge: 10, shouldBypassCache: (event) => event.req.headers.has("x-bypass") },
    );

    const headers = { "x-bypass": "1" };
    const res = (await handler(makeEvent(path, { headers }))) as Response;

    // The live Response instance flows straight back out — no `serialize`, so no
    // synthesized cache headers — and nothing is stored, so the handler runs every time.
    expect(res).toBe(original);
    expect(res.headers.has("etag")).toBe(false);
    expect(res.headers.has("last-modified")).toBe(false);
    expect(res.headers.has("cache-control")).toBe(false);
    expect(res.headers.has("x-cache")).toBe(false);
    await handler(makeEvent(path, { headers }));
    expect(callCount).toBe(2);
    // And a later cacheable request still misses: the bypassed one wrote no entry.
    const cacheable = (await handler(makeEvent(path))) as Response;
    expect(cacheable.headers.get("x-cache")).toBe("MISS");
    expect(callCount).toBe(3);
  });

  it("a Range request still narrows nothing and caches nothing (built-in bypass)", async () => {
    const seen: Array<Record<string, string | null>> = [];
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        callCount++;
        seen.push({
          auth: event.req.headers.get("authorization"),
          cookie: event.req.headers.get("cookie"),
          range: event.req.headers.get("range"),
          url: event.req.url,
        });
        return new Response("ok");
      },
      { maxAge: 10, allowQuery: ["page"], allowCookies: ["theme"] },
    );

    const headers = {
      range: "bytes=0-0",
      authorization: "Bearer t0ken",
      cookie: "sid=s1; theme=dark",
    };
    const res = (await handler(makeEvent(`${path}?page=2&token=abc`, { headers }))) as Response;

    expect(seen).toEqual([
      {
        auth: "Bearer t0ken",
        cookie: "sid=s1; theme=dark",
        range: "bytes=0-0",
        url: `http://localhost${path}?page=2&token=abc`,
      },
    ]);
    expect(res.headers.has("x-cache")).toBe(false);
    await handler(makeEvent(`${path}?page=2&token=abc`, { headers }));
    expect(callCount).toBe(2);
  });

  // --- Narrowing that cannot be applied must fail closed ---
  //
  // Narrowing rewrites `event.req` (and `event.url` under `allowQuery`) in place. A
  // framework event that exposes either as a read-only accessor used to log the failure
  // and run the handler anyway: the handler then read the credentials and excluded query
  // values that the key does not cover, and the result was stored under — and advertised
  // for — that key. The request must instead be served exactly as an explicit bypass.
  describe("an event that cannot be narrowed", () => {
    /** An event whose `req` is a getter: assigning to it throws in strict mode. */
    function readonlyReqEvent(path: string, headers: Record<string, string>) {
      const req = new Request(`http://localhost${path}`, { headers });
      return Object.defineProperty({} as HTTPEvent, "req", { get: () => req, enumerable: true });
    }

    /** An event with a writable `req` but a getter-only `url`. */
    function readonlyUrlEvent(path: string, headers: Record<string, string>) {
      const event = { req: new Request(`http://localhost${path}`, { headers }) } as HTTPEvent;
      const url = new URL(event.req.url);
      return Object.defineProperty(event, "url", { get: () => url, enumerable: true });
    }

    it("serves a read-only `req` uncached instead of keying past the credentials", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        (event) => {
          callCount++;
          return new Response(event.req.headers.get("authorization") ?? "anonymous");
        },
        { maxAge: 10 },
      );

      const headers = { authorization: "Bearer alice" };
      const res = (await handler(readonlyReqEvent(path, headers))) as Response;

      // The handler still runs and still sees the untouched request, as under a bypass...
      expect(await res.text()).toBe("Bearer alice");
      // ...but nothing is stored and nothing is advertised to a shared cache.
      expect(res.headers.has("x-cache")).toBe(false);
      expect(res.headers.has("cache-control")).toBe(false);
      const [getKey] = await handler.resolveKeys(makeEvent(path));
      expect(await testStorage.get(getKey!)).toBeFalsy();

      // Alice's response is not replayed to the next caller, keyed or not.
      const anon = (await handler(makeEvent(path))) as Response;
      expect(await anon.text()).toBe("anonymous");
      expect(callCount).toBe(2);

      expect(errorSpy).toHaveBeenCalledWith("[cache] Bypassing cache.", expect.any(Error));
      errorSpy.mockRestore();
    });

    it("restores the request when only `url` is read-only (never narrows partially)", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let callCount = 0;
      const seen: Array<{ cookie: string | null; url: string }> = [];
      const path = uniquePath();
      const handler = defineCachedHandler(
        (event) => {
          callCount++;
          seen.push({
            cookie: event.req.headers.get("cookie"),
            url: (event.url ?? new URL(event.req.url)).search,
          });
          return new Response("ok");
        },
        { maxAge: 10, allowQuery: ["page"] },
      );

      const headers = { cookie: "sid=secret" };
      const res = (await handler(
        readonlyUrlEvent(`${path}?page=2&token=abc`, headers),
      )) as Response;

      // `event.req` was swapped before the `url` assignment threw, so it is put back: the
      // handler must not see a half-narrowed event where the two disagree.
      expect(seen).toEqual([{ cookie: "sid=secret", url: "?page=2&token=abc" }]);
      expect(res.headers.has("x-cache")).toBe(false);
      expect(callCount).toBe(1);

      // Nothing was stored under the query-narrowed key.
      await handler(makeEvent(`${path}?page=2&token=abc`));
      expect(callCount).toBe(2);

      errorSpy.mockRestore();
    });

    it("reports the failure through `onError` when one is set", async () => {
      const onError = vi.fn();
      const path = uniquePath();
      const handler = defineCachedHandler(() => new Response("ok"), { maxAge: 10, onError });

      await handler(readonlyReqEvent(path, {}));

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]![0]).toMatchObject({ name: "NarrowRequestError" });
    });
  });

  it("by default hides Authorization from the handler so token content is never shared", async () => {
    let callCount = 0;
    const seen: (string | null)[] = [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        callCount++;
        const auth = event.req.headers.get("authorization");
        seen.push(auth);
        // A handler that renders per-user content from the token — the exact shape that
        // used to be stored under the anonymous key and replayed to everyone.
        return new Response(auth ? `private-for-${auth}` : "anonymous");
      },
      { maxAge: 10 },
    );

    const authed = (await handler(
      makeEvent(path, { headers: { authorization: "Bearer alice" } }),
    )) as Response;
    const anon = (await handler(makeEvent(path))) as Response;

    // The credential never reaches the handler, so there is no per-user body to leak.
    expect(seen).toEqual([null]);
    expect(await authed.text()).toBe("anonymous");
    expect(await anon.text()).toBe("anonymous");
    // ... and it never varies the key either (one shared entry).
    expect(callCount).toBe(1);
    expect(authed.headers.get("vary")).toBeNull();
  });

  it("by default hides Proxy-Authorization from the handler", async () => {
    const seen: (string | null)[] = [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        seen.push(event.req.headers.get("proxy-authorization"));
        return new Response("ok");
      },
      { maxAge: 10 },
    );

    await handler(makeEvent(path, { headers: { "proxy-authorization": "Basic zzz" } }));

    expect(seen).toEqual([null]);
  });

  it("allowAuthorization keys per credential, varies, and exposes the header", async () => {
    let callCount = 0;
    const seen: (string | null)[] = [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        callCount++;
        const auth = event.req.headers.get("authorization");
        seen.push(auth);
        return new Response(`call-${callCount}:${auth}`);
      },
      { maxAge: 10, allowAuthorization: true },
    );

    const a1 = (await handler(
      makeEvent(path, { headers: { authorization: "Bearer alice" } }),
    )) as Response;
    const a2 = (await handler(
      makeEvent(path, { headers: { authorization: "Bearer alice" } }),
    )) as Response;
    const b1 = (await handler(
      makeEvent(path, { headers: { authorization: "Bearer bob" } }),
    )) as Response;

    // The handler can read the credential ...
    expect(seen).toEqual(["Bearer alice", "Bearer bob"]);
    // ... and each distinct value gets its own entry (same value = a hit).
    expect(callCount).toBe(2);
    expect(await a1.text()).toBe("call-1:Bearer alice");
    expect(await a2.text()).toBe("call-1:Bearer alice");
    expect(await b1.text()).toBe("call-2:Bearer bob");
    // Downstream caches are told about the dimension too.
    const vary = a1.headers.get("vary")!.toLowerCase();
    expect(vary.split(",").map((v) => v.trim())).toEqual(["authorization", "proxy-authorization"]);
  });

  // The documented "private response" recipe (docs/1.guide/8.cache-control.md): the
  // `Cache-Control: private` opt-out is only meaningful if the handler could identify the user
  // in the first place, which under the credential defaults takes `allowAuthorization`. Pins
  // the two halves working *together* — credential visible, personalized response never stored,
  // anonymous rendering still cached under its own key.
  it("allowAuthorization + Cache-Control: private serves per-user without storing it", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        callCount++;
        const user = event.req.headers.get("authorization");
        return user
          ? new Response(`dashboard for ${user} (call ${callCount})`, {
              headers: { "cache-control": "private" },
            })
          : new Response(`public (call ${callCount})`);
      },
      { maxAge: 10, allowAuthorization: true },
    );

    const auth = (user: string) => makeEvent(path, { headers: { authorization: user } });
    const alice1 = (await handler(auth("alice"))) as Response;
    const alice2 = (await handler(auth("alice"))) as Response;
    const bob = (await handler(auth("bob"))) as Response;

    // The credential reaches the handler, and the opt-out keeps every rendering out of
    // storage — so even the same user re-runs it rather than replaying a stored body.
    expect(await alice1.text()).toBe("dashboard for alice (call 1)");
    expect(await alice2.text()).toBe("dashboard for alice (call 2)");
    expect(await bob.text()).toBe("dashboard for bob (call 3)");
    // The directive is returned to the caller untouched.
    expect(alice1.headers.get("cache-control")).toBe("private");

    // The anonymous branch sets no opt-out, so it caches under its own (credential-free) key.
    const anon1 = (await handler(makeEvent(path))) as Response;
    const anon2 = (await handler(makeEvent(path))) as Response;
    expect(await anon1.text()).toBe("public (call 4)");
    expect(await anon2.text()).toBe("public (call 4)");
    expect(anon2.headers.get("x-cache")).toBe("HIT");
    expect(callCount).toBe(4);
  });

  it("treats varies: ['authorization'] as an opt-in (no double vary entry)", async () => {
    const seen: (string | null)[] = [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        seen.push(event.req.headers.get("authorization"));
        return new Response("ok");
      },
      { maxAge: 10, varies: ["authorization"], allowAuthorization: true },
    );

    const res = (await handler(
      makeEvent(path, { headers: { authorization: "Bearer alice" } }),
    )) as Response;

    expect(seen).toEqual(["Bearer alice"]);
    expect(res.headers.get("vary")!.toLowerCase()).toBe("authorization, proxy-authorization");
  });

  it("lets the handler read varied headers and stores one rendering per value", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        callCount++;
        return new Response(`page-${event.req.headers.get("accept-language") ?? "default"}`);
      },
      { maxAge: 10, varies: ["accept-language"] },
    );

    const en = (await handler(
      makeEvent(path, { headers: { "accept-language": "en" } }),
    )) as Response;
    const fr = (await handler(
      makeEvent(path, { headers: { "accept-language": "fr" } }),
    )) as Response;
    const en2 = (await handler(
      makeEvent(path, { headers: { "accept-language": "en" } }),
    )) as Response;

    // Distinct values render distinctly (the handler can see the header) under distinct
    // keys, and a repeat value is a hit.
    expect(await en.text()).toBe("page-en");
    expect(await fr.text()).toBe("page-fr");
    expect(await en2.text()).toBe("page-en");
    expect(callCount).toBe(2);
    expect(en.headers.get("vary")).toBe("accept-language");
  });

  it("does not strip Authorization from requests that bypass caching (non-GET/HEAD)", async () => {
    const seen: (string | null)[] = [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        seen.push(event.req.headers.get("authorization"));
        return new Response("ok");
      },
      { maxAge: 10 },
    );

    await handler(
      makeEvent(path, {
        method: "POST",
        headers: { authorization: "Bearer alice" },
      }),
    );

    expect(seen).toEqual(["Bearer alice"]);
  });

  // --- Narrowing is an allowlist: a handler may read exactly what the key covers ---
  //
  // It used to strip `authorization`/`proxy-authorization`/`cookie` and forward every other
  // header, while the key covers only `keyHeaderNames`. Any undeclared header the handler read
  // was therefore rendered into an entry nothing distinguished: a MISS carrying the header
  // followed by a request without it replayed the first caller's rendering, under a synthesized
  // `max-age` and with no `Vary` to warn a shared cache off it. The credential strip was this
  // same rule applied to two names by hand.

  it("hides an undeclared header and cannot replay one caller's rendering to the next", async () => {
    let callCount = 0;
    const seen: (string | null)[] = [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        callCount++;
        const tenant = event.req.headers.get("x-api-key");
        seen.push(tenant);
        return new Response(`tenant:${tenant ?? "anonymous"}`);
      },
      { maxAge: 10 },
    );

    const first = (await handler(
      makeEvent(path, { headers: { "x-api-key": "alice-secret" } }),
    )) as Response;
    const second = (await handler(makeEvent(path))) as Response;

    // Undeclared ⇒ outside the key ⇒ invisible, so the entry can only ever hold the one
    // rendering every caller on that key is entitled to.
    expect(seen).toEqual([null]);
    expect(await first.text()).toBe("tenant:anonymous");
    expect(await second.text()).toBe("tenant:anonymous");
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(callCount).toBe(1);
  });

  it("hides x-forwarded-host, which the URL authority in the key never covered", async () => {
    const seen: (string | null)[] = [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        const host = event.req.headers.get("x-forwarded-host");
        seen.push(host);
        return new Response(`site:${host ?? "canonical"}`);
      },
      { maxAge: 10 },
    );

    // Behind a proxy the key's authority is the *internal* one, identical for both tenants —
    // so a visible `x-forwarded-host` is the h3#1524 cross-tenant replay by another route.
    const a = (await handler(
      makeEvent(path, { headers: { "x-forwarded-host": "a.example" } }),
    )) as Response;
    const b = (await handler(
      makeEvent(path, { headers: { "x-forwarded-host": "b.example" } }),
    )) as Response;

    expect(seen).toEqual([null]);
    expect(await a.text()).toBe("site:canonical");
    expect(await b.text()).toBe("site:canonical");
  });

  it("normalizes host to the keyed URL authority instead of the raw header", async () => {
    const seen: (string | null)[] = [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        const host = event.req.headers.get("host");
        seen.push(host);
        return new Response(`site:${host ?? "canonical"}`);
      },
      { maxAge: 10 },
    );

    // `makeEvent` resolves every URL to `http://localhost`, the shape of an adapter that
    // builds `event.url` from the connection (or a fixed base) rather than from `Host`. Only
    // that authority is in the key, so a raw `Host` reaching the handler is the h3#1524
    // cross-tenant replay through the one header the allowlist still exempts.
    const a = (await handler(makeEvent(path, { headers: { host: "a.example" } }))) as Response;
    const b = (await handler(makeEvent(path, { headers: { host: "b.example" } }))) as Response;

    expect(seen).toEqual(["localhost"]);
    expect(await a.text()).toBe("site:localhost");
    expect(await b.text()).toBe("site:localhost");
  });

  it("forwards the raw host when varies declares it, which keys the value", async () => {
    const seen: (string | null)[] = [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        const host = event.req.headers.get("host");
        seen.push(host);
        return new Response(`site:${host ?? "canonical"}`);
      },
      { maxAge: 10, varies: ["host"] },
    );

    const a = (await handler(makeEvent(path, { headers: { host: "a.example" } }))) as Response;
    const b = (await handler(makeEvent(path, { headers: { host: "b.example" } }))) as Response;

    // Declared ⇒ keyed ⇒ visible unchanged, the same contract every `varies` header has.
    expect(seen).toEqual(["a.example", "b.example"]);
    expect(await a.text()).toBe("site:a.example");
    expect(await b.text()).toBe("site:b.example");
    expect(b.headers.get("vary")).toContain("host");
  });

  it("forwards host but removes the trace headers, user-agent, and baggage", async () => {
    const seen: Array<Record<string, string | null>> = [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        const get = (name: string) => event.req.headers.get(name);
        seen.push({
          host: get("host"),
          traceparent: get("traceparent"),
          requestId: get("x-request-id"),
          userAgent: get("user-agent"),
          baggage: get("baggage"),
        });
        return new Response("ok");
      },
      { maxAge: 10 },
    );

    await handler(
      makeEvent(path, {
        headers: {
          host: "localhost",
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          "x-request-id": "req-1",
          "user-agent": "curl/8",
          baggage: "tenant=acme",
        },
      }),
    );

    // `host` is keyed (the URL authority), so it survives with the keyed value. Everything
    // else follows the one rule: no key covers it, so the handler cannot read it. The trace
    // headers are unique per request, so no `varies` configuration could ever cover them —
    // that is the reason to remove them, not a reason to exempt them.
    expect(seen).toEqual([
      {
        host: "localhost",
        traceparent: null,
        requestId: null,
        userAgent: null,
        baggage: null,
      },
    ]);
  });

  it("restores a stripped header through varies (the documented escape hatch)", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        callCount++;
        return new Response(`ua:${event.req.headers.get("user-agent") ?? "unknown"}`);
      },
      { maxAge: 10, varies: ["user-agent"] },
    );

    const ua = (agent: string) => makeEvent(path, { headers: { "user-agent": agent } });
    const mobile = (await handler(ua("phone"))) as Response;
    const desktop = (await handler(ua("laptop"))) as Response;

    // Declared ⇒ keyed ⇒ visible, and each value gets its own entry and its own `Vary`.
    expect(await mobile.text()).toBe("ua:phone");
    expect(await desktop.text()).toBe("ua:laptop");
    expect(callCount).toBe(2);
    expect(mobile.headers.get("vary")).toBe("user-agent");
  });

  it("answers 304 on a MISS from validators captured before narrowing", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("body", { headers: { etag: '"v1"' } });
      },
      { maxAge: 10 },
    );

    // First request on this key, so this is a MISS: `handleCacheHeaders` runs *after*
    // narrowing has swapped `event.req`, which no longer carries `if-none-match`. The
    // validator reaches it through `CacheConditions`, read from the original request.
    const res = (await handler(
      makeEvent(path, { headers: { "if-none-match": '"v1"' } }),
    )) as Response;

    expect(res.status).toBe(304);
    expect(callCount).toBe(1);
  });

  it("leaves an undeclared header intact on bypassed requests (non-GET/HEAD, Range)", async () => {
    const seen: Array<Record<string, string | null>> = [];
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        seen.push({
          apiKey: event.req.headers.get("x-api-key"),
          userAgent: event.req.headers.get("user-agent"),
        });
        return new Response("ok");
      },
      { maxAge: 10 },
    );

    const headers = { "x-api-key": "alice-secret", "user-agent": "curl/8" };
    await handler(makeEvent(path, { method: "POST", headers }));
    await handler(makeEvent(path, { headers: { ...headers, range: "bytes=0-0" } }));

    // Never keyed ⇒ never narrowed: a bypassed request reaches the handler as it arrived.
    const intact = { apiKey: "alice-secret", userAgent: "curl/8" };
    expect(seen).toEqual([intact, intact]);
  });

  it("rejects stored entries carrying a non-allowlisted Set-Cookie (pre-upgrade entries)", async () => {
    const written: string[] = [];
    const memory = createMemoryStorage();
    useTestStorage({
      get: (key) => memory.get(key),
      set: (key, value, opts) => {
        written.push(key);
        return memory.set(key, value, opts);
      },
    });

    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`call-${callCount}`);
      },
      { maxAge: 10 },
    );

    await handler(makeEvent(path));
    expect(callCount).toBe(1);
    expect(written.length).toBeGreaterThan(0);

    // Simulate an entry written by a version before Set-Cookie stripping existed:
    // identical shape and integrity, but with a disallowed Set-Cookie collapsed into its
    // serialized headers. Such entries were never stripped on write, so only the
    // read-side validate check stands between it and a replay.
    const entry = (await memory.get(written[0]!)) as any;
    entry.value.headers["set-cookie"] = "sid=old-secret";
    await memory.set(written[0]!, entry);

    const res = (await handler(makeEvent(path))) as Response;

    // The poisoned entry is rejected and re-resolved instead of replayed.
    expect(callCount).toBe(2);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toBe("call-2");
  });

  it("invalidates cache for error responses (4xx/5xx)", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        if (callCount === 1) return new Response("error", { status: 500 });
        return new Response("ok", { status: 200 });
      },
      { maxAge: 10, swr: false },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    expect(r1.status).toBe(500);

    const r2 = (await handler(makeEvent(path))) as Response;
    expect(r2.status).toBe(200);
    expect(callCount).toBe(2);
  });

  it("uses custom getKey for handler", async () => {
    let callCount = 0;
    const fixedKey = `custom-key-${Date.now()}`;
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("ok");
      },
      {
        maxAge: 10,
        getKey: () => fixedKey,
      },
    );

    await handler(makeEvent("/a"));
    await handler(makeEvent("/b"));
    expect(callCount).toBe(1);
  });

  it.each([
    // Both strip to `user1`, so only the appended key hash keeps them apart.
    ["user:1", "user1:"],
    // `foo:bar` strips to `foobar` and gets hashed; `foo_bar` is already clean and
    // stays as-is — the `.` in the hashed form keeps their key spaces disjoint.
    ["foo:bar", "foo_bar"],
  ])("does not collide distinct custom keys (%s vs %s)", async (keyA, keyB) => {
    let id = keyA;
    let callCount = 0;
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(id);
      },
      { maxAge: 10, getKey: () => id },
    );

    id = keyA;
    const a = (await handler(makeEvent("/x"))) as Response;
    id = keyB;
    const b = (await handler(makeEvent("/x"))) as Response;

    // If the keys collide, `b` wrongly hits `a`'s entry and returns keyA.
    expect(await a.text()).toBe(keyA);
    expect(await b.text()).toBe(keyB);
    expect(callCount).toBe(2);
  });

  it("forwards variable headers to the handler request", async () => {
    let receivedHeaders: string | null = null;
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        receivedHeaders = event.req.headers.get("x-custom");
        return new Response("ok");
      },
      { maxAge: 10, varies: ["x-custom"] },
    );

    await handler(
      makeEvent(path, {
        headers: { "x-custom": "value" },
      }),
    );
    // The header is part of the cache key, so the handler is allowed (and expected) to
    // read it — hiding it made every variant hold the same default rendering.
    expect(receivedHeaders).toBe("value");
  });

  it("inherits runtime context on filtered request", async () => {
    let runtimeValue: string | undefined;
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        runtimeValue = (event.req as any).runtime;
        return new Response("ok");
      },
      { maxAge: 10 },
    );

    const req = new Request(`http://localhost${path}`);
    (req as any).runtime = "cloudflare";
    await handler({ req });
    expect(runtimeValue).toBe("cloudflare");
  });

  it("handles URL with special characters", async () => {
    const handler = defineCachedHandler(() => new Response("ok"), { maxAge: 10 });

    const res = (await handler(makeEvent("/path%20with%20spaces?q=hello"))) as Response;
    expect(res.status).toBe(200);
  });

  it("uses event.url when provided", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("ok");
      },
      { maxAge: 10 },
    );

    const url = new URL(`http://localhost${path}`);
    await handler({ req: new Request(`http://localhost${path}`), url });
    await handler({ req: new Request(`http://localhost${path}`), url });
    expect(callCount).toBe(1);
  });

  it("sets max-age=0, s-maxage=0 when swr with maxAge: 0", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), {
      maxAge: 0,
      swr: true,
    });

    const res = (await handler(makeEvent(path))) as Response;
    // A zero lifetime is advertised on both axes (and read back by `validate` as the storage
    // opt-out it is). No stale window is named, so none is advertised.
    expect(res.headers.get("cache-control")).toBe("max-age=0, s-maxage=0");
  });

  it("sets stale-while-revalidate=0 when swr with staleMaxAge: 0", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), {
      maxAge: 60,
      swr: true,
      staleMaxAge: 0,
    });

    const res = (await handler(makeEvent(path))) as Response;
    const cc = res.headers.get("cache-control")!;
    expect(cc).toContain("s-maxage=60");
    expect(cc).toContain("stale-while-revalidate=0");
  });

  it("sets max-age=0 when maxAge: 0 and no swr (same rule as the swr branch)", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), { maxAge: 0, swr: false });

    // The two synthesis branches treat `maxAge` identically: present (`0` included) is
    // advertised, absent is not. This one used to emit nothing while the swr branch above
    // emitted `s-maxage=0` for the very same option. See the storage consequence below.
    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("cache-control")).toBe("max-age=0");
  });

  it("does not store a maxAge: 0 response (its own zero lifetime is an opt-out)", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`v${callCount}`);
      },
      { maxAge: 0, swr: false },
    );

    await handler(makeEvent(path));
    const r2 = (await handler(makeEvent(path))) as Response;

    // `validate` reads the synthesized `max-age=0` exactly as it reads a hand-written one,
    // so a zero lifetime keeps the response out of storage on both branches now (it already
    // did under `swr`, via `s-maxage=0`). The handler ran on every request before this too —
    // the entry it used to write was already expired when written — so what changed is that
    // there is no longer a dead entry in storage, not how often the origin is asked.
    expect(callCount).toBe(2);
    expect(await r2.text()).toBe("v2");
    expect(r2.headers.get("x-cache")).toBe("MISS");
    const keys = await handler.resolveKeys(makeEvent(path));
    expect(await testStorage.get(keys[0]!)).toBeNull();
  });

  // Was "no cache-control when maxAge is absent and no swr", asserting `null` for
  // `{ maxAge: undefined }`. That was the old undefined-vs-absent divergence, not an absent
  // `maxAge`: an unset `maxAge` has always taken the `maxAge: 1` default (`{}` did), and an
  // explicit `undefined` now does too. Silence is `sendCacheControl: false`, tested above.
  it("advertises the maxAge default when maxAge is explicitly undefined and no swr", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), {
      maxAge: undefined,
      swr: false,
    });

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("cache-control")).toBe("max-age=1");
  });

  it("uses custom toResponse hook", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => ({ message: "hello" }), {
      maxAge: 10,
      toResponse: (value) =>
        new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json" },
        }),
    });

    const res = (await handler(makeEvent(path))) as Response;
    expect(await res.text()).toBe('{"message":"hello"}');
  });

  it("uses custom createResponse hook", async () => {
    const path = uniquePath();
    const createResponse = vi.fn(
      (body: string | Uint8Array | null, init: ResponseInit) =>
        new Response(body as BodyInit | null, init),
    );
    const handler = defineCachedHandler(() => new Response("ok"), {
      maxAge: 10,
      createResponse,
    });

    const res = (await handler(makeEvent(path))) as Response;
    expect(await res.text()).toBe("ok");
    expect(createResponse).toHaveBeenCalled();
  });

  it("uses custom createResponse for 304", async () => {
    const path = uniquePath();
    const createResponse = vi.fn(
      (body: string | Uint8Array | null, init: ResponseInit) =>
        new Response(body as BodyInit | null, init),
    );
    const handler = defineCachedHandler(
      () => new Response("body", { headers: { etag: '"test-etag"' } }),
      { maxAge: 10, createResponse },
    );

    await handler(makeEvent(path));
    const res = (await handler(
      makeEvent(path, { headers: { "if-none-match": '"test-etag"' } }),
    )) as Response;
    expect(res.status).toBe(304);
    expect(createResponse).toHaveBeenCalledWith(null, {
      status: 304,
      headers: { "x-cache": "HIT" },
    });
  });

  it("uses custom handleCacheHeaders hook", async () => {
    const path = uniquePath();
    const handleCacheHeaders = vi.fn(() => true);
    const handler = defineCachedHandler(() => new Response("body"), {
      maxAge: 10,
      headersOnly: true,
      handleCacheHeaders,
    });

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.status).toBe(304);
    expect(handleCacheHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ req: expect.any(Request) }),
      expect.objectContaining({ maxAge: 10 }),
    );
  });

  it("custom handleCacheHeaders returning false continues normally", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => new Response("body", { headers: { etag: '"my-etag"' } }),
      {
        maxAge: 10,
        handleCacheHeaders: () => false,
      },
    );

    await handler(makeEvent(path));
    // Even with matching etag, custom hook says "don't 304"
    const res = (await handler(
      makeEvent(path, { headers: { "if-none-match": '"my-etag"' } }),
    )) as Response;
    expect(res.status).toBe(200);
  });

  it("merges default options when partial opts are provided", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), { maxAge: 60 });

    const res = (await handler(makeEvent(path))) as Response;
    const cc = res.headers.get("cache-control")!;
    // swr is off by default, so a plain max-age is synthesized (no SWR directives)
    expect(cc).toContain("max-age=60");
    expect(cc).not.toContain("stale-while-revalidate");
  });

  it("works with generic event type", async () => {
    interface CustomEvent extends HTTPEvent {
      custom: string;
    }
    const path = uniquePath();
    let receivedCustom: string | undefined;
    const handler = defineCachedHandler<CustomEvent>(
      (event) => {
        receivedCustom = event.custom;
        return new Response("ok");
      },
      { maxAge: 10 },
    );

    const event: CustomEvent = {
      req: new Request(`http://localhost${path}`),
      custom: "test-value",
    };
    await handler(event);
    expect(receivedCustom).toBe("test-value");
  });

  // Regression: issue #4 — passing partial opts (e.g. only maxAge) should still merge defaults
  it("inherits swr default when only maxAge is provided", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), { maxAge: 30 });

    const res = (await handler(makeEvent(path))) as Response;
    const cc = res.headers.get("cache-control")!;
    // swr defaults to false, so we get a plain max-age (no SWR directives)
    expect(cc).toContain("max-age=30");
    expect(cc).not.toContain("s-maxage=30");
    expect(cc).not.toContain("stale-while-revalidate");
  });

  // Regression: issue #5 — handler returning undefined etag/last-modified should invalidate cache
  it("invalidates cached entry when etag resolves to string 'undefined'", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        // Return a response where etag header is the literal string "undefined"
        return new Response("body", {
          headers: { etag: "undefined" },
        });
      },
      { maxAge: 10, swr: false },
    );

    // First call caches it, but validate should reject the entry
    await handler(makeEvent(path));
    // Second call should re-invoke handler because the entry was invalidated
    await handler(makeEvent(path));
    expect(callCount).toBe(2);
  });

  it("invalidates cached entry when last-modified resolves to string 'undefined'", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("body", {
          headers: { "last-modified": "undefined" },
        });
      },
      { maxAge: 10, swr: false },
    );

    await handler(makeEvent(path));
    await handler(makeEvent(path));
    expect(callCount).toBe(2);
  });

  it("exposes .resolveKeys(event) matching the auto-generated storage key (#71)", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), { maxAge: 10 });

    const event = makeEvent(path);
    // Populate the cache, then read it directly using the resolved key.
    await handler(event);

    const keys = await handler.resolveKeys(event);
    // The event's own (GET) key first, then the sibling HEAD variant of the same resource.
    expect(keys.length).toBe(2);
    const stored = await testStorage.get(keys[0]!);
    expect(stored).toBeTruthy();
    expect((stored as any).value.body).toBe("ok");
  });

  it(".invalidate(event) removes the cached entry (#71)", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`v${callCount}`);
      },
      { maxAge: 100 },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    expect(await r1.text()).toBe("v1");
    // Cache hit — handler not re-invoked.
    const r2 = (await handler(makeEvent(path))) as Response;
    expect(await r2.text()).toBe("v1");
    expect(callCount).toBe(1);

    await handler.invalidate(makeEvent(path));
    const [key] = await handler.resolveKeys(makeEvent(path));
    expect(await testStorage.get(key!)).toBeFalsy();

    // Next call re-resolves.
    const r3 = (await handler(makeEvent(path))) as Response;
    expect(await r3.text()).toBe("v2");
    expect(callCount).toBe(2);
  });

  it(".expire(event) triggers a background refresh under SWR (#71)", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`v${callCount}`);
      },
      { maxAge: 100, swr: true, staleMaxAge: 100 },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    expect(await r1.text()).toBe("v1");
    expect(callCount).toBe(1);

    await handler.expire(makeEvent(path));

    // Stale value is served while the background refresh runs.
    const r2 = (await handler(makeEvent(path))) as Response;
    expect(await r2.text()).toBe("v1");
    // Background revalidation eventually re-invokes the handler.
    await vi.waitFor(() => expect(callCount).toBe(2));
  });

  // --- issue #73 ---

  it("strips transport headers (content-encoding/length/transfer-encoding) from cached responses (issue #73)", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(
      () =>
        // The body is already decoded/buffered by `serialize`, so replaying the upstream
        // transport headers (a `content-encoding: gzip` against a decompressed body, or a
        // stale `content-length`) desyncs them from the stored body — clients get malformed
        // data. They must be stripped before the entry is built.
        new Response("decoded body", {
          headers: {
            "content-encoding": "gzip",
            "content-length": "9999",
            "transfer-encoding": "chunked",
            "content-type": "text/plain",
          },
        }),
      { maxAge: 10 },
    );

    const r1 = (await handler(makeEvent(path))) as Response; // miss
    const r2 = (await handler(makeEvent(path))) as Response; // hit

    for (const res of [r1, r2]) {
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.headers.get("transfer-encoding")).toBeNull();
      // A content-length, if the runtime re-adds one, must reflect the real body, not 9999.
      expect(res.headers.get("content-length")).not.toBe("9999");
      // Non-transport headers are preserved.
      expect(res.headers.get("content-type")).toBe("text/plain");
    }
    expect(await r2.text()).toBe("decoded body");
  });

  // --- immutable response headers ---

  // `serialize` used to synthesize/strip headers on the handler's live `Response`. Anything
  // built by `fetch()`, `Response.redirect()` or `Response.error()` carries the spec's
  // *immutable* header guard, so the very first write threw, the shared resolution rejected
  // and the entry was evicted — every request, no configuration avoiding it (the
  // `set-cookie`/`Vary`/transport deletes are unconditional, so even `sendCacheControl: false`
  // plus an upstream `etag` still threw). Every other 301 test here builds a mutable
  // `new Response(...)`, which is why this went unnoticed.
  describe("immutable response headers", () => {
    // Guard the premise: if a runtime ever stops enforcing it, these tests prove nothing.
    it("Response.redirect really is header-immutable", () => {
      expect(() => Response.redirect("http://localhost/elsewhere", 301).headers.set("x", "1")) //
        .toThrow();
    });

    it("caches a Response.redirect (301) instead of throwing", async () => {
      const path = uniquePath();
      let callCount = 0;
      const handler = defineCachedHandler(
        () => {
          callCount++;
          return Response.redirect("http://localhost/elsewhere", 301);
        },
        { maxAge: 10 },
      );

      const r1 = (await handler(makeEvent(path))) as Response;
      const r2 = (await handler(makeEvent(path))) as Response;

      expect(r1.status).toBe(301);
      expect(r1.headers.get("x-cache")).toBe("MISS");
      expect(r2.status).toBe(301);
      expect(r2.headers.get("x-cache")).toBe("HIT");
      expect(r2.headers.get("location")).toBe("http://localhost/elsewhere");
      // Synthesis still lands on the entry — it just happens on the copy.
      expect(r2.headers.get("cache-control")).toBe("max-age=10");
      expect(r2.headers.get("etag")).toBeTruthy();
      expect(callCount).toBe(1);
    });

    it("caches an immutable-headers response with cookies and transport headers stripped", async () => {
      const path = uniquePath();
      // The `fetch()` shape: a reverse-proxy handler returning an upstream response verbatim.
      // `Response.redirect` is the only immutable response constructible without a network,
      // so proxy the strip path through a hand-frozen `Headers` instead.
      const frozen = () => {
        const res = new Response("upstream body", {
          headers: {
            "set-cookie": "sid=s1",
            "content-encoding": "gzip",
            "content-type": "text/plain",
          },
        });
        for (const method of ["set", "append", "delete"] as const) {
          Object.defineProperty(res.headers, method, {
            value: () => {
              throw new TypeError("immutable");
            },
          });
        }
        return res;
      };
      const handler = defineCachedHandler(frozen, { maxAge: 10, varies: ["accept-language"] });

      const r1 = (await handler(makeEvent(path))) as Response;
      const r2 = (await handler(makeEvent(path))) as Response;

      for (const res of [r1, r2]) {
        expect(res.status).toBe(200);
        // The unconditional strips must still apply — they just apply to the copy.
        expect(res.headers.get("set-cookie")).toBeNull();
        expect(res.headers.get("content-encoding")).toBeNull();
        expect(res.headers.get("content-type")).toBe("text/plain");
        expect(res.headers.get("vary")).toBe("accept-language");
      }
      expect(await r2.text()).toBe("upstream body");
      expect(r2.headers.get("x-cache")).toBe("HIT");
    });

    it("does not mutate the handler's own Response headers", async () => {
      const path = uniquePath();
      const res = new Response("body");
      const handler = defineCachedHandler(() => res, { maxAge: 10 });

      await handler(makeEvent(path));

      // The copy absorbs the synthesis; the handler's object is left as it was handed over.
      expect(res.headers.get("etag")).toBeNull();
      expect(res.headers.get("cache-control")).toBeNull();
      expect(res.headers.get("last-modified")).toBeNull();
    });
  });

  // --- GET/HEAD cache key separation (h3#1524 audit, finding #3) ---

  // Every real framework integration nulls the body of a HEAD response in `toResponse`
  // (h3 does), and that body-less `Response` is exactly what ocache stores. ocache's own
  // default `toResponse` does not strip it, so the poisoning is only reproducible through
  // the integration hook — simulate a spec-compliant host here.
  function headStrippingToResponse(value: unknown, event: HTTPEvent): Response {
    const res = value instanceof Response ? value : new Response(String(value));
    return event.req.method === "HEAD"
      ? new Response(null, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        })
      : res;
  }

  it("does not let a HEAD request poison the GET entry with an empty body", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("hello world", { status: 200 });
      },
      { maxAge: 100, toResponse: headStrippingToResponse },
    );

    // Attacker-controlled HEAD lands first and stores a body-less entry.
    const head = (await handler(makeEvent(path, { method: "HEAD" }))) as Response;
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    // The GET must not be served that entry.
    const get = (await handler(makeEvent(path))) as Response;
    expect(await get.text()).toBe("hello world");
    expect(get.headers.get("x-cache")).toBe("MISS");
    expect(callCount).toBe(2);

    // ...and the GET entry it wrote is the one replayed to later GETs.
    const get2 = (await handler(makeEvent(path))) as Response;
    expect(await get2.text()).toBe("hello world");
    expect(get2.headers.get("x-cache")).toBe("HIT");
    expect(callCount).toBe(2);
  });

  it("serves HEAD from its own entry without disturbing the GET entry", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("hello world");
      },
      { maxAge: 100, toResponse: headStrippingToResponse },
    );

    const get = (await handler(makeEvent(path))) as Response;
    expect(await get.text()).toBe("hello world");
    expect(callCount).toBe(1);

    // HEAD does not reuse the GET entry: it costs its own origin dispatch.
    const head = (await handler(makeEvent(path, { method: "HEAD" }))) as Response;
    expect(head.headers.get("x-cache")).toBe("MISS");
    expect(await head.text()).toBe("");
    expect(callCount).toBe(2);

    // ...but it is cached under its own key.
    const head2 = (await handler(makeEvent(path, { method: "HEAD" }))) as Response;
    expect(head2.headers.get("x-cache")).toBe("HIT");
    expect(callCount).toBe(2);

    // ...and the GET entry is untouched.
    const get2 = (await handler(makeEvent(path))) as Response;
    expect(await get2.text()).toBe("hello world");
    expect(get2.headers.get("x-cache")).toBe("HIT");
    expect(callCount).toBe(2);
  });

  it("separates HEAD from GET under a custom getKey", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("hello world");
      },
      {
        maxAge: 100,
        // A custom key expresses *content* identity — the GET/HEAD split is still ocache's
        // to enforce, or a custom-key user is exposed to exactly the poisoning above.
        getKey: () => `custom-key${path}`,
        toResponse: headStrippingToResponse,
      },
    );

    const head = (await handler(makeEvent(path, { method: "HEAD" }))) as Response;
    expect(await head.text()).toBe("");

    const get = (await handler(makeEvent(path))) as Response;
    expect(await get.text()).toBe("hello world");
    expect(get.headers.get("x-cache")).toBe("MISS");
    expect(callCount).toBe(2);

    const keys = await handler.resolveKeys(makeEvent(path));
    expect(keys[1]).toBe(headVariantKey(keys[0]!));
  });

  it("composes the HEAD discriminator with varies and allowCookies key components", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("hello world");
      },
      {
        maxAge: 100,
        varies: ["accept-language"],
        allowCookies: ["sid"],
        toResponse: headStrippingToResponse,
      },
    );
    const event = (method: string, lang: string, sid: string) =>
      makeEvent(path, { method, headers: { "accept-language": lang, cookie: `sid=${sid}` } });

    await handler(event("GET", "en", "1"));
    expect(callCount).toBe(1);
    await handler(event("GET", "en", "1")); // hit
    expect(callCount).toBe(1);
    await handler(event("GET", "fr", "1")); // varies component still splits the key
    expect(callCount).toBe(2);
    await handler(event("GET", "en", "2")); // allowCookies component still splits the key
    expect(callCount).toBe(3);

    // The HEAD discriminator is orthogonal to both: one HEAD entry per variant.
    await handler(event("HEAD", "en", "1"));
    expect(callCount).toBe(4);
    await handler(event("HEAD", "en", "1")); // hit
    expect(callCount).toBe(4);
    await handler(event("HEAD", "fr", "1"));
    expect(callCount).toBe(5);

    // Key shape: the HEAD key is the GET key with the `HEAD:` discriminator, so the
    // vary/cookie components are preserved verbatim on both sides.
    const [getKey, getSibling] = await handler.resolveKeys(event("GET", "en", "1"));
    const [headKey, headSibling] = await handler.resolveKeys(event("HEAD", "en", "1"));
    expect(headKey).toBe(headVariantKey(getKey!));
    expect(getSibling).toBe(headKey);
    expect(headSibling).toBe(getKey);
    expect(getKey).toMatch(/:acceptlanguage\.[^:]+:cookie\.[^:]+\.json$/);
  });

  // Populates both the GET and the HEAD entry of one path and returns their storage keys.
  // The keys are derived from the key shape itself (`HEAD:` component) rather than read
  // back from `.resolveKeys`, so the assertions below check actual storage state.
  async function primeBothVariants(handler: ReturnType<typeof defineCachedHandler>, path: string) {
    await handler(makeEvent(path));
    await handler(makeEvent(path, { method: "HEAD" }));
    const getKey = (await handler.resolveKeys(makeEvent(path)))[0]!;
    const keys = [getKey, headVariantKey(getKey)];
    for (const key of keys) {
      expect(await testStorage.get(key)).toBeTruthy();
    }
    return keys;
  }

  it(".resolveKeys(event) enumerates every method variant, the event's own first", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), {
      maxAge: 100,
      toResponse: headStrippingToResponse,
    });

    const getKeys = await handler.resolveKeys(makeEvent(path));
    const headKeys = await handler.resolveKeys(makeEvent(path, { method: "HEAD" }));
    expect(getKeys).toHaveLength(2);
    expect(headKeys).toHaveLength(2);
    expect(headKeys[0]).toBe(getKeys[1]);
    expect(headKeys[1]).toBe(getKeys[0]);

    // keys[0] is still exactly the key that event reads/writes.
    await handler(makeEvent(path));
    expect(await testStorage.get(getKeys[0]!)).toBeTruthy();
    expect(await testStorage.get(getKeys[1]!)).toBeFalsy();
    await handler(makeEvent(path, { method: "HEAD" }));
    expect(await testStorage.get(headKeys[0]!)).toBeTruthy();
  });

  it(".invalidate(event) clears every method variant of the resource", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response(`v${callCount}`);
      },
      { maxAge: 100, toResponse: headStrippingToResponse },
    );

    // Invalidating from a GET event must not leave the HEAD entry behind — it would keep
    // advertising the dead etag/last-modified for downstream caches to revalidate against.
    const keys = await primeBothVariants(handler, path);
    await handler.invalidate(makeEvent(path));
    for (const key of keys) {
      expect(await testStorage.get(key)).toBeFalsy();
    }

    // ...and the same in the other direction, from a HEAD event.
    await primeBothVariants(handler, path);
    await handler.invalidate(makeEvent(path, { method: "HEAD" }));
    for (const key of keys) {
      expect(await testStorage.get(key)).toBeFalsy();
    }
  });

  it(".expire(event) marks every method variant of the resource stale", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), {
      maxAge: 100,
      swr: true,
      staleMaxAge: 100,
      toResponse: headStrippingToResponse,
    });

    const keys = await primeBothVariants(handler, path);
    await handler.expire(makeEvent(path));
    for (const key of keys) {
      expect(await testStorage.get(key)).toMatchObject({ stale: true });
    }

    // ...and from a HEAD event.
    await handler.invalidate(makeEvent(path));
    await primeBothVariants(handler, path);
    await handler.expire(makeEvent(path, { method: "HEAD" }));
    for (const key of keys) {
      expect(await testStorage.get(key)).toMatchObject({ stale: true });
    }
  });

  // --- Null-body statuses (204 / 205 / 304) ---

  // `serialize` stores a body-less response as `""`, which is not nullish, so replaying it
  // as `new Response("", { status: 204 })` used to throw — on the MISS too, since the miss
  // is served through the freshly serialized entry. Two guards: the read path forces the
  // body to `null` for these statuses, and `validate` refuses to store them at all.
  for (const status of [204, 205, 304]) {
    it(`serves a ${status} response without throwing and never stores it`, async () => {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        () => {
          callCount++;
          return new Response(null, { status });
        },
        { maxAge: 100 },
      );

      const r1 = (await handler(makeEvent(path))) as Response;
      expect(r1.status).toBe(status);
      expect(r1.body).toBeNull();

      const r2 = (await handler(makeEvent(path))) as Response;
      expect(r2.status).toBe(status);
      expect(r2.body).toBeNull();

      // Not a servable stored representation: nothing is kept, so every request re-resolves.
      const [key] = await handler.resolveKeys(makeEvent(path));
      expect(await testStorage.get(key!)).toBeFalsy();
      expect(callCount).toBe(2);
      expect(r2.headers.get("x-cache")).toBe("MISS");
    });
  }

  it("hides the conditional headers from a handler that does its own 304", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      (event) => {
        callCount++;
        // A handler doing its own conditional handling (h3 `serveStatic`, nitro public
        // assets, any route proxying the conditional headers upstream).
        return event.req.headers.get("if-modified-since")
          ? new Response(null, { status: 304 })
          : new Response("fresh body", { status: 200 });
      },
      { maxAge: 100 },
    );

    // The handler cannot branch on a validator it cannot see, so the crafted request
    // renders the ordinary representation. ocache owns the 304 decision alone, from the
    // validators it captured itself. Declaring `if-modified-since` in `varies` is the
    // escape hatch, at one entry per distinct validator.
    const attacker = (await handler(
      makeEvent(path, { headers: { "if-modified-since": "Fri, 31 Dec 2999 23:59:59 GMT" } }),
    )) as Response;
    expect(attacker.status).toBe(200);
    expect(await attacker.text()).toBe("fresh body");

    // The unconditional path serves the same stored representation.
    const victim = (await handler(makeEvent(path))) as Response;
    expect(victim.status).toBe(200);
    expect(await victim.text()).toBe("fresh body");
    expect(victim.headers.get("x-cache")).toBe("HIT");
    expect(callCount).toBe(1);
  });

  it("serves HEAD against a 204 route", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response(null, { status: 204 }), {
      maxAge: 100,
      // A spec-compliant host nulls a HEAD body — the same shape a 204 already has.
      toResponse: headStrippingToResponse,
    });

    const r1 = (await handler(makeEvent(path, { method: "HEAD" }))) as Response;
    expect(r1.status).toBe(204);
    expect(r1.body).toBeNull();

    const r2 = (await handler(makeEvent(path, { method: "HEAD" }))) as Response;
    expect(r2.status).toBe(204);
    expect(r2.body).toBeNull();
    expect(r2.headers.get("x-cache")).toBe("MISS");
  });

  // --- Range requests and 206 (finding 07) ---

  /** A range-honoring handler, i.e. what any static-file / media / `serveStatic` route is. */
  function rangeHandler(body: string) {
    return (event: HTTPEvent) => {
      const range = event.req.headers.get("range");
      if (!range) {
        return new Response(body, { status: 200 });
      }
      const [, start = "0", end = ""] = /bytes=(\d*)-(\d*)/.exec(range) || [];
      const from = Number(start);
      const to = end ? Number(end) : body.length - 1;
      const slice = body.slice(from, to + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          "content-range": `bytes ${from}-${to}/${body.length}`,
          "content-length": String(slice.length),
        },
      });
    };
  }

  it("does not populate the plain GET entry from a Range request", async () => {
    let callCount = 0;
    const path = uniquePath();
    const inner = rangeHandler("ABCDEFGHIJ");
    const handler = defineCachedHandler(
      (event) => {
        callCount++;
        return inner(event);
      },
      { maxAge: 100 },
    );

    const ranged = (await handler(
      makeEvent(path, { headers: { range: "bytes=0-0" } }),
    )) as Response;
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("A");

    // Bypassed, so nothing is stored under the plain key (nor under any key).
    const [key] = await handler.resolveKeys(makeEvent(path));
    expect(await testStorage.get(key!)).toBeFalsy();
    expect(callCount).toBe(1);

    // And bypassed responses pass through untouched: no serialization, no synthesized
    // cache headers, no cache-status header, so a second ranged request re-resolves.
    expect(ranged.headers.get("cache-control")).toBeNull();
    expect(ranged.headers.get("etag")).toBeNull();
    expect(ranged.headers.get("x-cache")).toBeNull();
    // Range framing survives untouched on the bypass path (nothing is stripped there).
    expect(ranged.headers.get("content-range")).toBe("bytes 0-0/10");
    await handler(makeEvent(path, { headers: { range: "bytes=0-0" } }));
    expect(callCount).toBe(2);
  });

  it("serves the full 200 body to a plain GET after a ranged one", async () => {
    let callCount = 0;
    const path = uniquePath();
    const inner = rangeHandler("ABCDEFGHIJ");
    const handler = defineCachedHandler(
      (event) => {
        callCount++;
        return inner(event);
      },
      { maxAge: 100 },
    );

    // Attacker truncates: one byte, with a Content-Range describing it.
    await handler(makeEvent(path, { headers: { range: "bytes=0-0" } }));

    // Victim, no Range: must get the complete representation, never the poisoned partial.
    const victim = (await handler(makeEvent(path))) as Response;
    expect(victim.status).toBe(200);
    expect(await victim.text()).toBe("ABCDEFGHIJ");
    expect(victim.headers.get("content-range")).toBeNull();
    expect(callCount).toBe(2);
  });

  it("never serves a stored entry with status 206", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("ABCDEFGHIJ");
      },
      { maxAge: 100 },
    );

    await handler(makeEvent(path));
    expect(callCount).toBe(1);
    const [key] = await handler.resolveKeys(makeEvent(path));

    // Simulate an entry written by another writer sharing the storage, or by an older
    // ocache that still admitted 206: same shape and integrity, partial payload.
    const entry = (await testStorage.get(key!)) as any;
    entry.value.status = 206;
    entry.value.body = "A";
    entry.value.headers["content-range"] = "bytes 0-0/10";
    await testStorage.set(key!, entry);

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ABCDEFGHIJ");
    expect(res.headers.get("content-range")).toBeNull();
    expect(callCount).toBe(2);
  });

  it("strips content-range from a stored entry", async () => {
    const path = uniquePath();
    // A proxying handler that copied upstream headers onto a complete 200 response.
    const handler = defineCachedHandler(
      () => new Response("full body", { headers: { "content-range": "bytes 0-8/9" } }),
      { maxAge: 100 },
    );

    const r1 = (await handler(makeEvent(path))) as Response;
    expect(r1.headers.get("content-range")).toBeNull();

    const [key] = await handler.resolveKeys(makeEvent(path));
    const entry = (await testStorage.get(key!)) as any;
    expect(entry.value.headers["content-range"]).toBeUndefined();
  });

  // --- Cacheable-status allowlist (findings 10.1 / 10.5) ---

  it("does not store a 302 nor advertise a synthesized cache-control for it", async () => {
    let callCount = 0;
    const path = uniquePath();
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return new Response("", { status: 302, headers: { location: "/elsewhere" } });
      },
      { maxAge: 60, swr: true, staleMaxAge: 600 },
    );

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/elsewhere");
    // A per-request answer, not a representation: never stored...
    const [key] = await handler.resolveKeys(makeEvent(path));
    expect(await testStorage.get(key!)).toBeFalsy();
    // ...and therefore never published as cacheable to clients/CDNs either.
    expect(res.headers.get("cache-control")).toBeNull();

    await handler(makeEvent(path));
    expect(callCount).toBe(2);
  });

  it("never serves an anonymous login redirect to a later request (10.5)", async () => {
    let callCount = 0;
    const path = `${uniquePath()}/dashboard`;
    // Auth middleware: anonymous visitors are bounced to /login, authenticated ones get their
    // dashboard. The auth signal is deliberately *not* in the request — every candidate
    // (cookie, bearer token, a proxy-injected header) is stripped by the request-side
    // allowlist, and none is in the key — so both callers land on the *same* anonymous cache
    // key, which is exactly why the 302 must never stick to it. Branching on the call instead
    // pins the storage decision itself: the second request must reach the handler.
    const handler = defineCachedHandler(
      () => {
        callCount++;
        return callCount > 1
          ? new Response("alice's dashboard")
          : new Response("", {
              status: 302,
              headers: { location: `/login?next=${path}` },
            });
      },
      { maxAge: 60, swr: true, staleMaxAge: 600 },
    );

    const anonymous = (await handler(makeEvent(path))) as Response;
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("cache-control")).toBeNull();

    // The authenticated user must reach the handler, not the stored redirect.
    const authenticated = (await handler(makeEvent(path))) as Response;
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get("location")).toBeNull();
    expect(callCount).toBe(2);
  });

  for (const status of [404, 500]) {
    it(`returns a ${status} to the caller but neither stores nor advertises it`, async () => {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        () => {
          callCount++;
          return new Response("boom", { status });
        },
        { maxAge: 60, swr: true, staleMaxAge: 600 },
      );

      const res = (await handler(makeEvent(path))) as Response;
      expect(res.status).toBe(status);
      expect(await res.text()).toBe("boom");
      // Not stored — so the origin takes every request. Advertising a lifetime for it
      // would pin the error at every shared cache for maxAge + staleMaxAge while ocache
      // itself offered no protection at all: inverted on both sides.
      const [key] = await handler.resolveKeys(makeEvent(path));
      expect(await testStorage.get(key!)).toBeFalsy();
      expect(res.headers.get("cache-control")).toBeNull();

      await handler(makeEvent(path));
      expect(callCount).toBe(2);
    });
  }

  for (const status of [200, 203, 301, 308]) {
    it(`stores and serves a ${status} response`, async () => {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        () => {
          callCount++;
          return new Response("body", { status, headers: { location: "/new" } });
        },
        { maxAge: 60 },
      );

      const r1 = (await handler(makeEvent(path))) as Response;
      expect(r1.status).toBe(status);
      expect(r1.headers.get("cache-control")).toBe("max-age=60");

      const r2 = (await handler(makeEvent(path))) as Response;
      expect(r2.status).toBe(status);
      expect(await r2.text()).toBe("body");
      expect(r2.headers.get("x-cache")).toBe("HIT");
      expect(callCount).toBe(1);
    });
  }

  for (const status of [201, 202, 300, 307]) {
    it(`never stores a ${status} response`, async () => {
      let callCount = 0;
      const path = uniquePath();
      const handler = defineCachedHandler(
        () => {
          callCount++;
          return new Response("body", { status, headers: { location: "/new" } });
        },
        { maxAge: 60 },
      );

      const res = (await handler(makeEvent(path))) as Response;
      expect(res.status).toBe(status);
      expect(res.headers.get("cache-control")).toBeNull();

      const [key] = await handler.resolveKeys(makeEvent(path));
      expect(await testStorage.get(key!)).toBeFalsy();

      await handler(makeEvent(path));
      expect(callCount).toBe(2);
    });
  }
});

describe("resolveCacheKeys", () => {
  it("uses default hash when no getKey is provided", async () => {
    const keys = await resolveCacheKeys({ options: { name: "myFn" }, args: ["my-arg"] });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^\/cache:functions:myFn:.+\.json$/);
  });

  it("uses custom getKey", async () => {
    const keys = await resolveCacheKeys({
      options: { name: "myFn", getKey: (id: string) => id },
      args: ["my-key"],
    });
    expect(keys).toEqual(["/cache:functions:myFn:my-key.json"]);
  });

  it("uses custom base, group, and name", async () => {
    const keys = await resolveCacheKeys({
      options: { base: "/my-cache", group: "app/handlers", name: "myFn", getKey: (k: string) => k },
      args: ["k"],
    });
    expect(keys).toEqual(["/my-cache:app/handlers:myFn:k.json"]);
  });

  it("matches the key used internally by defineCachedFunction", async () => {
    const setSpy = vi.fn();
    useTestStorage({ get: () => null, set: setSpy });

    const opts = {
      maxAge: 10,
      getKey: () => "test-key",
      name: "myFn",
      group: "myGroup",
      base: "/cache" as const,
    };

    const fn = defineCachedFunction(() => "value", opts);
    await fn();

    const expectedKeys = await resolveCacheKeys({ options: opts });
    expect(setSpy).toHaveBeenCalledWith(expectedKeys[0], expect.any(Object), { ttl: 10 });
  });

  it("matches .resolveKeys on the cached function", async () => {
    const fn = defineCachedFunction(async (id: string) => id, {
      name: "myFn",
      getKey: (id: string) => id,
    });
    const keys = await fn.resolveKeys("test-id");
    expect(keys).toEqual(["/cache:functions:myFn:test-id.json"]);
  });

  it("returns default key with no args and no getKey", async () => {
    const keys = await resolveCacheKeys({});
    expect(keys).toEqual(["/cache:functions:_:.json"]);
  });

  it("returns all keys when base is an array", async () => {
    const keys = await resolveCacheKeys({
      options: { base: ["/tier1", "/tier2"], name: "myFn", getKey: (k: string) => k },
      args: ["k"],
    });
    expect(keys).toEqual(["/tier1:functions:myFn:k.json", "/tier2:functions:myFn:k.json"]);
  });
});

describe("invalidateCache", () => {
  it("removes cached entry so next call re-invokes the function", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        return `v${callCount}`;
      },
      { maxAge: 60, name: "myFn", getKey: () => "k", swr: false },
    );

    expect(await fn()).toBe("v1");
    expect(callCount).toBe(1);

    await fn.invalidate();

    expect(await fn()).toBe("v2");
    expect(callCount).toBe(2);
  });

  it("invalidates with specific args", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      (id: string) => {
        callCount++;
        return `${id}-v${callCount}`;
      },
      { maxAge: 60, name: "byId", getKey: (id: string) => id, swr: false },
    );

    expect(await fn("a")).toBe("a-v1");
    expect(await fn("b")).toBe("b-v2");

    // Invalidate only "a"
    await fn.invalidate("a");

    expect(await fn("a")).toBe("a-v3"); // re-invoked
    expect(await fn("b")).toBe("b-v2"); // still cached
    expect(callCount).toBe(3);
  });

  it("invalidates across all base prefixes (multi-tier)", async () => {
    const fn = defineCachedFunction(() => "value", {
      maxAge: 60,
      base: ["/tier1", "/tier2"],
      name: "myFn",
      getKey: () => "k",
    });

    await fn();

    const storage = testStorage;
    expect(await storage.get("/tier1:functions:myFn:k.json")).not.toBeNull();
    expect(await storage.get("/tier2:functions:myFn:k.json")).not.toBeNull();

    await fn.invalidate();

    expect(await storage.get("/tier1:functions:myFn:k.json")).toBeNull();
    expect(await storage.get("/tier2:functions:myFn:k.json")).toBeNull();
  });

  it("standalone invalidateCache works with same options", async () => {
    let callCount = 0;
    const opts = { maxAge: 60, name: "myFn", getKey: () => "k", swr: false } as const;
    const fn = defineCachedFunction(() => {
      callCount++;
      return `v${callCount}`;
    }, opts);

    expect(await fn()).toBe("v1");

    await invalidateCache({ options: opts });

    expect(await fn()).toBe("v2");
    expect(callCount).toBe(2);
  });

  it("invalidating non-existent key is a no-op", async () => {
    // Should not throw (a missing *entry* is fine; only a missing `storage` is an error)
    await invalidateCache({
      options: { name: "nonexistent", getKey: () => "nope", storage: testStorage },
    });
  });
});

// A purge must win over work that started before it. Without a fence, a slow resolver
// finished after `.invalidate()` and wrote its pre-purge value back to the same key.
describe("purge fences in-flight resolutions", () => {
  const tick = () => new Promise((r) => setTimeout(r, 10));

  /** A resolver that stays in flight until its release is called. */
  function blocking<T>() {
    const releases: Array<(value: T) => void> = [];
    return {
      releases,
      calls: () => releases.length,
      resolver: () => new Promise<T>((resolve) => releases.push(resolve)),
    };
  }

  it("invalidate() stops an in-flight resolution from rewriting the key", async () => {
    const { releases, calls, resolver } = blocking<string>();
    const fn = defineCachedFunction(resolver, {
      maxAge: 60,
      name: "fenced",
      getKey: () => "k",
      swr: false,
    });

    const first = fn();
    await tick();
    expect(calls()).toBe(1);

    await fn.invalidate();
    releases[0]!("v1");
    // The caller still receives the value it resolved.
    expect(await first).toBe("v1");
    await tick();

    expect(await testStorage.get("/cache:functions:fenced:k.json")).toBeFalsy();

    const second = fn();
    await tick();
    expect(calls()).toBe(2);
    releases[1]!("v2");
    expect(await second).toBe("v2");
  });

  it("a call after invalidate() resolves again instead of following the purged work", async () => {
    const { releases, calls, resolver } = blocking<string>();
    const fn = defineCachedFunction(resolver, {
      maxAge: 60,
      name: "fenced",
      getKey: () => "k",
      swr: false,
    });

    const first = fn();
    await tick();
    await fn.invalidate();

    const second = fn();
    await tick();
    expect(calls()).toBe(2);

    releases[0]!("v1");
    releases[1]!("v2");
    expect(await first).toBe("v1");
    expect(await second).toBe("v2");
  });

  it("expire() stops an in-flight resolution from storing a fresh entry", async () => {
    const { releases, calls, resolver } = blocking<string>();
    const fn = defineCachedFunction(resolver, {
      maxAge: 60,
      name: "fenced",
      getKey: () => "k",
      swr: false,
    });

    const first = fn();
    await tick();

    await fn.expire();
    releases[0]!("v1");
    expect(await first).toBe("v1");
    await tick();

    expect(await testStorage.get("/cache:functions:fenced:k.json")).toBeFalsy();
    fn();
    await tick();
    expect(calls()).toBe(2);
  });

  // A backend whose value writes land slower than its deletes. `.set(key, null)` is the
  // purge tombstone, so only real values are delayed.
  function slowWrites(delay: number): StorageInterface {
    const inner = createMemoryStorage();
    return {
      get: (key) => inner.get(key),
      set: async (key, value, opts) => {
        if (value !== null) {
          await new Promise((r) => setTimeout(r, delay));
        }
        return inner.set(key, value, opts);
      },
    };
  }

  it("invalidate() waits for a write that already reached storage", async () => {
    const storage = slowWrites(50);
    useTestStorage(storage);
    const { releases, resolver } = blocking<string>();
    const fn = defineCachedFunction(resolver, {
      maxAge: 60,
      name: "slowWrite",
      getKey: () => "k",
      swr: false,
    });

    const first = fn();
    await tick();
    releases[0]!("v1");
    // The write is in flight by the time the caller is served, so the fence cannot stop it.
    expect(await first).toBe("v1");

    await fn.invalidate();
    await new Promise((r) => setTimeout(r, 100));

    expect(await storage.get("/cache:functions:slowWrite:k.json")).toBeFalsy();
  });

  it("expire() waits for a write that already reached storage", async () => {
    const storage = slowWrites(50);
    useTestStorage(storage);
    const { releases, resolver } = blocking<string>();
    const fn = defineCachedFunction(resolver, {
      maxAge: 60,
      name: "slowWrite",
      getKey: () => "k",
      swr: false,
    });

    const first = fn();
    await tick();
    releases[0]!("v1");
    expect(await first).toBe("v1");

    await fn.expire();
    await new Promise((r) => setTimeout(r, 100));

    const entry = (await storage.get("/cache:functions:slowWrite:k.json")) as any;
    expect(entry?.stale).toBe(true);
  });

  it("a handler's .invalidate(event) waits for a write that already reached storage", async () => {
    const storage = slowWrites(50);
    useTestStorage(storage);
    const { releases, resolver } = blocking<Response>();
    const handler = defineCachedHandler(resolver, { maxAge: 60, name: "slowWriteHandler" });
    const event = () => ({ req: new Request("http://localhost/slow") });

    const first = handler(event());
    await tick();
    releases[0]!(new Response("v1"));
    expect(await ((await first) as Response).text()).toBe("v1");

    await handler.invalidate(event());
    await new Promise((r) => setTimeout(r, 100));

    for (const key of await handler.resolveKeys(event())) {
      expect(await storage.get(key)).toBeFalsy();
    }
  });

  it("a handler's .invalidate(event) fences its in-flight resolution", async () => {
    const { releases, calls, resolver } = blocking<Response>();
    const handler = defineCachedHandler(resolver, { maxAge: 60, name: "fencedHandler" });
    const event = () => ({ req: new Request("http://localhost/fenced") });

    const first = handler(event());
    await tick();
    expect(calls()).toBe(1);

    await handler.invalidate(event());
    releases[0]!(new Response("v1"));
    expect(await ((await first) as Response).text()).toBe("v1");
    await tick();

    for (const key of await handler.resolveKeys(event())) {
      expect(await testStorage.get(key)).toBeFalsy();
    }

    const second = handler(event());
    await tick();
    expect(calls()).toBe(2);
    releases[1]!(new Response("v2"));
    expect(await ((await second) as Response).text()).toBe("v2");
  });
});

describe("expireCache", () => {
  it("SWR serves stale value and refetches in background after expire", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 10));
        return `v${callCount}`;
      },
      { maxAge: 60, swr: true, staleMaxAge: 60, name: "myFn", getKey: () => "k" },
    );

    expect(await fn()).toBe("v1");
    expect(callCount).toBe(1);

    // Entry is well within maxAge — expire it immediately
    await fn.expire();

    // Stale value is still served while the refetch runs in the background
    expect(await fn()).toBe("v1");
    await new Promise((r) => setTimeout(r, 20));
    expect(callCount).toBe(2);

    // Background refresh completed — fresh value is now cached
    expect(await fn()).toBe("v2");
    expect(callCount).toBe(2);
  });

  it("clears the stale flag after revalidation", async () => {
    const fn = defineCachedFunction(() => "value", {
      maxAge: 60,
      name: "myFn",
      getKey: () => "k",
    });

    await fn();
    await fn.expire();
    await fn(); // triggers revalidation (sync resolver updates the entry)

    const keys = await fn.resolveKeys();
    const entry = (await testStorage.get(keys[0]!)) as any;
    expect(entry.stale).toBeUndefined();
  });

  it("swr=false re-resolves before returning after expire", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      () => {
        callCount++;
        return `v${callCount}`;
      },
      { maxAge: 60, swr: false, name: "myFn", getKey: () => "k" },
    );

    expect(await fn()).toBe("v1");
    await fn.expire();
    expect(await fn()).toBe("v2");
    expect(callCount).toBe(2);
  });

  it("does not extend the original staleMaxAge window", async () => {
    let callCount = 0;
    const fn = defineCachedFunction(
      async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 5));
        return `v${callCount}`;
      },
      { maxAge: 0.01, swr: true, staleMaxAge: 0.02, name: "myFn", getKey: () => "k" },
    );

    expect(await fn()).toBe("v1");
    await fn.expire();

    // Wait beyond maxAge + staleMaxAge — entry is fully expired, stale must NOT be served
    await new Promise((r) => setTimeout(r, 50));
    expect(await fn()).toBe("v2");
    expect(callCount).toBe(2);
  });

  it("preserves remaining storage TTL when expiring", async () => {
    const opts = { maxAge: 60, swr: true, staleMaxAge: 120, name: "myFn", getKey: () => "k" };
    const fn = defineCachedFunction(() => "value", opts);
    await fn();

    const storage = testStorage;
    const setSpy = vi.spyOn(storage, "set");

    await fn.expire();
    expect(setSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ stale: true, value: "value" }),
      { ttl: 180 },
    );
  });

  it("expiring an SWR entry with no staleMaxAge leaves it TTL-less, as the write did", async () => {
    const opts = { maxAge: 60, swr: true, name: "myFn", getKey: () => "k" };
    const fn = defineCachedFunction(() => "value", opts);
    await fn();

    const setSpy = vi.spyOn(testStorage, "set");
    await fn.expire();

    // `expireCache` rewrites the entry, so it derives its TTL from the same `storageTtl` the
    // write path uses. Inventing a `{ ttl: 60 }` here would delete the entry at `maxAge` —
    // the opposite of what `.expire()` means for the ISR shape (serve it stale once more,
    // refresh in the background).
    expect(setSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ stale: true, value: "value" }),
      undefined,
    );
  });

  it("expires across all base prefixes (multi-tier)", async () => {
    const fn = defineCachedFunction(() => "value", {
      maxAge: 60,
      base: ["/tier1", "/tier2"],
      name: "myFn",
      getKey: () => "k",
    });

    await fn();
    await fn.expire();

    const storage = testStorage;
    const tier1 = (await storage.get("/tier1:functions:myFn:k.json")) as any;
    const tier2 = (await storage.get("/tier2:functions:myFn:k.json")) as any;
    expect(tier1.stale).toBe(true);
    expect(tier1.value).toBe("value");
    expect(tier2.stale).toBe(true);
  });

  it("standalone expireCache works with same options", async () => {
    let callCount = 0;
    const opts = { maxAge: 60, name: "myFn", getKey: () => "k", swr: false } as const;
    const fn = defineCachedFunction(() => {
      callCount++;
      return `v${callCount}`;
    }, opts);

    expect(await fn()).toBe("v1");

    await expireCache({ options: opts });

    expect(await fn()).toBe("v2");
    expect(callCount).toBe(2);
  });

  it("expiring non-existent key is a no-op", async () => {
    // Should not throw and should not create an entry (a missing *entry* is fine; only a
    // missing `storage` is an error)
    await expireCache({
      options: { name: "nonexistent", getKey: () => "nope", storage: testStorage },
    });
    expect(await testStorage.get("/cache:functions:nonexistent:nope.json")).toBeNull();
  });
});

describe("multi-tier base", () => {
  it("reads from second tier when first is empty", async () => {
    const sharedIntegrity = "shared-integrity";

    // Populate tier2 by writing with base="/tier2" only
    const fn1 = defineCachedFunction(() => "from-tier2", {
      maxAge: 10,
      base: "/tier2",
      name: "myFn",
      getKey: () => "k",
      integrity: sharedIntegrity,
    });
    await fn1();

    // Read with multi-tier base — tier1 is empty, should find in tier2
    let callCount = 0;
    const fn2 = defineCachedFunction(
      () => {
        callCount++;
        return "fresh";
      },
      {
        maxAge: 10,
        base: ["/tier1", "/tier2"],
        name: "myFn",
        getKey: () => "k",
        integrity: sharedIntegrity,
      },
    );

    const result = await fn2();
    expect(result).toBe("from-tier2");
    expect(callCount).toBe(0);
  });

  it("writes to all tiers on full miss", async () => {
    const setSpy = vi.fn();
    useTestStorage({ get: () => null, set: setSpy });

    const fn = defineCachedFunction(() => "value", {
      maxAge: 10,
      base: ["/tier1", "/tier2"],
      name: "myFn",
      getKey: () => "k",
    });

    await fn();
    const setKeys = setSpy.mock.calls.map((c: any) => c[0]);
    expect(setKeys).toContain("/tier1:functions:myFn:k.json");
    expect(setKeys).toContain("/tier2:functions:myFn:k.json");
  });

  it("skips writing to lower tiers when a higher tier hits", async () => {
    const sharedIntegrity = "shared-integrity";
    const storage = testStorage;

    // Populate both tiers
    const entry = {
      value: "cached",
      mtime: Date.now(),
      integrity: sharedIntegrity,
      expires: Date.now() + 10_000,
    };
    await storage.set("/tier1:functions:myFn:k.json", entry);
    await storage.set("/tier2:functions:myFn:k.json", entry);

    const setSpy = vi.spyOn(storage, "set");

    const fn = defineCachedFunction(() => "fresh", {
      maxAge: 10,
      base: ["/tier1", "/tier2"],
      name: "myFn",
      getKey: () => "k",
      integrity: sharedIntegrity,
    });

    const result = await fn();
    expect(result).toBe("cached");
    // No writes should occur — tier1 already had the entry
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("only writes to tiers up to the hit on revalidation", async () => {
    const setSpy = vi.fn();
    const tier2Entry = {
      value: "stale",
      mtime: Date.now() - 20_000,
      integrity: "int",
    };

    // Custom storage: tier1 misses, tier2 hits, tier3 is never checked
    useTestStorage({
      get: (key: string): any => {
        if (key === "/tier2:functions:myFn:k.json") return tier2Entry;
        return null;
      },
      set: setSpy,
    });

    const fn = defineCachedFunction(() => "fresh", {
      maxAge: 10,
      base: ["/tier1", "/tier2", "/tier3"],
      name: "myFn",
      getKey: () => "k",
      integrity: "int",
    });

    await fn();

    const setKeys = setSpy.mock.calls.map((c: any) => c[0]);
    // Should write to tier1 (promote) and tier2 (refresh), but NOT tier3
    expect(setKeys).toContain("/tier1:functions:myFn:k.json");
    expect(setKeys).toContain("/tier2:functions:myFn:k.json");
    expect(setKeys).not.toContain("/tier3:functions:myFn:k.json");
  });

  it("prefers first tier when both have data", async () => {
    const sharedIntegrity = "shared-integrity";

    // Populate both tiers
    const fn1 = defineCachedFunction(() => "from-tier1", {
      maxAge: 10,
      base: "/tier1",
      name: "myFn",
      getKey: () => "k",
      integrity: sharedIntegrity,
    });
    await fn1();

    // Copy tier1 entry to tier2 with different value
    const storage = testStorage;
    const tier1Entry = (await storage.get("/tier1:functions:myFn:k.json")) as any;
    await storage.set("/tier2:functions:myFn:k.json", { ...tier1Entry, value: "from-tier2" });

    // Read with multi-tier — should prefer tier1
    let callCount = 0;
    const fn2 = defineCachedFunction(
      () => {
        callCount++;
        return "fresh";
      },
      {
        maxAge: 10,
        base: ["/tier1", "/tier2"],
        name: "myFn",
        getKey: () => "k",
        integrity: sharedIntegrity,
      },
    );

    const result = await fn2();
    expect(result).toBe("from-tier1");
    expect(callCount).toBe(0);
  });
});

// The in-flight dedup registry used to be a plain object, so a caller-controlled key that
// happened to name an `Object.prototype` member read truthy with nothing in flight: the call
// was treated as a deduplicated follower, `await`ed the inherited member (not a thenable, so
// it resolved to itself), skipped the resolver entirely and cached `undefined`. Reachable
// through the *documented* `getKey: (id) => id`. Fixed by making the registry a `Map`.
describe("getKey returning Object.prototype member names", () => {
  const protoNames = [
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ];

  it.each(protoNames)("cachedFunction resolves and caches key %s", async (id) => {
    let calls = 0;
    const fn = defineCachedFunction(
      (key: string) => {
        calls++;
        return { id: key, name: `user-${key}` };
      },
      { maxAge: 10, name: "protoFn", getKey: (key: string) => key },
    );

    // Miss: the resolver must actually run.
    expect(await fn(id)).toEqual({ id, name: `user-${id}` });
    expect(calls).toBe(1);

    // Hit: served from storage, resolver not called again.
    expect(await fn(id)).toEqual({ id, name: `user-${id}` });
    expect(calls).toBe(1);
  });

  it("cachedFunction deduplicates concurrent calls for a prototype-named key", async () => {
    let calls = 0;
    const fn = defineCachedFunction(
      async (key: string) => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return `value-${key}`;
      },
      { maxAge: 10, name: "protoConcurrentFn", getKey: (key: string) => key },
    );

    const results = await Promise.all([fn("__proto__"), fn("__proto__"), fn("__proto__")]);
    expect(results).toEqual(["value-__proto__", "value-__proto__", "value-__proto__"]);
    expect(calls).toBe(1);
  });

  it.each(protoNames)("defineCachedHandler serves bare-word key %s", async (word) => {
    let calls = 0;
    const handler = defineCachedHandler(
      () => {
        calls++;
        return new Response(`page for /${word}`, { status: 200 });
      },
      { maxAge: 10, name: "protoHandler", getKey: () => word },
    );

    const event = { req: new Request(`http://localhost/${word}`) };

    const r1 = (await handler(event)) as Response;
    expect(r1.status).toBe(200);
    expect(await r1.text()).toBe(`page for /${word}`);
    expect(r1.headers.get("x-cache")).toBe("MISS");
    expect(calls).toBe(1);

    const r2 = (await handler(event)) as Response;
    expect(r2.status).toBe(200);
    expect(await r2.text()).toBe(`page for /${word}`);
    expect(r2.headers.get("x-cache")).toBe("HIT");
    expect(calls).toBe(1);
  });
});

// Request narrowing swaps `event.req` for a plain `new Request(...)` and used to copy only
// `runtime`, dropping `waitUntil`. Every background cache write, SWR refresh and eviction in
// `cache.ts` reads `event.req.waitUntil` *after* that swap, so on the very runtimes that
// provide it (Cloudflare Workers, srvx) none of them were ever handed to the runtime: the
// isolate can be torn down before the write lands, making every request a MISS forever.
// The copy must be *bound* to the original request — a bare copy loses the receiver.
describe("waitUntil survives request narrowing", () => {
  // The original request carries a cookie, which narrowing always strips (no `allowCookies`),
  // so a receiver-dependent `waitUntil` can tell the original request from the narrowed one.
  function makeWaitUntilEvent(path: string) {
    const promises: Promise<unknown>[] = [];
    const receivers: unknown[] = [];
    const seenCookies: (string | null)[] = [];
    const req = new Request(`http://localhost${path}`, { headers: { cookie: "sid=s1" } });
    (req as any).waitUntil = function (this: Request, promise: Promise<unknown>) {
      receivers.push(this);
      seenCookies.push(this.headers.get("cookie"));
      promises.push(promise);
    };
    return { event: { req } as HTTPEvent, req, promises, receivers, seenCookies };
  }

  it("registers exactly one waitUntil call for the cache write on a MISS", async () => {
    let calls = 0;
    const handler = defineCachedHandler(
      () => {
        calls++;
        return new Response("ok");
      },
      { maxAge: 10, name: "wuMiss" },
    );

    const { event, promises } = makeWaitUntilEvent("/wu-miss");
    const r1 = (await handler(event)) as Response;
    expect(r1.headers.get("x-cache")).toBe("MISS");
    expect(calls).toBe(1);
    // The cache write — and nothing else — was handed to the runtime.
    expect(promises).toHaveLength(1);

    await Promise.all(promises);
    const r2 = (await handler({ req: new Request("http://localhost/wu-miss") })) as Response;
    expect(r2.headers.get("x-cache")).toBe("HIT");
    expect(calls).toBe(1);
  });

  it("registers the SWR background refresh on a stale read", async () => {
    let calls = 0;
    const handler = defineCachedHandler(
      () => {
        calls++;
        return new Response(`v${calls}`);
      },
      { maxAge: 0.01, swr: true, staleMaxAge: 10, name: "wuSwr" },
    );

    const first = makeWaitUntilEvent("/wu-swr");
    await handler(first.event);
    await Promise.all(first.promises);
    expect(calls).toBe(1);

    await new Promise((r) => setTimeout(r, 20));

    const second = makeWaitUntilEvent("/wu-swr");
    const stale = (await handler(second.event)) as Response;
    expect(stale.headers.get("x-cache")).toBe("STALE");
    expect(await stale.text()).toBe("v1");
    // The background revalidation was handed to the runtime instead of being left to run
    // untracked (where the isolate would be free to die before it finishes).
    expect(second.promises.length).toBeGreaterThanOrEqual(1);

    await Promise.all(second.promises);
    // The refresh's own cache write is registered too; drain it as the runtime would.
    await Promise.all(second.promises);
    expect(calls).toBe(2);
  });

  it("hands waitUntil to the resolver bound to the original request", async () => {
    let seenInHandler: unknown;
    const handler = defineCachedHandler(
      (event: HTTPEvent) => {
        seenInHandler = event.req.waitUntil;
        return new Response("ok");
      },
      { maxAge: 10, name: "wuBound" },
    );

    const { event, req, promises, receivers, seenCookies } = makeWaitUntilEvent("/wu-bound");
    await handler(event);

    // The resolver ran against the narrowed request (cookie stripped) and still saw waitUntil.
    expect(event.req).not.toBe(req);
    expect(typeof seenInHandler).toBe("function");
    expect(event.req.headers.get("cookie")).toBe(null);

    // Bound: every call ran with the ORIGINAL request as `this`, so a receiver-dependent
    // implementation still sees the real request. A bare copy would pass the narrowed one.
    expect(receivers.length).toBeGreaterThan(0);
    expect(receivers.every((r) => r === req)).toBe(true);
    expect(seenCookies.every((c) => c === "sid=s1")).toBe(true);

    // Still reachable and callable after the handler returned.
    const later = Promise.resolve("later");
    event.req.waitUntil!(later);
    expect(promises.at(-1)).toBe(later);
    expect(receivers.at(-1)).toBe(req);
  });
});

// `serialize`, `getMaxAge` and the resolver all run inside the shared in-flight promise, so a
// resolution that never settles used to pin its `pending` slot for the lifetime of the
// process: every later call for that key joined a resolution that would never finish, so one
// hung upstream took the key down for every client until a restart (finding 03). The deadline
// makes the shared promise always settle — the waiters reject, and the slot is freed by the
// same cleanup path a resolver error already goes through.
describe("maxResolveTime", () => {
  /** A resolver that never settles, plus a handle on how many times it was entered. */
  function hangingResolver() {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      fn: () => {
        calls++;
        return new Promise<string>(() => {});
      },
    };
  }

  it("rejects a resolution that never settles", async () => {
    const hang = hangingResolver();
    const fn = defineCachedFunction(hang.fn, {
      maxAge: 10,
      name: "hangReject",
      maxResolveTime: 0.02,
    });

    await expect(fn()).rejects.toThrow(/timed out after 0.02s/);
    expect(hang.calls).toBe(1);
  });

  it("names the failure TimeoutError", async () => {
    const hang = hangingResolver();
    const fn = defineCachedFunction(hang.fn, {
      maxAge: 10,
      name: "hangNamed",
      maxResolveTime: 0.02,
    });

    await expect(fn()).rejects.toMatchObject({ name: "TimeoutError" });
  });

  // The finding's own regression test: a second request for a wedged key must not block
  // indefinitely. Both callers are in flight *before* the deadline, so the second one is a
  // deduplicated follower of the resolution that never settles.
  it("does not block a second request for a wedged key", async () => {
    const hang = hangingResolver();
    const fn = defineCachedFunction(hang.fn, {
      maxAge: 10,
      name: "hangSecond",
      maxResolveTime: 0.02,
    });

    const first = fn();
    const second = fn();
    const settled = await Promise.allSettled([first, second]);

    expect(settled.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    // One resolution, shared: the follower joined it rather than starting its own.
    expect(hang.calls).toBe(1);
  });

  // ...and the key is usable again afterwards: the freed slot means the next call elects a
  // fresh leader instead of joining the abandoned resolution.
  it("recovers: a later call with a healthy resolver caches normally", async () => {
    let hang = true;
    let calls = 0;
    const fn = defineCachedFunction(
      () => {
        calls++;
        return hang ? new Promise<string>(() => {}) : Promise.resolve("healthy");
      },
      { maxAge: 10, name: "hangRecover", maxResolveTime: 0.02 },
    );

    await expect(fn()).rejects.toThrow(/timed out/);

    hang = false;
    expect(await fn()).toBe("healthy");
    expect(calls).toBe(2);
    // Cached, not just resolved.
    expect(await fn()).toBe("healthy");
    expect(calls).toBe(2);
  });

  // Also the unit guard: the deadline is **seconds**, so `1` is a full second and a resolver
  // that takes 10ms is nowhere near it. Read as milliseconds it would fire at ~1ms — before
  // the resolver settles — and this test would fail. (The tests where a timeout *does* fire
  // can't catch that misreading: a deadline that is too short still fires.)
  it("does not fire for a resolver that settles in time", async () => {
    let calls = 0;
    const fn = defineCachedFunction(
      async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return "value";
      },
      { maxAge: 10, name: "inTime", maxResolveTime: 1 },
    );

    expect(await fn()).toBe("value");
    expect(await fn()).toBe("value");
    expect(calls).toBe(1);
  });

  // The hooks run inside the same shared promise, so the deadline has to cover them too —
  // `serialize` is where a never-ending body would be drained.
  it("covers a serialize hook that never settles", async () => {
    const fn = defineCachedFunction(() => "value", {
      maxAge: 10,
      name: "hangSerialize",
      maxResolveTime: 0.02,
      serialize: () => new Promise(() => {}),
    });

    await expect(fn()).rejects.toThrow(/timed out/);
  });

  it.each([0, Number.POSITIVE_INFINITY, -1])("%s disables the deadline", async (timeout) => {
    let settle: ((value: string) => void) | undefined;
    const fn = defineCachedFunction(() => new Promise<string>((r) => (settle = r)), {
      maxAge: 10,
      name: `noDeadline${timeout}`,
      maxResolveTime: timeout,
    });

    const call = fn();
    let done = false;
    void call.then(() => (done = true));

    // Well past a deadline that would have fired had one been armed.
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);

    settle!("late");
    expect(await call).toBe("late");
  });

  // A timed-out resolution is a failed one in every respect, the eviction included: a hung
  // background refresh must not leave a dead entry behind for SWR to keep serving.
  it("evicts the entry a timed-out background refresh was refreshing", async () => {
    let hang = false;
    const fn = defineCachedFunction(
      () => (hang ? new Promise<string>(() => {}) : Promise.resolve("v1")),
      {
        maxAge: 0.01,
        swr: true,
        staleMaxAge: 60,
        name: "hangSwr",
        maxResolveTime: 0.02,
        onError: () => {},
      },
    );

    expect(await fn()).toBe("v1");
    await new Promise((r) => setTimeout(r, 20));

    // Expired: served stale while the background refresh runs — and hangs.
    hang = true;
    expect(await fn()).toBe("v1");
    await vi.waitFor(async () => {
      const keys = await fn.resolveKeys();
      expect(await testStorage.get(keys[0]!)).toBeNull();
    });
  });

  // Every armed deadline must be cleared when the resolution settles, or a long-lived process
  // accumulates one live timer per resolution.
  it("leaves no timer behind across many resolutions", async () => {
    // A delay no other timer in the process would pick, so the armed set is exactly ours —
    // and, since the option is in seconds while `setTimeout` is in milliseconds, the literal
    // pins that conversion too (`987.5` is exactly representable, so no float dust).
    const timeoutSeconds = 987.5;
    const timeout = 987_500;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const armed: unknown[] = [];
    const cleared = new Set<unknown>();
    const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      cb: any,
      ms?: any,
      ...rest: any[]
    ) => {
      const handle = realSetTimeout(cb, ms, ...rest);
      if (ms === timeout) {
        armed.push(handle);
      }
      return handle;
    }) as any);
    const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle: any) => {
      cleared.add(handle);
      realClearTimeout(handle);
    }) as any);

    try {
      const fn = defineCachedFunction((i: number) => `v${i}`, {
        maxAge: 10,
        name: "noTimerLeak",
        getKey: (i: number) => String(i),
        maxResolveTime: timeoutSeconds,
      });

      for (let i = 0; i < 25; i++) {
        expect(await fn(i)).toBe(`v${i}`);
      }
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }

    expect(armed.length).toBe(25);
    expect(armed.every((handle) => cleared.has(handle))).toBe(true);
  });
});
