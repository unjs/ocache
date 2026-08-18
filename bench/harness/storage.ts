// Storage backends modelled by latency, not by protocol.
//
// The point of these profiles is that a cache hit is never free: it trades the origin
// round trip for a storage round trip. A profile whose read latency approaches the origin
// cost turns caching into a loss, and the harness has to be able to show that.

import { createBlobStorage, createMemoryStorage } from "../../src/index.ts";
import { delay } from "./clock.ts";
import { lognormal } from "./random.ts";

import type { StorageInterface } from "../../src/index.ts";
import type { Rng } from "./random.ts";

export interface StorageProfile {
  /** Median and p99 round trip, in milliseconds. */
  readP50: number;
  readP99: number;
  writeP50: number;
  writeP99: number;
  /** Extra round-trip time per KiB of payload, for the wire and the driver. */
  perKiBMs: number;
  /**
   * Whether the backend crosses a serialization boundary.
   *
   * A remote store JSON-encodes on write and decodes on read. That CPU is charged to the
   * caller's event loop, so it is real cost that a memory store does not pay.
   */
  serializes: boolean;
  /**
   * Which codec that boundary uses.
   *
   * `"json"` (the default) models a client library that JSON-encodes the whole entry, which
   * is what almost every driver does today. `"bytes"` models a byte-only store — `fs`, S3/R2,
   * `getItemRaw`, a Redis `getBuffer` — fronted by `createBlobStorage`, which moves the
   * response body as itself and JSON-encodes only the metadata around it.
   *
   * A `"bytes"` profile exists to be compared against its JSON twin, so the two must keep
   * *identical* latency fields: the pair is built by spreading one object, and the only
   * thing that may differ between them is this codec.
   */
  codec?: "json" | "bytes";
  note: string;
}

// Declared once so a codec pair cannot drift apart on latency.
const REDIS_AZ = {
  readP50: 0.6,
  readP99: 3,
  writeP50: 0.8,
  writeP99: 4,
  perKiBMs: 0.008,
  serializes: true,
  note: "same-region TCP",
} satisfies StorageProfile;

const OBJECT_STORE = {
  readP50: 30,
  readP99: 120,
  writeP50: 55,
  writeP99: 200,
  perKiBMs: 0.05,
  serializes: true,
  note: "S3 / R2 GetObject",
} satisfies StorageProfile;

export const PROFILES = {
  memory: {
    readP50: 0,
    readP99: 0,
    writeP50: 0,
    writeP99: 0,
    perKiBMs: 0,
    serializes: false,
    note: "in-process Map (createMemoryStorage)",
  },
  "redis-local": {
    readP50: 0.12,
    readP99: 0.5,
    writeP50: 0.15,
    writeP99: 0.6,
    perKiBMs: 0.002,
    serializes: true,
    note: "unix socket or sidecar valkey",
  },
  "redis-az": REDIS_AZ,
  // Same wire, different codec. See `StorageProfile.codec`.
  "redis-az-bytes": {
    ...REDIS_AZ,
    codec: "bytes",
    note: "same-region TCP, one blob per entry (createBlobStorage)",
  },
  sql: {
    readP50: 2,
    readP99: 15,
    writeP50: 5,
    writeP99: 30,
    perKiBMs: 0.02,
    serializes: true,
    note: "Postgres or D1 key-value table",
  },
  "kv-edge": {
    readP50: 6,
    readP99: 40,
    writeP50: 25,
    writeP99: 120,
    perKiBMs: 0.03,
    serializes: true,
    note: "Cloudflare KV / Deno KV, eventually consistent",
  },
  "object-store": OBJECT_STORE,
  "object-store-bytes": {
    ...OBJECT_STORE,
    codec: "bytes",
    note: "S3 / R2 GetObject, one blob per entry (createBlobStorage)",
  },
} satisfies Record<string, StorageProfile>;

export type ProfileName = keyof typeof PROFILES;

export interface StorageStats {
  reads: number;
  readHits: number;
  writes: number;
  deletes: number;
  /** Wall time callers spent blocked on the backend, in milliseconds. */
  readMs: number;
  writeMs: number;
  bytesWritten: number;
  /** Entries dropped by the backing store's own ceilings. */
  evicted: number;
}

export interface ProfiledStorage extends StorageInterface {
  stats: StorageStats;
  /** Skips latency and serialization, for prewarm. */
  instant: boolean;
  reset(): void;
}

function newStats(): StorageStats {
  return {
    reads: 0,
    readHits: 0,
    writes: 0,
    deletes: 0,
    readMs: 0,
    writeMs: 0,
    bytesWritten: 0,
    evicted: 0,
  };
}

/**
 * Wraps a memory store with a profile's latency and serialization cost.
 *
 * `maxEntryBytes` is deliberately forwarded: `http/entry.ts` derives its body-buffering
 * limit from it, so hiding it would silently disable that ceiling.
 */
