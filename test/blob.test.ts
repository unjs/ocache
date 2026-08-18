import { describe, expect, it } from "vitest";

import {
  cachedFunction,
  defineCachedHandler,
  expireCache,
  invalidateCache,
  createBlobStorage,
  type BlobBackend,
} from "../src/index.ts";

// `createBlobStorage` is the one place where ocache decides a byte layout, so these tests
// hold the frame itself rather than only the round trip: a persistent backend outlives the
// process that wrote it, and a layout change that still round trips inside one process would
// silently mangle every entry already on disk. The header offsets, the flag bits, and the
// rule that an unreadable frame is a *miss* are all asserted directly.

const FRAME_HEADER_BYTES = 8;
const decoder = new TextDecoder();

/** A byte backend over a Map, plus the raw frames so a test can read the layout. */
function blobBackend() {
  const raw = new Map<string, Uint8Array>();
  const ttls: Array<number | undefined> = [];
  const backend: BlobBackend = {
    get: (key) => raw.get(key) ?? null,
    set: (key, value, opts) => {
      ttls.push(opts?.ttl);
      if (value === null) {
        raw.delete(key);
      } else {
        raw.set(key, value);
      }
    },
  };
  return { backend, raw, ttls, storage: createBlobStorage(backend) };
}

/** Splits one stored frame into the parts the layout promises. */
function readFrame(frame: Uint8Array) {
  const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4);
  const payloadStart = FRAME_HEADER_BYTES + headerLength;
  return {
    magic: String.fromCharCode(frame[0]!, frame[1]!),
    version: frame[2]!,
    flags: frame[3]!,
    headerLength,
    metadata: JSON.parse(decoder.decode(frame.subarray(FRAME_HEADER_BYTES, payloadStart))),
    payload: frame.subarray(payloadStart),
  };
}

function onlyFrame(raw: Map<string, Uint8Array>) {
  expect(raw.size).toBe(1);
  return readFrame([...raw.values()][0]!);
}

let testId = 0;
const makeEvent = (path: string) => ({ req: new Request(`http://localhost${path}`) });
const uniquePath = () => `/blob-${++testId}-${Date.now()}`;

