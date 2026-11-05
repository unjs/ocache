import { tracingChannel } from "node:diagnostics_channel";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  GET_CHANNEL,
  createMemoryStorage,
  defineCachedFunction,
  defineCachedHandler,
  type CacheTraceContext,
  type HTTPEvent,
  type ResponseCacheEntry,
  type StorageInterface,
} from "../src/index.ts";

type TraceEvent = { type: string; context: CacheTraceContext };

const channel = tracingChannel<object, CacheTraceContext>(GET_CHANNEL);

let events: TraceEvent[];
let storage: StorageInterface;

const handlers = {
  start: (context: CacheTraceContext) => events.push({ type: "start", context }),
  end: (context: CacheTraceContext) => events.push({ type: "end", context }),
  asyncStart: (context: CacheTraceContext) => events.push({ type: "asyncStart", context }),
  asyncEnd: (context: CacheTraceContext) => events.push({ type: "asyncEnd", context }),
  error: (context: CacheTraceContext) => events.push({ type: "error", context }),
};

beforeEach(() => {
  events = [];
  storage = createMemoryStorage();
  channel.subscribe(handlers as any);
});

afterEach(() => {
  channel.unsubscribe(handlers as any);
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
      tracing: true,
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
    expect(miss!.result).toEqual({ id: "1" });
    expect(hit).toMatchObject({ name: "getUser", key: miss!.key, status: "hit" });
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
        tracing: true,
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
      tracing: true,
    });

    await cached();
    force = true;
    await cached();

    expect(settled().map((c) => c.status)).toEqual(["miss", "revalidated"]);
  });

  it("traces a bypassed call without a key", async () => {
    const cached = defineCachedFunction(async () => "value", {
      storage,
      shouldBypassCache: () => true,
      tracing: true,
    });

    await cached();

    const [bypass] = settled();
    expect(bypass!.status).toBe("bypass");
    expect(bypass!.key).toBeUndefined();
  });

  it("publishes the error and the status of a failed resolution", async () => {
    const error = new Error("boom");
    const cached = defineCachedFunction(
      async () => {
        throw error;
      },
      { name: "failing", storage, tracing: true },
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
      tracing: true,
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

  it("publishes nothing without the `tracing` option", async () => {
    const cached = defineCachedFunction(async () => "value", { storage });

    await cached();

    expect(events).toEqual([]);
  });

  it("does not change integrity, so enabling it keeps existing entries", async () => {
    let calls = 0;
    const fn = async () => ++calls;

    await defineCachedFunction(fn, { name: "same", storage, maxAge: 60 })();
    const traced = defineCachedFunction(fn, { name: "same", storage, maxAge: 60, tracing: true });

    expect(await traced()).toBe(1);
    expect(settled()[0]!.status).toBe("hit");
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
});

describe("ocache.get without subscribers", () => {
  beforeEach(() => {
    channel.unsubscribe(handlers as any);
  });

  it("runs the call untraced", async () => {
    const cached = defineCachedFunction(async () => "value", { storage, tracing: true });

    expect(await cached()).toBe("value");
    expect(events).toEqual([]);
  });
});