export function createProfiledStorage(
  profile: StorageProfile,
  opts: { rng: Rng; maxBytes?: number; maxSize?: number },
): ProfiledStorage {
  const inner = createMemoryStorage({
    maxBytes: opts.maxBytes ?? Infinity,
    maxSize: opts.maxSize ?? Infinity,
  });
  const stats = newStats();
  const free = profile.readP50 === 0 && profile.writeP50 === 0 && !profile.serializes;

  if (profile.codec === "bytes") {
    return createProfiledBlobStorage(profile, inner, stats, opts.rng);
  }

  const storage: ProfiledStorage = {
    maxEntryBytes: inner.maxEntryBytes,
    // A profile that does not serialize stores the inner value as it is, byte views included,
    // so it must declare what the shipped memory backend declares. A serializing profile must
    // not: its JSON round trip is exactly what the flag promises does not happen.
    ...(free && { binary: true }),
    stats,
    instant: false,
    reset() {
      Object.assign(stats, newStats());
    },
    async get(key) {
      stats.reads++;
      if (free) {
        const value = inner.get(key);
        if (value != null) stats.readHits++;
        return value as any;
      }
      // A remote store always crosses the serialization boundary, prewarm included:
      // the inner representation has to stay one shape. Only the wait is skipped.
      // Memory storage answers synchronously; the interface allows a promise.
      const raw = inner.get<string>(key) as string | null;
      if (!storage.instant) {
        const started = performance.now();
        const kiB = raw ? raw.length / 1024 : 0;
        await delay(lognormal(opts.rng, profile.readP50, profile.readP99) + kiB * profile.perKiBMs);
        stats.readMs += performance.now() - started;
      }
      if (raw == null) return null;
      stats.readHits++;
      // Decoding is charged to the caller, as a real client library charges it.
      return JSON.parse(raw) as any;
    },
    async set(key, value, setOpts) {
      const removing = value === null || value === undefined;
      if (removing) {
        stats.deletes++;
      } else {
        stats.writes++;
      }
      if (free) {
        inner.set(key, value, setOpts);
        return;
      }
      const raw = removing ? undefined : JSON.stringify(value);
      if (raw !== undefined) stats.bytesWritten += raw.length;
      if (!storage.instant) {
        const started = performance.now();
        const kiB = raw ? raw.length / 1024 : 0;
        await delay(
          lognormal(opts.rng, profile.writeP50, profile.writeP99) + kiB * profile.perKiBMs,
        );
        stats.writeMs += performance.now() - started;
      }
      inner.set(key, raw ?? null, setOpts);
      if (raw !== undefined && inner.get(key) == null) stats.evicted++;
    },
  };
  return storage;
}

/**
 * The `codec: "bytes"` arm: `createBlobStorage` over a byte store with this profile's latency.
 *
 * The differences from the JSON arm above are the point of the pairing, and there are three.
 * The frame, not a JSON string, is what the backing store holds — so the memory ceiling
 * charges it by `byteLength` rather than at two bytes per UTF-16 code unit. The frame's
 * length, not the JSON string's, drives the per-KiB wire term — so a binary body that no
 * longer expands by 4/3 genuinely costs less round-trip time here. And `binary` comes from
 * `createBlobStorage` itself rather than from this file, because the codec is what makes the
 * declaration true.
 *
 * Everything else — the lognormal draw, the stats, `instant` — is the JSON arm's, so a paired
 * run differs only in the codec.
 *
 * One caveat on `bytesWritten`: the JSON arm counts a string's `length` and this one counts a
 * frame's `byteLength`. Both entry forms are ASCII-dominated, so the two are comparable in
 * practice, but a payload of multi-byte text makes the JSON arm read low by up to a factor of
 * the UTF-8 expansion. Read the column as storage volume, not as an exact byte count.
 */
function createProfiledBlobStorage(
  profile: StorageProfile,
  inner: StorageInterface,
  stats: StorageStats,
  rng: Rng,
): ProfiledStorage {
  let storage: ProfiledStorage;

  const framed = createBlobStorage({
    maxEntryBytes: inner.maxEntryBytes,

    async get(key) {
      stats.reads++;
      const frame = inner.get<Uint8Array>(key) as Uint8Array | null;
      if (!storage.instant) {
        const started = performance.now();
        const kiB = frame ? frame.length / 1024 : 0;
        await delay(lognormal(rng, profile.readP50, profile.readP99) + kiB * profile.perKiBMs);
        stats.readMs += performance.now() - started;
      }
      if (frame == null) {
        return null;
      }
      stats.readHits++;
      return frame;
    },

    async set(key, value, setOpts) {
      if (value === null) {
        stats.deletes++;
      } else {
        stats.writes++;
        stats.bytesWritten += value.length;
      }
      if (!storage.instant) {
        const started = performance.now();
        const kiB = value ? value.length / 1024 : 0;
        await delay(lognormal(rng, profile.writeP50, profile.writeP99) + kiB * profile.perKiBMs);
        stats.writeMs += performance.now() - started;
      }
      inner.set(key, value, setOpts);
      if (value !== null && inner.get(key) == null) {
        stats.evicted++;
      }
    },
  });

  storage = {
    ...framed,
    stats,
    instant: false,
    reset() {
      Object.assign(stats, newStats());
    },
  };
  return storage;
}

/**
 * Routes by key prefix so `base: ["/l1", "/l2"]` can span two backends.
 *
 * ocache's tiers are key prefixes on one `StorageInterface`, not separate stores, so a
 * memory-over-remote tier only exists if the caller supplies a router like this one.
 */
export function createRoutedStorage(
  routes: Array<[prefix: string, storage: StorageInterface]>,
): StorageInterface {
  const fallback = routes[0]![1];
  const resolve = (key: string) => {
    for (const [prefix, storage] of routes) {
      if (key.startsWith(prefix)) return storage;
    }
    return fallback;
  };
  return {
    // Both tiers must agree on the ceiling the HTTP layer derives its body limit from.
    maxEntryBytes: Math.min(...routes.map(([, s]) => s.maxEntryBytes ?? Infinity)),
    // One entry can land in either tier, so bytes survive only if every route keeps them.
    ...(routes.every(([, s]) => s.binary) && { binary: true }),
    get: (key) => resolve(key).get(key),
    set: (key, value, opts) => resolve(key).set(key, value, opts),
  };
}
