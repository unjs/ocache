import { describe, expect, it, vi } from "vitest";

import {
  cachedFunction,
  composeStorage,
  createMemoryStorage,
  defineCachedHandler,
  invalidateCache,
  type StorageInterface,
} from "../src/index.ts";

// `composeStorage` is a backend, not a cache option: the cache above it sees one store with
// one declaration. These tests hold the two halves of that claim — the tier behavior it adds
// (order, promotion, per-layer TTL, surviving a dead layer) and the single declaration it
// must produce for `binary` and `maxEntryBytes`, which decide the stored form and how much of
// a response body may be buffered.

type Call = { key: string; value: unknown; ttl: number | undefined };

/** A Map-backed layer that records its calls and can be made to fail or stall. */
function layer(
  opts: {
    binary?: boolean;
    maxEntryBytes?: number;
    failGet?: boolean;
    failSet?: boolean;
    setDelay?: number;
  } = {},
) {
  const map = new Map<string, unknown>();
  const gets: string[] = [];
  const sets: Call[] = [];
  const storage: StorageInterface = {
    ...(opts.binary !== undefined && { binary: opts.binary }),
    ...(opts.maxEntryBytes !== undefined && { maxEntryBytes: opts.maxEntryBytes }),
    async get(key) {
      gets.push(key);
      if (opts.failGet) {
        throw new Error("layer get failed");
      }
      return (map.get(key) ?? null) as any;
    },
    async set(key, value, setOpts) {
      sets.push({ key, value, ttl: setOpts?.ttl });
      if (opts.failSet) {
        throw new Error("layer set failed");
      }
      if (opts.setDelay) {
        await new Promise((resolve) => setTimeout(resolve, opts.setDelay));
      }
      if (value === null || value === undefined) {
        map.delete(key);
      } else {
        map.set(key, value);
      }
    },
  };
  return { storage, map, gets, sets };
}

const silent = { onError: () => {} };

