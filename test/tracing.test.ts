import { tracingChannel } from "node:diagnostics_channel";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  GET_CHANNEL,
  RESOLVE_CHANNEL,
  createMemoryStorage,
  defineCachedFunction,
  defineCachedHandler,
  type CacheResolveTraceContext,
  type CacheTraceContext,
  type HTTPEvent,
  type ResponseCacheEntry,
  type StorageInterface,
} from "../src/index.ts";

type TraceEvent = { type: string; context: CacheTraceContext };

const channel = tracingChannel<CacheTraceContext>(GET_CHANNEL);
const resolveChannel = tracingChannel<CacheResolveTraceContext>(RESOLVE_CHANNEL);

let events: TraceEvent[];
let resolves: CacheResolveTraceContext[];
let storage: StorageInterface;

const handlers = {
  start: (context: CacheTraceContext) => events.push({ type: "start", context }),
  end: (context: CacheTraceContext) => events.push({ type: "end", context }),
  asyncStart: (context: CacheTraceContext) => events.push({ type: "asyncStart", context }),
  asyncEnd: (context: CacheTraceContext) => events.push({ type: "asyncEnd", context }),
  error: (context: CacheTraceContext) => events.push({ type: "error", context }),
};

const resolveHandlers = {
  start: (context: CacheResolveTraceContext) => resolves.push(context),
};

beforeEach(() => {
  events = [];
  resolves = [];
  storage = createMemoryStorage();
  channel.subscribe(handlers as any);
  resolveChannel.subscribe(resolveHandlers as any);
});

afterEach(() => {
  channel.unsubscribe(handlers as any);
  resolveChannel.unsubscribe(resolveHandlers as any);
});

/**
 * Returns the context each call published on `asyncEnd`.
 */
function settled(): CacheTraceContext[] {
  return events.filter((e) => e.type === "asyncEnd").map((e) => e.context);
}

function createEvent(url: string): HTTPEvent {
  return { req: new Request(url) } as HTTPEvent;
}

