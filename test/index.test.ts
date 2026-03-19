import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  cachedFunction,
  defineCachedFunction,
  defineCachedHandler,
  resolveCacheKeys,
  invalidateCache,
  createMemoryStorage,
  setStorage,
  useStorage,
  type HTTPEvent,
} from "../src/index.ts";
beforeEach(() => {
  setStorage(createMemoryStorage());
});

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

  it("handles cache read errors gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setStorage({
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
    setStorage({
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
    setStorage({
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
    setStorage({
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

  it("handles malformed cache data", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setStorage({
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

  it("no maxAge caches indefinitely", async () => {
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
    // SWR returns the cached entry value (which was already updated synchronously
    // since the resolver is sync)
    expect(r2).toBe("v2");
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
    setStorage({
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
    setStorage({
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

  it("does not set storage TTL when SWR without staleMaxAge", async () => {
    const setSpy = vi.fn();
    setStorage({
      get: () => null,
      set: setSpy,
    });

    const fn = defineCachedFunction(() => "value", {
      maxAge: 60,
      swr: true,
    });
    await fn();
    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(Object), undefined);
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

describe("storage", () => {
  it("createMemoryStorage handles TTL expiry", async () => {
    const storage = createMemoryStorage();
    storage.set("unique-ttl-key", { value: "test" }, { ttl: 0.01 });
    expect(storage.get("unique-ttl-key")).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(storage.get("unique-ttl-key")).toBeNull();
  });

  it("useStorage returns singleton", () => {
    const s1 = useStorage();
    const s2 = useStorage();
    expect(s1).toBe(s2);
  });

  it("setStorage overrides storage", () => {
    const custom = createMemoryStorage();
    setStorage(custom);
    expect(useStorage()).toBe(custom);
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

  it("allows HEAD requests to use cache", async () => {
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
    await handler(makeEvent(path, { method: "HEAD" }));
    expect(callCount).toBe(1);
  });

  it("sets cache-control header with SWR and staleMaxAge", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), {
      maxAge: 60,
      swr: true,
      staleMaxAge: 120,
    });

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("cache-control")).toContain("s-maxage=60");
    expect(res.headers.get("cache-control")).toContain("stale-while-revalidate=120");
  });

  it("sets cache-control with SWR without staleMaxAge", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), { maxAge: 60, swr: true });

    const res = (await handler(makeEvent(path))) as Response;
    const cc = res.headers.get("cache-control")!;
    expect(cc).toContain("s-maxage=60");
    expect(cc).toContain("stale-while-revalidate");
  });

  it("sets max-age when swr is false", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), { maxAge: 60, swr: false });

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("cache-control")).toBe("max-age=60");
  });

  it("auto-generates etag and last-modified", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("test-body"), { maxAge: 10 });

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("etag")).toMatch(/^W\/".*"$/);
    expect(res.headers.get("last-modified")).toBeTruthy();
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

  it("headersOnly returns 304 with matching etag", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("body"), {
      maxAge: 60,
      headersOnly: true,
    });

    const res = (await handler(
      makeEvent(path, {
        headers: { "if-none-match": "some-etag" },
      }),
    )) as Response;
    expect(res).toBeTruthy();
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

  it("filters variable headers from handler request", async () => {
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
    expect(receivedHeaders).toBeNull();
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

  it("sets s-maxage=0 when swr with maxAge: 0", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), {
      maxAge: 0,
      swr: true,
    });

    const res = (await handler(makeEvent(path))) as Response;
    const cc = res.headers.get("cache-control")!;
    expect(cc).toContain("s-maxage=0");
    expect(cc).toContain("stale-while-revalidate");
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

  it("no cache-control when no maxAge and no swr", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), { maxAge: 0, swr: false });

    const res = (await handler(makeEvent(path))) as Response;
    expect(res.headers.get("cache-control")).toBeNull();
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
      (body: string | null, init: ResponseInit) => new Response(body, init),
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
      (body: string | null, init: ResponseInit) => new Response(body, init),
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
    expect(createResponse).toHaveBeenCalledWith(null, { status: 304 });
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
    expect(cc).toContain("s-maxage=60");
    expect(cc).toContain("stale-while-revalidate");
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

  // Regression: issue #4 — passing partial opts (e.g. only maxAge) should inherit swr default
  it("inherits swr default when only maxAge is provided", async () => {
    const path = uniquePath();
    const handler = defineCachedHandler(() => new Response("ok"), { maxAge: 30 });

    const res = (await handler(makeEvent(path))) as Response;
    const cc = res.headers.get("cache-control")!;
    // swr should default to true, so we get s-maxage (not max-age)
    expect(cc).toContain("s-maxage=30");
    expect(cc).toContain("stale-while-revalidate");
    expect(cc).not.toContain("max-age=30");
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
    setStorage({ get: () => null, set: setSpy });

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
    expect(setSpy).toHaveBeenCalledWith(expectedKeys[0], expect.any(Object), undefined);
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

    const storage = useStorage();
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
    // Should not throw
    await invalidateCache({
      options: { name: "nonexistent", getKey: () => "nope" },
    });
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

  it("writes to all tiers", async () => {
    const setSpy = vi.fn();
    setStorage({ get: () => null, set: setSpy });

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
    const storage = useStorage();
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