describe("composeStorage", () => {
  it("requires at least one layer", () => {
    expect(() => composeStorage([])).toThrow(/at least one layer/);
  });

  describe("read order", () => {
    it("stops at the first hit", async () => {
      const l1 = layer({ binary: true });
      const l2 = layer({ binary: true });
      const storage = composeStorage([l1.storage, l2.storage]);

      await storage.set("k", { v: 1 });
      expect(await storage.get("k")).toEqual({ v: 1 });

      // The write reached both layers, the read stopped at the first.
      expect(l1.map.get("k")).toEqual({ v: 1 });
      expect(l2.map.get("k")).toEqual({ v: 1 });
      expect(l2.gets).toEqual([]);
    });

    it("falls through to a later layer and promotes the hit forward", async () => {
      const l1 = layer({ binary: true });
      const l2 = layer({ binary: true });
      const l3 = layer({ binary: true });
      const storage = composeStorage([l1.storage, l2.storage, l3.storage]);

      l3.map.set("k", { v: 3 });
      expect(await storage.get("k")).toEqual({ v: 3 });

      // Promotion is a background write; a later `set` is what waits for it.
      await storage.set("other", 1);
      expect(l1.map.get("k")).toEqual({ v: 3 });
      expect(l2.map.get("k")).toEqual({ v: 3 });
      // The layer that already held it is not written again.
      expect(l3.sets.filter((call) => call.key === "k")).toEqual([]);
    });

    it("does not promote when promotion is disabled", async () => {
      const l1 = layer({ binary: true });
      const l2 = layer({ binary: true });
      const storage = composeStorage([l1.storage, l2.storage], { promote: false });

      l2.map.set("k", { v: 2 });
      expect(await storage.get("k")).toEqual({ v: 2 });

      await storage.set("other", 1);
      expect(l1.map.has("k")).toBe(false);
    });

    it("returns null when every layer misses", async () => {
      const l1 = layer({ binary: true });
      const l2 = layer({ binary: true });
      expect(await composeStorage([l1.storage, l2.storage]).get("k")).toBe(null);
      expect(l1.gets).toEqual(["k"]);
      expect(l2.gets).toEqual(["k"]);
    });
  });

  describe("a failing layer is skipped, never fatal", () => {
    it("reads past a layer that throws", async () => {
      const l1 = layer({ binary: true, failGet: true });
      const l2 = layer({ binary: true });
      const onError = vi.fn();
      const storage = composeStorage([l1.storage, l2.storage], { onError });

      l2.map.set("k", { v: 2 });
      expect(await storage.get("k")).toEqual({ v: 2 });
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]![1]).toBe("k");
    });

    it("keeps writing to the other layers when one throws", async () => {
      const l1 = layer({ binary: true, failSet: true });
      const l2 = layer({ binary: true });
      const onError = vi.fn();
      const storage = composeStorage([l1.storage, l2.storage], { onError });

      await expect(storage.set("k", { v: 1 })).resolves.toBeUndefined();
      expect(l2.map.get("k")).toEqual({ v: 1 });
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it("serves a cached function from the local layer while the remote one is down", async () => {
      const local = layer({ binary: true });
      const remote = layer({ binary: true, failGet: true, failSet: true });
      const storage = composeStorage([local.storage, remote.storage], silent);
      let calls = 0;
      const fn = cachedFunction(
        () => {
          calls++;
          return "value";
        },
        { maxAge: 60, name: "composeOutage", storage },
      );

      expect(await fn()).toBe("value");
      expect(await fn()).toBe("value");
      expect(calls).toBe(1);
    });
  });

  describe("per-layer TTL", () => {
    it("caps what the cache asks for, layer by layer", async () => {
      const local = layer({ binary: true });
      const remote = layer({ binary: true });
      const storage = composeStorage([{ storage: local.storage, ttl: 60 }, remote.storage]);

      await storage.set("k", { v: 1 }, { ttl: 3600 });

      expect(local.sets[0]!.ttl).toBe(60);
      expect(remote.sets[0]!.ttl).toBe(3600);
    });

    it("uses the cap as the lifetime of a promotion", async () => {
      const local = layer({ binary: true });
      const remote = layer({ binary: true });
      const storage = composeStorage([{ storage: local.storage, ttl: 60 }, remote.storage]);

      remote.map.set("k", { v: 1 });
      await storage.get("k");
      await storage.set("other", 1);

      const promotion = local.sets.find((call) => call.key === "k");
      expect(promotion?.ttl).toBe(60);
    });

    it("leaves a layer without a cap alone", async () => {
      const local = layer({ binary: true });
      const storage = composeStorage([local.storage]);
      await storage.set("k", { v: 1 });
      await storage.set("j", { v: 1 }, { ttl: 30 });
      expect(local.sets.map((call) => call.ttl)).toEqual([undefined, 30]);
    });
  });

  describe("deletes", () => {
    it("removes the key from every layer", async () => {
      const l1 = layer({ binary: true });
      const l2 = layer({ binary: true });
      const opts = {
        maxAge: 60,
        name: "composeInvalidate",
        storage: composeStorage([l1.storage, l2.storage]),
      };
      const fn = cachedFunction(() => "value", opts);

      await fn();
      expect(l1.map.size).toBe(1);
      expect(l2.map.size).toBe(1);

      await invalidateCache({ options: opts });
      expect(l1.map.size).toBe(0);
      expect(l2.map.size).toBe(0);
    });

    // A promotion started before the delete must not restore the value after it.
    it("lands after a promotion it raced", async () => {
      const l1 = layer({ binary: true, setDelay: 20 });
      const l2 = layer({ binary: true });
      const storage = composeStorage([l1.storage, l2.storage]);

      l2.map.set("k", { v: 2 });
      expect(await storage.get("k")).toEqual({ v: 2 });
      // The promotion into the slow first layer is still in flight here.
      await storage.set("k", null);

      expect(l1.map.has("k")).toBe(false);
      expect(l2.map.has("k")).toBe(false);
    });
  });

  describe("one declaration for the whole stack", () => {
    it("declares `binary` only when every layer does", () => {
      const bytes = () => layer({ binary: true }).storage;
      const json = () => layer().storage;

      expect(composeStorage([bytes(), bytes()]).binary).toBe(true);
      expect(composeStorage([bytes(), json()]).binary).toBe(false);
      expect(composeStorage([json(), bytes()]).binary).toBe(false);
    });

    // One stored form is chosen for the whole stack, so a stack containing a serializing
    // layer stores base64 everywhere — including in the layer that could have held bytes.
    it("stores a byte value as base64 when one layer would mangle it", async () => {
      const local = layer({ binary: true });
      const remote = layer();
      const storage = composeStorage([local.storage, remote.storage]);
      const bytes = new Uint8Array([0xff, 0x00, 0x80]);
      let calls = 0;
      const fn = cachedFunction(
        () => {
          calls++;
          return bytes;
        },
        { maxAge: 60, name: "composeMixed", storage },
      );

      const miss = await fn();
      const hit = await fn();

      expect(calls).toBe(1);
      expect(hit).toBeInstanceOf(Uint8Array);
      expect([...hit!]).toEqual([...bytes]);
      expect([...miss!]).toEqual([...bytes]);

      const stored = [...local.map.values()][0] as { value: unknown; encoding: string };
      expect(stored.encoding).toBe("base64");
      expect(typeof stored.value).toBe("string");
    });

    it("keeps bytes as themselves when every layer declares `binary`", async () => {
      const local = layer({ binary: true });
      const remote = layer({ binary: true });
      const storage = composeStorage([local.storage, remote.storage]);
      const bytes = new Uint8Array([0xff, 0x00, 0x80]);
      const fn = cachedFunction(() => bytes, { maxAge: 60, name: "composeBytes", storage });

      await fn();
      expect([...(await fn())!]).toEqual([...bytes]);

      const stored = [...local.map.values()][0] as { value: unknown; encoding: string };
      expect(stored.encoding).toBe("bytes");
      expect(stored.value).toBeInstanceOf(Uint8Array);
    });

    it("declares the largest per-entry ceiling, and none when a layer has none", () => {
      const small = layer({ binary: true, maxEntryBytes: 1024 }).storage;
      const large = layer({ binary: true, maxEntryBytes: 8192 }).storage;
      const unbounded = layer({ binary: true }).storage;

      expect(composeStorage([small, large]).maxEntryBytes).toBe(8192);
      expect(composeStorage([large, small]).maxEntryBytes).toBe(8192);
      expect(composeStorage([small, unbounded]).maxEntryBytes).toBeUndefined();
    });

    // The ceiling bounds buffering, so it must describe the layer that can hold the entry,
    // not the one that cannot: a body too large for the local layer is refused by that layer
    // alone and still served from the remote one.
    it("caches a response only the larger layer can hold", async () => {
      const local = createMemoryStorage({ maxBytes: 512 });
      const remote = layer({ binary: true });
      const storage = composeStorage([local, remote.storage]);
      const body = "x".repeat(4096);
      let calls = 0;
      const handler = defineCachedHandler(
        () => {
          calls++;
          return new Response(body);
        },
        { maxAge: 60, storage },
      );
      const event = () => ({ req: new Request("http://localhost/compose-large") });

      const miss = (await handler(event())) as Response;
      const hit = (await handler(event())) as Response;

      expect(await miss.text()).toBe(body);
      expect(await hit.text()).toBe(body);
      expect(hit.headers.get("x-cache")).toBe("HIT");
      expect(calls).toBe(1);
      // The local layer refused its own copy; the remote one holds the entry.
      expect(await local.get([...remote.map.keys()][0]!)).toBe(null);
      expect(remote.map.size).toBe(1);
    });
  });

  describe("end to end", () => {
    it("promotes a remote hit into the local layer for a cached handler", async () => {
      const local = layer({ binary: true });
      const remote = layer({ binary: true });
      const storage = composeStorage([{ storage: local.storage, ttl: 60 }, remote.storage]);
      let calls = 0;
      const handler = defineCachedHandler(
        () => {
          calls++;
          return new Response("page");
        },
        { maxAge: 60, storage },
      );
      const event = () => ({ req: new Request("http://localhost/compose-promote") });

      await handler(event());
      expect(calls).toBe(1);
      // Simulate a process that only has the shared layer: drop the local copy.
      local.map.clear();

      const hit = (await handler(event())) as Response;
      expect(await hit.text()).toBe("page");
      expect(hit.headers.get("x-cache")).toBe("HIT");
      expect(calls).toBe(1);

      // Flush the background promotion.
      await storage.set("flush", null);
      expect(local.map.size).toBe(1);
    });
  });
});