describe("ocache.get", () => {
  it("traces a miss, then a hit", async () => {
    const getUser = defineCachedFunction(async (id: string) => ({ id }), {
      name: "getUser",
      storage,
      maxAge: 60,
    });

    await getUser("1");
    await getUser("1");

    const [miss, hit] = settled();
    expect(miss).toMatchObject({
      type: "function",
      name: "getUser",
      group: "functions",
      status: "miss",
    });
    expect(miss!.key).toBeTypeOf("string");
    expect(miss!.keys).toEqual([`/cache:functions:getUser:${miss!.key}.json`]);
    expect(miss!.maxAge).toBe(60);
    expect(miss!.mtime).toBeTypeOf("number");
    expect(miss!.result).toEqual({ id: "1" });
    expect(hit).toMatchObject({ name: "getUser", key: miss!.key, status: "hit", maxAge: 60 });
    // Both events describe the value served, so they agree on its write time.
    expect(hit!.mtime).toBe(miss!.mtime);
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "end",
      "asyncStart",
      "asyncEnd",
      "start",
      "end",
      "asyncStart",
      "asyncEnd",
    ]);
  });

  it("traces a stale serve", async () => {
    let now = 1_000_000;
    const dateNow = Date.now;
    Date.now = () => now;
    try {
      const cached = defineCachedFunction(async () => "value", {
        storage,
        maxAge: 1,
        swr: true,
      });

      await cached();
      now += 2000;
      await cached();

      expect(settled().map((c) => c.status)).toEqual(["miss", "stale"]);
    } finally {
      Date.now = dateNow;
    }
  });

  it("traces a forced revalidation", async () => {
    let force = false;
    const cached = defineCachedFunction(async () => "value", {
      storage,
      maxAge: 60,
      shouldInvalidateCache: () => force,
    });

    await cached();
    force = true;
    await cached();

    expect(settled().map((c) => c.status)).toEqual(["miss", "revalidated"]);
  });

  it("reports one storage key per base", async () => {
    const cached = defineCachedFunction(async () => "value", {
      name: "tiered",
      storage,
      base: ["/l1", "/l2"],
      getKey: () => "k",
    });

    await cached();

    expect(settled()[0]!.keys).toEqual([
      "/l1:functions:tiered:k.json",
      "/l2:functions:tiered:k.json",
    ]);
  });

  it("reports the `getMaxAge` lifetime after a miss and the stored one on a hit", async () => {
    const cached = defineCachedFunction(async () => "value", {
      storage,
      maxAge: 60,
      getMaxAge: () => 300,
    });

    await cached();
    await cached();

    expect(settled().map((c) => c.maxAge)).toEqual([300, 300]);
  });

  it("reports the age of a stale entry", async () => {
    let now = 1_000_000;
    const dateNow = Date.now;
    Date.now = () => now;
    try {
      const cached = defineCachedFunction(async () => "value", {
        storage,
        maxAge: 1,
        swr: true,
      });

      await cached();
      now += 5000;
      await cached();

      const stale = settled()[1]!;
      expect(stale.status).toBe("stale");
      expect(stale.maxAge).toBe(1);
      expect(now - stale.mtime!).toBe(5000);
    } finally {
      Date.now = dateNow;
    }
  });

  it("reports the new value on a revalidation, not the replaced entry", async () => {
    let now = 1_000_000;
    const dateNow = Date.now;
    Date.now = () => now;
    try {
      let lifetime = 60;
      let force = false;
      const cached = defineCachedFunction(async () => "value", {
        storage,
        maxAge: 60,
        getMaxAge: () => lifetime,
        shouldInvalidateCache: () => force,
      });

      await cached();
      now += 1000;
      lifetime = 120;
      force = true;
      await cached();

      const revalidated = settled()[1]!;
      expect(revalidated.status).toBe("revalidated");
      expect(revalidated.maxAge).toBe(120);
      expect(revalidated.mtime).toBe(now);
    } finally {
      Date.now = dateNow;
    }
  });

  it("does not trace a bypassed call", async () => {
    let calls = 0;
    const cached = defineCachedFunction(async () => "value", {
      storage,
      shouldBypassCache: () => {
        calls++;
        return true;
      },
    });

    expect(await cached()).toBe("value");
    expect(events).toEqual([]);
    expect(resolves).toEqual([]);
    expect(calls).toBe(1);
  });

  it("runs the bypass hook once for a traced call", async () => {
    let calls = 0;
    const cached = defineCachedFunction(async () => "value", {
      storage,
      shouldBypassCache: () => {
        calls++;
        return false;
      },
    });

    await cached();

    expect(calls).toBe(1);
    expect(settled()).toHaveLength(1);
  });

  it("publishes the error and the status of a failed resolution", async () => {
    const error = new Error("boom");
    const cached = defineCachedFunction(
      async () => {
        throw error;
      },
      { name: "failing", storage },
    );

    await expect(cached()).rejects.toBe(error);

    const failed = events.find((e) => e.type === "error")!.context;
    expect(failed).toMatchObject({ name: "failing", status: "miss", error });
  });

  it("traces a cached handler with its event", async () => {
    const handler = defineCachedHandler(() => new Response("ok"), {
      name: "page",
      storage,
      maxAge: 60,
    });

    const event = createEvent("http://localhost/page");
    await handler(event);
    await handler(createEvent("http://localhost/page"));

    const [miss, hit] = settled();
    expect(miss).toMatchObject({
      type: "handler",
      name: "page",
      group: "handlers",
      status: "miss",
    });
    expect(miss!.event).toBe(event);
    expect(miss!.result).toMatchObject({ status: 200, body: "ok" });
    expect(hit!.status).toBe("hit");
  });

  it("traces by default", async () => {
    const cached = defineCachedFunction(async () => "value", { storage });

    await cached();

    expect(settled()).toHaveLength(1);
    expect(resolves).toHaveLength(1);
  });

  it("publishes nothing with `tracing: false`", async () => {
    const cached = defineCachedFunction(async () => "value", { storage, tracing: false });
    const handler = defineCachedHandler(() => new Response("ok"), { storage, tracing: false });

    await cached();
    await handler(createEvent("http://localhost/"));

    expect(events).toEqual([]);
    expect(resolves).toEqual([]);
  });

  it("does not change integrity, so toggling it keeps existing entries", async () => {
    let calls = 0;
    const fn = async () => ++calls;

    await defineCachedFunction(fn, { name: "same", storage, maxAge: 60, tracing: false })();
    const traced = defineCachedFunction(fn, { name: "same", storage, maxAge: 60 });

    expect(await traced()).toBe(1);
    expect(settled()[0]!.status).toBe("hit");
  });
});

