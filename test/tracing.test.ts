import { tracingChannel } from "node:diagnostics_channel";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineCachedFunction,
  defineCachedHandler,
  FUNCTION_CHANNEL,
  HANDLER_CHANNEL,
  type CachedEventHandlerOptions,
  type CacheStatus,
  type FunctionTraceContext,
  type HandlerTraceContext,
  type HTTPEvent,
} from "../src/index.ts";

// Channels are process-wide, so every subscription is removed after its test.
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  vi.restoreAllMocks();
});

type Payload<T> = T & { error?: unknown; result?: unknown };

/** Collects the payload of every call published on `name`, in the order the calls settle. */
function subscribe<T extends { name: string; status: CacheStatus | undefined }>(name: string) {
  const started: Payload<T>[] = [];
  const settled: Payload<T>[] = [];
  const subscribers = {
    start: (ctx: T) => void started.push(ctx),
    asyncEnd: (ctx: T) => void settled.push(ctx),
  };
  const channel = tracingChannel<T>(name);
  channel.subscribe(subscribers);
  cleanups.push(() => channel.unsubscribe(subscribers));
  return {
    started,
    settled,
    /** `[name, status]` per settled call. */
    statuses: () => settled.map((ctx) => [ctx.name, ctx.status]),
  };
}

const subscribeHandlers = () => subscribe<HandlerTraceContext>(HANDLER_CHANNEL);
const subscribeFunctions = () => subscribe<FunctionTraceContext>(FUNCTION_CHANNEL);

function makeEvent(path = "/", init?: RequestInit): HTTPEvent {
  return { req: new Request(`http://localhost${path}`, init) };
}

// Background work (SWR refreshes, streamed fills, writes) reaches the test through `waitUntil`.
function backgroundTasks() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (promise: Promise<unknown>) => void promises.push(promise),
    async settle() {
      while (promises.length > 0) {
        await Promise.allSettled(promises.splice(0));
      }
    },
  };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** A traced handler named `inner`, warmed for `/` so the next call is a hit. */
async function warmInner() {
  const inner = defineCachedHandler(() => new Response("inner", { headers: { etag: '"v1"' } }), {
    name: "inner",
    maxAge: 60,
    tracing: true,
  });
  await inner(makeEvent());
  return inner;
}