describe("createBlobStorage", () => {
  describe("frame layout", () => {
    it("appends a text response body after the metadata, not inside it", async () => {
      const { raw, storage } = blobBackend();
      const body = "<p>héllo</p>";
      const handler = defineCachedHandler(() => new Response(body), { maxAge: 10, storage });
      const path = uniquePath();

      const miss = (await handler(makeEvent(path))) as Response;
      const hit = (await handler(makeEvent(path))) as Response;

      expect(await miss.text()).toBe(body);
      expect(await hit.text()).toBe(body);
      expect(hit.headers.get("x-cache")).toBe("HIT");

      const frame = onlyFrame(raw);
      expect(frame.magic).toBe("oc");
      expect(frame.version).toBe(1);
      // A payload, and it is text rather than bytes.
      expect(frame.flags).toBe(1);
      expect(frame.flags & 0b0001_1100).toBe(0);
      expect(frame.metadata.payload).toBe("value.body");
      // The body left the JSON entirely, so it pays no escaping in either direction.
      expect(frame.metadata.value.body).toBeUndefined();
      expect(decoder.decode(frame.payload)).toBe(body);
      // Multi-byte text is stored as its UTF-8 length, not its character count.
      expect(frame.payload.length).toBe(new TextEncoder().encode(body).length);
    });

    it("appends a binary response body as itself, with no base64", async () => {
      const { raw, storage } = blobBackend();
      const bytes = new Uint8Array([0xff, 0x00, 0x80, 0xfe]);
      const handler = defineCachedHandler(() => new Response(bytes), { maxAge: 10, storage });
      const path = uniquePath();

      const miss = (await handler(makeEvent(path))) as Response;
      const hit = (await handler(makeEvent(path))) as Response;

      expect([...new Uint8Array(await miss.arrayBuffer())]).toEqual([...bytes]);
      expect([...new Uint8Array(await hit.arrayBuffer())]).toEqual([...bytes]);

      const frame = onlyFrame(raw);
      // A payload, and it is bytes.
      expect(frame.flags).toBe(3);
      expect([...frame.payload]).toEqual([...bytes]);
      // `serializeResponse` never reached for base64, because the storage declares `binary`.
      expect(frame.metadata.value.base64).toBeUndefined();
      expect(frame.metadata.value.body).toBeUndefined();
      // Nothing in the frame is 4/3 the body: the whole entry is the metadata plus the bytes.
      expect(frame.headerLength + FRAME_HEADER_BYTES + bytes.length).toBe(
        [...raw.values()][0]!.length,
      );
    });

    it("appends a byte function value, which needs no declaration", async () => {
      const { raw, storage } = blobBackend();
      const bytes = new Uint8Array([0xff, 0x00, 0x80, 0xfe]);
      let calls = 0;
      const fn = cachedFunction(
        () => {
          calls++;
          return bytes;
        },
        { maxAge: 10, name: "blobValue", storage },
      );

      const miss = await fn();
      const hit = await fn();

      expect(calls).toBe(1);
      expect(miss).toBeInstanceOf(Uint8Array);
      expect(hit).toBeInstanceOf(Uint8Array);
      expect([...hit!]).toEqual([...bytes]);

      const frame = onlyFrame(raw);
      expect(frame.flags).toBe(3);
      // A byte value is its own payload, so `cache.ts` derives the location from the form.
      expect(frame.metadata.payload).toBe("value");
      expect(frame.metadata.encoding).toBe("bytes");
      expect(frame.metadata.value).toBeUndefined();
      expect([...frame.payload]).toEqual([...bytes]);
    });

    it("writes no payload for a value that declares none", async () => {
      const { raw, storage } = blobBackend();
      const fn = cachedFunction(() => ({ a: 1, b: [2, 3] }), {
        maxAge: 10,
        name: "blobJson",
        storage,
      });

      await fn();
      expect(await fn()).toEqual({ a: 1, b: [2, 3] });

      const frame = onlyFrame(raw);
      expect(frame.flags).toBe(0);
      expect(frame.payload.length).toBe(0);
      expect(frame.metadata.payload).toBeUndefined();
      expect(frame.metadata.value).toEqual({ a: 1, b: [2, 3] });
    });

    it("lifts a declared body out of a function value", async () => {
      const { raw, storage } = blobBackend();
      const fn = cachedFunction(() => ({ type: "text/csv", body: "a,b\n1,2\n" }), {
        maxAge: 10,
        name: "blobDeclared",
        storage,
        payload: "value.body",
      });

      await fn();
      expect(await fn()).toEqual({ type: "text/csv", body: "a,b\n1,2\n" });

      const frame = onlyFrame(raw);
      expect(frame.flags).toBe(1);
      expect(frame.metadata.value).toEqual({ type: "text/csv" });
      expect(decoder.decode(frame.payload)).toBe("a,b\n1,2\n");
    });

    it("keeps a declared payload the value does not hold inside the metadata", async () => {
      const { raw, storage } = blobBackend();
      const fn = cachedFunction(() => ({ body: { nested: true } }), {
        maxAge: 10,
        name: "blobUnliftable",
        storage,
        payload: "value.body",
      });

      await fn();
      expect(await fn()).toEqual({ body: { nested: true } });

      // Neither text nor bytes, so it stays where it is rather than being framed wrongly.
      const frame = onlyFrame(raw);
      expect(frame.flags).toBe(0);
      expect(frame.metadata.value).toEqual({ body: { nested: true } });
    });
  });

  describe("what the frame does not promise", () => {
    // The declaration names one payload. A byte view anywhere else goes through JSON, which
    // is what it would do on any other serializing backend — this is not a blob-storage
    // regression, and pinning it keeps `binary: true` from reading as a wider promise.
    it("does not preserve a byte view at an undeclared location", async () => {
      const { storage } = blobBackend();
      const fn = cachedFunction(() => ({ bytes: new Uint8Array([1, 2, 3]) }), {
        maxAge: 10,
        name: "blobNested",
        storage,
      });

      await fn();
      const hit = (await fn()) as { bytes: unknown };

      expect(hit.bytes).not.toBeInstanceOf(Uint8Array);
      expect(hit.bytes).toEqual({ 0: 1, 1: 2, 2: 3 });
    });
  });

  describe("an unreadable frame is a miss", () => {
    it("re-resolves a frame written by another version", async () => {
      const { raw, storage } = blobBackend();
      let calls = 0;
      const fn = cachedFunction(
        () => {
          calls++;
          return "value";
        },
        { maxAge: 10, name: "blobVersion", storage },
      );

      await fn();
      expect(calls).toBe(1);

      // Bump the version byte on the stored frame, as a future format change would.
      for (const [key, frame] of raw) {
        const bumped = new Uint8Array(frame);
        bumped[2] = 99;
        raw.set(key, bumped);
      }

      expect(await fn()).toBe("value");
      // The entry was not served and not thrown over: the value was resolved again.
      expect(calls).toBe(2);
    });

    // Frames using unsupported fields must miss.
    it.each([
      ["a reserved compression id", 0b0000_0100],
      ["the highest reserved compression id", 0b0001_1100],
      ["a bit outside every defined field", 0b0010_0000],
    ])("re-resolves a frame carrying %s", async (_label, bits) => {
      const { raw, storage } = blobBackend();
      let calls = 0;
      const fn = cachedFunction(
        () => {
          calls++;
          return "value";
        },
        { maxAge: 10, name: `blobFlag${bits}`, storage },
      );

      await fn();
      expect(calls).toBe(1);
      for (const [key, frame] of raw) {
        const tagged = new Uint8Array(frame);
        tagged[3]! |= bits;
        raw.set(key, tagged);
      }

      expect(await fn()).toBe("value");
      expect(calls).toBe(2);
    });

    it("re-resolves corrupt, truncated, and foreign frames", async () => {
      for (const corrupt of [
        new Uint8Array(0),
        new Uint8Array([1, 2, 3]),
        // Plain JSON from a backend that was not framed.
        new TextEncoder().encode('{"value":"x"}'),
        // A valid header claiming more metadata than the frame holds.
        Uint8Array.from([0x6f, 0x63, 1, 0, 0, 0, 0xff, 0xff]),
        // A valid header whose metadata is not JSON.
        Uint8Array.from([0x6f, 0x63, 1, 0, 0, 0, 0, 2, 0x7b, 0x7b]),
      ]) {
        const { raw, storage } = blobBackend();
        let calls = 0;
        const fn = cachedFunction(
          () => {
            calls++;
            return "value";
          },
          { maxAge: 10, name: "blobCorrupt", storage },
        );

        await fn();
        for (const key of raw.keys()) {
          raw.set(key, corrupt);
        }

        expect(await fn()).toBe("value");
        expect(calls).toBe(2);
      }
    });
  });

  describe("backend contract", () => {
    it("passes the storage TTL through and removes a key on invalidation", async () => {
      const { raw, ttls, storage } = blobBackend();
      const opts = { maxAge: 10, name: "blobTtl", storage };
      const fn = cachedFunction(() => "value", opts);

      await fn();
      expect(ttls.some((ttl) => ttl != null)).toBe(true);
      expect(raw.size).toBe(1);

      await invalidateCache({ options: opts });
      expect(raw.size).toBe(0);
    });

    it("round trips an entry that `expireCache` rewrites", async () => {
      const { raw, storage } = blobBackend();
      const bytes = new Uint8Array([0xff, 0x00, 0x80, 0xfe]);
      const opts = { maxAge: 10, name: "blobExpire", storage };
      let calls = 0;
      const fn = cachedFunction(() => {
        calls++;
        return bytes;
      }, opts);

      await fn();
      // `expireCache` reads the decoded entry and writes it straight back, so the codec has
      // to survive a round trip it did not originate.
      await expireCache({ options: opts });

      const frame = onlyFrame(raw);
      expect(frame.metadata.stale).toBe(true);
      expect(frame.metadata.payload).toBe("value");
      expect([...frame.payload]).toEqual([...bytes]);

      const hit = await fn();
      expect([...hit!]).toEqual([...bytes]);
      expect(calls).toBe(2);
    });

    it("accepts a backend that returns a view over a larger buffer", async () => {
      const raw = new Map<string, Uint8Array>();
      const storage = createBlobStorage({
        get: (key) => {
          const frame = raw.get(key);
          if (!frame) {
            return null;
          }
          // A driver may hand back a window into a pooled buffer, as `node:fs` does.
          const padded = new Uint8Array(frame.length + 16);
          padded.set(frame, 8);
          return padded.subarray(8, 8 + frame.length);
        },
        set: (key, value) => {
          if (value === null) {
            raw.delete(key);
          } else {
            raw.set(key, value);
          }
        },
      });

      const bytes = new Uint8Array([0xff, 0x00, 0x80, 0xfe]);
      let calls = 0;
      const fn = cachedFunction(
        () => {
          calls++;
          return bytes;
        },
        { maxAge: 10, name: "blobOffset", storage },
      );

      await fn();
      expect([...(await fn())!]).toEqual([...bytes]);
      expect(calls).toBe(1);
    });

    it("passes the backend's per-entry ceiling through", () => {
      const storage = createBlobStorage({
        get: () => null,
        set: () => {},
        maxEntryBytes: 4096,
      });
      expect(storage.maxEntryBytes).toBe(4096);
      expect(storage.binary).toBe(true);
    });
  });

  describe("storage markers stay in storage", () => {
    it("never shows `payload` or `encoding` to a hook or a caller", async () => {
      const { storage } = blobBackend();
      const seen: unknown[] = [];
      const bytes = new Uint8Array([0xff, 0x00]);
      const fn = cachedFunction(() => bytes, {
        maxAge: 10,
        name: "blobMarkers",
        storage,
        validate: (entry) => {
          seen.push({ payload: entry.payload, encoding: entry.encoding });
          return true;
        },
      });

      await fn();
      await fn();

      expect(seen.length).toBeGreaterThan(0);
      for (const entry of seen) {
        expect(entry).toEqual({ payload: undefined, encoding: undefined });
      }
    });
  });
});