describe("ocache.resolve", () => {
  it("publishes once per run of the function", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const cached = defineCachedFunction(
      async () => {
        await gate;
        return "value";
      },
      { name: "shared", storage, maxAge: 60, getKey: () => "k" },
    );

    const calls = [cached(), cached(), cached()];
    release();
    await Promise.all(calls);

    expect(settled().map((c) => c.status)).toEqual(["miss", "miss", "miss"]);
    expect(resolves).toHaveLength(1);
    expect(resolves[0]).toMatchObject({
      type: "function",
      name: "shared",
      group: "functions",
      key: "k",
      status: "miss",
    });
    expect(resolves[0]!.result).toMatchObject({ value: "value", maxAge: undefined });
    // Every waiter reports the write time of the one run it was served from.
    expect(settled().map((c) => c.mtime)).toEqual(Array(3).fill(resolves[0]!.result!.mtime));
  });

  it("starts inside the call that ran it", async () => {
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const store = new AsyncLocalStorage<string>();
    const start = tracingChannel<CacheTraceContext, string>(GET_CHANNEL).start;
    start.bindStore(store, (context) => `get:${context.key ?? "?"}`);
    let parent: string | undefined;
    const onStart = () => (parent = store.getStore());
    resolveChannel.subscribe({ start: onStart } as any);
    try {
      await defineCachedFunction(async () => "value", { storage })();
      expect(parent).toBe("get:?");
    } finally {
      start.unbindStore(store);
      resolveChannel.unsubscribe({ start: onStart } as any);
    }
  });

  it("traces a background refresh after the stale call ends", async () => {
    let now = 1_000_000;
    const dateNow = Date.now;
    Date.now = () => now;
    try {
      let release!: () => void;
      let gate: Promise<void> = Promise.resolve();
      const cached = defineCachedFunction(
        async () => {
          await gate;
          return "value";
        },
        { storage, maxAge: 1, swr: true },
      );

      await cached();
      now += 2000;
      gate = new Promise<void>((resolve) => (release = resolve));
      const settledResolve = new Promise<CacheResolveTraceContext>((resolve) => {
        const asyncEnd = (context: CacheResolveTraceContext) => {
          resolveChannel.unsubscribe({ asyncEnd } as any);
          resolve(context);
        };
        resolveChannel.subscribe({ asyncEnd } as any);
      });

      expect(await cached()).toBe("value");
      expect(settled().map((c) => c.status)).toEqual(["miss", "stale"]);
      expect(resolves.map((c) => c.status)).toEqual(["miss", "stale"]);

      release();
      const refresh = await settledResolve;
      expect(refresh.status).toBe("stale");
      expect(refresh.result!.value).toBe("value");
    } finally {
      Date.now = dateNow;
    }
  });

  it("publishes the error of a failed resolution", async () => {
    const error = new Error("boom");
    const errors: CacheResolveTraceContext[] = [];
    const onError = (context: CacheResolveTraceContext) => errors.push(context);
    resolveChannel.subscribe({ error: onError } as any);
    try {
      const cached = defineCachedFunction(
        async () => {
          throw error;
        },
        { storage },
      );

      await expect(cached()).rejects.toBe(error);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ status: "miss", error });
    } finally {
      resolveChannel.unsubscribe({ error: onError } as any);
    }
  });

  it("publishes the stored response entry for a handler", async () => {
    const handler = defineCachedHandler(() => new Response("ok"), { storage, maxAge: 60 });
    const event = createEvent("http://localhost/page");

    await handler(event);

    expect(resolves).toHaveLength(1);
    expect(resolves[0]!.type).toBe("handler");
    expect(resolves[0]!.event).toBe(event);
    expect(resolves[0]!.result!.value).toMatchObject({ status: 200, body: "ok" });
  });

  it("traces without an `ocache.get` subscriber", async () => {
    channel.unsubscribe(handlers as any);
    const cached = defineCachedFunction(async () => "value", { storage });

    await cached();

    expect(events).toEqual([]);
    expect(resolves).toHaveLength(1);
  });
});

describe("CacheTraceContext", () => {
  it("narrows `result` and `event` on `type`", () => {
    const context = {} as CacheTraceContext;
    if (context.type === "handler") {
      expectTypeOf(context.result).toEqualTypeOf<ResponseCacheEntry | undefined>();
      expectTypeOf(context.event).toEqualTypeOf<HTTPEvent>();
    } else {
      expectTypeOf(context.result).toEqualTypeOf<unknown>();
    }
  });

  it("narrows the `ocache.resolve` `result` on `type`", () => {
    const context = {} as CacheResolveTraceContext;
    if (context.type === "handler") {
      expectTypeOf(context.result?.value).toEqualTypeOf<ResponseCacheEntry | undefined>();
    }
  });
});

describe("without subscribers", () => {
  beforeEach(() => {
    channel.unsubscribe(handlers as any);
    resolveChannel.unsubscribe(resolveHandlers as any);
  });

  it("runs the call untraced", async () => {
    const cached = defineCachedFunction(async () => "value", { storage });

    expect(await cached()).toBe("value");
    expect(events).toEqual([]);
    expect(resolves).toEqual([]);
  });
});