describe("ocache.handler", () => {
  it("publishes every call with how it was served", async () => {
    const traced = subscribeHandlers();
    const handler = defineCachedHandler(() => new Response("ok"), {
      name: "page",
      maxAge: 60,
      tracing: true,
    });

    const event = makeEvent();
    const miss = (await handler(event)) as Response;
    await handler(makeEvent());
    await handler.expire(makeEvent());
    await handler(makeEvent());

    expect(traced.started).toEqual(traced.settled);
    expect(traced.settled[0]).toMatchObject({
      event,
      name: "page",
      group: "handlers",
      status: "miss",
      result: miss,
    });
    expect(traced.statuses()).toEqual([
      ["page", "miss"],
      ["page", "hit"],
      ["page", "revalidated"],
    ]);
  });

  it("reports a stale hit", async () => {
    const traced = subscribeHandlers();
    const handler = defineCachedHandler(() => new Response("ok"), {
      name: "page",
      maxAge: 60,
      swr: true,
      staleMaxAge: 600,
      tracing: true,
    });

    await handler(makeEvent());
    await handler.expire(makeEvent());
    const res = (await handler(makeEvent())) as Response;

    expect(res.headers.get("x-cache")).toBe("STALE");
    expect(traced.statuses()).toEqual([
      ["page", "miss"],
      ["page", "stale"],
    ]);
  });

  it("reports the status with the cache-status header disabled", async () => {
    const traced = subscribeHandlers();
    const handler = defineCachedHandler(() => new Response("ok"), {
      name: "page",
      maxAge: 60,
      cacheStatusHeader: false,
      tracing: true,
    });

    const res = (await handler(makeEvent())) as Response;
    await handler(makeEvent());

    expect(res.headers.has("x-cache")).toBe(false);
    expect(traced.statuses()).toEqual([
      ["page", "miss"],
      ["page", "hit"],
    ]);
  });

  it("reports the entry's status on a 304", async () => {
    const handler = defineCachedHandler(() => new Response("ok"), {
      name: "page",
      maxAge: 60,
      tracing: true,
    });
    const etag = ((await handler(makeEvent())) as Response).headers.get("etag")!;
    const traced = subscribeHandlers();

    const res = (await handler(makeEvent("/", { headers: { "if-none-match": etag } }))) as Response;

    expect(res.status).toBe(304);
    expect(traced.statuses()).toEqual([["page", "hit"]]);
  });

  it("gives each coalesced caller a payload of its own", async () => {
    const traced = subscribeHandlers();
    const { open, opened } = gate();
    let calls = 0;
    const handler = defineCachedHandler(
      async () => {
        calls++;
        await opened;
        return new Response("ok");
      },
      { name: "page", maxAge: 60, tracing: true },
    );

    const leader = handler(makeEvent());
    const follower = handler(makeEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    open();
    await Promise.all([leader, follower]);

    expect(calls).toBe(1);
    expect(traced.settled).toHaveLength(2);
    expect(traced.settled[0]).not.toBe(traced.settled[1]);
    expect(traced.statuses()).toEqual([
      ["page", "miss"],
      ["page", "miss"],
    ]);
  });

  it("reports nested handlers on payloads of their own", async () => {
    const traced = subscribeHandlers();
    const inner = defineCachedHandler(() => new Response("inner"), {
      name: "inner",
      maxAge: 60,
      tracing: true,
    });
    const outer = defineCachedHandler((event) => inner(event), {
      name: "outer",
      maxAge: 60,
      tracing: true,
    });

    await outer(makeEvent());
    await outer.expire(makeEvent());
    await outer(makeEvent());

    expect(traced.statuses()).toEqual([
      ["inner", "miss"],
      ["outer", "miss"],
      ["inner", "hit"],
      ["outer", "revalidated"],
    ]);
  });

  it("keeps a stale payload stale while its refresh reaches a nested handler", async () => {
    const tasks = backgroundTasks();
    const inner = defineCachedHandler(() => new Response("inner"), {
      name: "inner",
      maxAge: 60,
      tracing: true,
    });
    const outer = defineCachedHandler((event) => inner(event), {
      name: "outer",
      maxAge: 60,
      swr: true,
      staleMaxAge: 600,
      tracing: true,
      waitUntil: tasks.waitUntil,
    });
    await outer(makeEvent());
    await tasks.settle();
    await outer.expire(makeEvent());
    const traced = subscribeHandlers();

    const event = makeEvent();
    await outer(event);
    const stale = traced.settled.find((ctx) => ctx.name === "outer")!;
    expect(stale.status).toBe("stale");
    await tasks.settle();

    // The refresh runs the outer handler's resolver, not the outer cached handler, so the
    // only new payload is the inner call it makes with the caller's event.
    expect(stale.status).toBe("stale");
    expect(traced.settled).toHaveLength(2);
    const refresh = traced.settled.find((ctx) => ctx.name === "inner")!;
    expect(refresh).not.toBe(stale);
    expect(refresh).toMatchObject({ event, status: "hit" });
  });

  // The refresh's error reaches `onError`, never the stale call it ran behind, and the entry
  // it kept is served stale again.
  it("reports stale again after a failed refresh keeps the entry", async () => {
    const tasks = backgroundTasks();
    const errors: unknown[] = [];
    let calls = 0;
    const handler = defineCachedHandler(
      () => {
        if (calls++ > 0) {
          throw new Error("upstream down");
        }
        return new Response("ok");
      },
      {
        name: "page",
        maxAge: 60,
        swr: true,
        staleMaxAge: 600,
        tracing: true,
        waitUntil: tasks.waitUntil,
        onError: (error) => errors.push(error),
      },
    );
    await handler(makeEvent());
    await handler.expire(makeEvent());
    const traced = subscribeHandlers();

    for (let i = 0; i < 2; i++) {
      expect(await ((await handler(makeEvent())) as Response).text()).toBe("ok");
      await tasks.settle();
    }

    expect(calls).toBe(3);
    expect(errors).toEqual([
      expect.objectContaining({ message: "upstream down" }),
      expect.objectContaining({ message: "upstream down" }),
    ]);
    expect(traced.settled.map((ctx) => ctx.error)).toEqual([undefined, undefined]);
    expect(traced.statuses()).toEqual([
      ["page", "stale"],
      ["page", "stale"],
    ]);
  });

  it("reports a resolution abandoned by `maxResolveTime` apart from its late nested call", async () => {
    const traced = subscribeHandlers();
    const { open, opened } = gate();
    const innerDone = gate();
    const inner = defineCachedHandler(() => new Response("inner"), {
      name: "inner",
      maxAge: 60,
      tracing: true,
    });
    const outer = defineCachedHandler(
      async (event) => {
        await opened;
        try {
          return await inner(event);
        } finally {
          innerDone.open();
        }
      },
      { name: "outer", maxAge: 60, maxResolveTime: 0.02, tracing: true },
    );

    await expect(outer(makeEvent())).rejects.toMatchObject({ name: "TimeoutError" });
    const [abandoned] = traced.settled;
    expect(abandoned).toMatchObject({ name: "outer", status: undefined });
    expect(abandoned!.error).toMatchObject({ name: "TimeoutError" });

    open();
    await innerDone.opened;

    expect(abandoned!.status).toBeUndefined();
    expect(traced.statuses()).toEqual([
      ["outer", undefined],
      ["inner", "miss"],
    ]);
  });

  it("reports no status for a response the default `createResponse` refuses", async () => {
    const traced = subscribeHandlers();
    // Status 0 is never stored, and `new Response("", { status: 0 })` throws.
    const handler = defineCachedHandler(() => Response.error(), {
      name: "page",
      maxAge: 60,
      tracing: true,
    });

    await expect(handler(makeEvent())).rejects.toMatchObject({ name: "RangeError" });

    expect(traced.statuses()).toEqual([["page", undefined]]);
    expect(traced.settled[0]!.error).toMatchObject({ name: "RangeError" });
  });

  it("reports no status when `handleCacheHeaders` throws on a hit", async () => {
    let fail = false;
    const handler = defineCachedHandler(() => new Response("ok"), {
      name: "page",
      maxAge: 60,
      tracing: true,
      handleCacheHeaders: () => {
        if (fail) {
          throw new Error("refused");
        }
        return false;
      },
    });
    await handler(makeEvent());
    const traced = subscribeHandlers();
    fail = true;

    await expect(handler(makeEvent())).rejects.toThrow("refused");

    expect(traced.statuses()).toEqual([["page", undefined]]);
  });

  it.each<[string, CachedEventHandlerOptions]>([
    ["a cached", { maxAge: 60 }],
    ["a bypassed", { maxAge: 60, shouldBypassCache: () => true }],
    ["a headers-only", { headersOnly: true }],
  ])("reports no status for %s handler that throws after a nested hit", async (_, opts) => {
    const inner = await warmInner();
    const traced = subscribeHandlers();
    const outer = defineCachedHandler(
      async (event) => {
        await inner(event);
        throw new Error("render failed");
      },
      { ...opts, name: "outer", tracing: true },
    );

    await expect(outer(makeEvent())).rejects.toThrow("render failed");

    expect(traced.statuses()).toEqual([
      ["inner", "hit"],
      ["outer", undefined],
    ]);
    expect(traced.settled[1]!.error).toMatchObject({ message: "render failed" });
  });

  it("reports no status in headers-only mode, 304 or not, even over a nested hit", async () => {
    const inner = await warmInner();
    const traced = subscribeHandlers();
    const outer = defineCachedHandler((event) => inner(event), {
      name: "outer",
      headersOnly: true,
      tracing: true,
    });

    await outer(makeEvent());
    const res = (await outer(makeEvent("/", { headers: { "if-none-match": '"v1"' } }))) as Response;

    expect(res.status).toBe(304);
    expect(traced.statuses()).toEqual([
      ["inner", "hit"],
      ["outer", undefined],
      ["inner", "hit"],
      ["outer", undefined],
    ]);
  });

  it("reports no status for a bypassed request, whatever header the handler sets", async () => {
    const traced = subscribeHandlers();
    const handler = defineCachedHandler(
      () => new Response("upstream", { headers: { "x-cache": "HIT" } }),
      { name: "page", maxAge: 60, shouldBypassCache: () => true, tracing: true },
    );

    const res = (await handler(makeEvent())) as Response;
    await handler(makeEvent("/", { method: "POST" }));

    expect(res.headers.get("x-cache")).toBe("HIT");
    expect(traced.statuses()).toEqual([
      ["page", undefined],
      ["page", undefined],
    ]);
  });

  it("reports no status for the over-limit fallback, even over a nested hit", async () => {
    const inner = defineCachedHandler(() => new Response("x".repeat(8192)), {
      name: "inner",
      maxAge: 60,
      tracing: true,
    });
    await inner(makeEvent());
    const traced = subscribeHandlers();
    const outer = defineCachedHandler((event) => inner(event), {
      name: "outer",
      maxAge: 60,
      maxBodySize: 4096,
      tracing: true,
      onError: () => {},
    });

    const res = (await outer(makeEvent())) as Response;

    // The nested hit's own header passes through untouched: only the payload can tell.
    expect(res.headers.get("x-cache")).toBe("HIT");
    expect(await res.text()).toHaveLength(8192);
    expect(traced.statuses()).toEqual([
      ["inner", "hit"],
      ["outer", undefined],
    ]);
  });

  it("reports no status for an over-limit follower that runs the handler itself", async () => {
    const traced = subscribeHandlers();
    const { open, opened } = gate();
    const handler = defineCachedHandler(
      async () => {
        await opened;
        return new Response("q".repeat(8192));
      },
      { name: "page", maxAge: 60, maxBodySize: 4096, tracing: true, onError: () => {} },
    );

    const leader = handler(makeEvent()) as Promise<Response>;
    const follower = handler(makeEvent()) as Promise<Response>;
    await new Promise((resolve) => setTimeout(resolve, 0));
    open();
    await Promise.all([leader, follower]);

    expect(traced.statuses()).toEqual([
      ["page", undefined],
      ["page", undefined],
    ]);
  });

  it("reports no status for an event that cannot be narrowed", async () => {
    const traced = subscribeHandlers();
    const handler = defineCachedHandler(() => new Response("live"), {
      name: "page",
      maxAge: 60,
      tracing: true,
      onError: () => {},
    });
    // Assigning to a getter-only `req` throws in strict mode, so narrowing fails.
    const req = new Request("http://localhost/");
    const event = Object.defineProperty({} as HTTPEvent, "req", { get: () => req });

    expect(await ((await handler(event)) as Response).text()).toBe("live");
    expect(traced.statuses()).toEqual([["page", undefined]]);
  });

  describe("stream", () => {
    it("reports a streamed fill when its response goes out", async () => {
      const traced = subscribeHandlers();
      const tasks = backgroundTasks();
      const handler = defineCachedHandler(() => new Response("streamed"), {
        name: "page",
        maxAge: 60,
        stream: true,
        tracing: true,
        waitUntil: tasks.waitUntil,
      });

      const res = (await handler(makeEvent())) as Response;
      expect(traced.statuses()).toEqual([["page", "miss"]]);
      expect(await res.text()).toBe("streamed");
      await tasks.settle();
      await handler(makeEvent());

      expect(traced.statuses()).toEqual([
        ["page", "miss"],
        ["page", "hit"],
      ]);
    });

    it("reports no status when `createResponse` throws", async () => {
      const traced = subscribeHandlers();
      const tasks = backgroundTasks();
      const handler = defineCachedHandler(() => new Response("streamed"), {
        name: "page",
        maxAge: 60,
        stream: true,
        tracing: true,
        waitUntil: tasks.waitUntil,
        createResponse: () => {
          throw new Error("refused");
        },
      });

      await expect(handler(makeEvent())).rejects.toThrow("refused");
      await tasks.settle();

      expect(traced.statuses()).toEqual([["page", undefined]]);
    });

    // The leader is already sent `MISS` when the fill finds the body too large, and its
    // payload settled with it. The status stays what it was sent with; storing fails
    // through `onError`, and every later request is the same streamed miss.
    it("keeps the miss an over-limit leader was sent", async () => {
      const traced = subscribeHandlers();
      const tasks = backgroundTasks();
      const errors: unknown[] = [];
      const handler = defineCachedHandler(() => new Response("x".repeat(8192)), {
        name: "page",
        maxAge: 60,
        maxBodySize: 4096,
        stream: true,
        tracing: true,
        waitUntil: tasks.waitUntil,
        onError: (error) => errors.push(error),
      });

      const res = (await handler(makeEvent())) as Response;
      expect(res.headers.get("x-cache")).toBe("MISS");
      expect(await res.text()).toHaveLength(8192);
      await tasks.settle();

      expect(errors).toEqual([expect.objectContaining({ name: "ResponseTooLargeError" })]);
      expect(traced.statuses()).toEqual([["page", "miss"]]);
    });

    // The nested function's miss is its own resolution's; the page streams its own status.
    it("reports its own status over a nested cached call on the same event", async () => {
      const tasks = backgroundTasks();
      const getUser = defineCachedFunction(async (_event: HTTPEvent) => ({ name: "x" }), {
        name: "getUser",
        getKey: () => "u",
        maxAge: 60,
      });
      const page = defineCachedHandler(
        async (event) => new Response(`hi ${(await getUser(event)).name}`),
        { name: "page", maxAge: 60, stream: true, tracing: true, waitUntil: tasks.waitUntil },
      );
      await ((await page(makeEvent())) as Response).text();
      await tasks.settle();
      await getUser.invalidate(makeEvent());
      await page.expire(makeEvent());
      const traced = subscribeHandlers();

      const res = (await page(makeEvent())) as Response;
      await res.text();
      await tasks.settle();

      // No synthesized `etag`: the response was streamed, not rebuilt by `transform`.
      expect(res.headers.has("etag")).toBe(false);
      expect(res.headers.get("x-cache")).toBe("REVALIDATED");
      expect(traced.statuses()).toEqual([["page", "revalidated"]]);
    });
  });
});

describe("ocache.function", () => {
  it("publishes every call with how it was served", async () => {
    const traced = subscribeFunctions();
    const getUser = defineCachedFunction(async (id: string) => ({ id }), {
      name: "getUser",
      maxAge: 60,
      swr: true,
      staleMaxAge: 600,
      tracing: true,
    });

    const user = await getUser("u1");
    await getUser("u1");
    await getUser.expire("u1");
    await getUser("u1");

    expect(traced.started).toEqual(traced.settled);
    expect(traced.settled[0]).toMatchObject({
      args: ["u1"],
      name: "getUser",
      group: "functions",
      status: "miss",
      result: user,
    });
    expect(traced.statuses()).toEqual([
      ["getUser", "miss"],
      ["getUser", "hit"],
      ["getUser", "stale"],
    ]);
  });

  it("reports no status for a bypassed or a failing call", async () => {
    const traced = subscribeFunctions();
    const getUser = defineCachedFunction(
      async (id: string) => {
        if (id === "missing") {
          throw new Error("not found");
        }
        return { id };
      },
      { name: "getUser", maxAge: 60, shouldBypassCache: (id) => id === "live", tracing: true },
    );

    await getUser("live");
    await expect(getUser("missing")).rejects.toThrow("not found");

    expect(traced.statuses()).toEqual([
      ["getUser", undefined],
      ["getUser", undefined],
    ]);
    expect(traced.settled[1]!.error).toMatchObject({ message: "not found" });
  });

  it("publishes a cached handler's call once, on the handler channel", async () => {
    const functions = subscribeFunctions();
    const handlers = subscribeHandlers();
    const handler = defineCachedHandler(() => new Response("ok"), {
      name: "page",
      maxAge: 60,
      tracing: true,
    });

    await handler(makeEvent());

    expect(functions.settled).toEqual([]);
    expect(handlers.statuses()).toEqual([["page", "miss"]]);
  });

  it("reports a cached function inside a handler on a payload of its own", async () => {
    const functions = subscribeFunctions();
    const handlers = subscribeHandlers();
    const getUser = defineCachedFunction(async (_event: HTTPEvent) => ({ name: "x" }), {
      name: "getUser",
      getKey: () => "u",
      maxAge: 60,
      tracing: true,
    });
    const handler = defineCachedHandler(
      async (event) => new Response(`hi ${(await getUser(event)).name}`),
      { name: "page", maxAge: 60, tracing: true },
    );

    await handler(makeEvent());
    await handler.expire(makeEvent());
    await handler(makeEvent());

    expect(functions.statuses()).toEqual([
      ["getUser", "miss"],
      ["getUser", "hit"],
    ]);
    expect(handlers.statuses()).toEqual([
      ["page", "miss"],
      ["page", "revalidated"],
    ]);
  });
});

describe("tracing off", () => {
  it("looks up no channel and publishes nothing unless enabled", async () => {
    const getBuiltinModule = vi.spyOn(process, "getBuiltinModule");
    const functions = subscribeFunctions();
    const handlers = subscribeHandlers();
    const getUser = defineCachedFunction(async (id: string) => ({ id }), {
      name: "getUser",
      maxAge: 60,
    });
    const handler = defineCachedHandler(() => new Response("ok"), { name: "page", maxAge: 60 });

    await getUser("u1");
    await handler(makeEvent());
    await handler(makeEvent());

    const lookups = getBuiltinModule.mock.calls.filter(([id]) => id === "node:diagnostics_channel");
    expect(lookups).toEqual([]);
    expect(functions.started).toEqual([]);
    expect(handlers.started).toEqual([]);
  });

  it("serves as usual where the runtime has no diagnostics channels", async () => {
    const handlers = subscribeHandlers();
    const getBuiltinModule = vi.spyOn(process, "getBuiltinModule").mockImplementation(() => {
      throw new Error("No such built-in module: node:diagnostics_channel");
    });
    const handler = defineCachedHandler(() => new Response("ok"), {
      name: "page",
      maxAge: 60,
      tracing: true,
    });
    const getUser = defineCachedFunction(async (id: string) => ({ id }), {
      name: "getUser",
      maxAge: 60,
      tracing: true,
    });
    getBuiltinModule.mockRestore();

    await handler(makeEvent());
    const hit = (await handler(makeEvent())) as Response;
    expect(await getUser("u1")).toEqual({ id: "u1" });

    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(handlers.started).toEqual([]);
  });
});
