// Docs: @docs/3.storage.md

import type { CacheEntry } from "./types.ts";

export interface StorageInterface {
  get<T = unknown>(key: string): T | null | Promise<T | null>;
  set<T = unknown>(key: string, value: T, opts?: { ttl?: number }): void | Promise<void>;

  /**
   * Largest byte charge one entry may have, when the backend enforces a ceiling.
   *
   * The HTTP layer derives its response-body limit from this value so that a body the
   * backend could never store is refused before it is buffered.
   */
  maxEntryBytes?: number;

  /**
   * Whether stored values return byte views unchanged, including views nested in an object.
   *
   * Cached handlers store a binary response body as a `Uint8Array` when a backend declares
   * this, and as base64 text otherwise. A backend that serializes entries must leave it unset:
   * JSON renders a byte view as `{"0":255,...}`, which no reader can undo. A value read back
   * in that shape is rejected as a miss rather than served.
   *
   * A declaring backend hands the same view to every hit, so nothing may mutate a stored body.
   */
  binary?: boolean;
}

const SharedBuffer = globalThis.SharedArrayBuffer as SharedArrayBufferConstructor | undefined;

/** Default entry limit for memory storage. */
const DEFAULT_MEMORY_MAX_SIZE = 10_000;

/** Default estimated byte limit for memory storage. */
const DEFAULT_MEMORY_MAX_BYTES = 100 * 1024 * 1024;

export interface MemoryStorageOptions {
  /**
   * Maximum entry count before LRU eviction.
   *
   * Defaults to `10 000`.
   * Set `Infinity` or `0` to disable this limit.
   * Use {@link maxBytes} to limit attacker-influenced entry sizes.
   */
  maxSize?: number;

  /**
   * Maximum estimated bytes, including keys, before LRU eviction.
   *
   * Defaults to `100 MB`.
   * Set `Infinity` or `0` to disable this limit.
   * An oversized entry replaces its old value with no stored value.
   * An entry whose size cannot be measured is refused the same way.
   */
  maxBytes?: number;

  /**
   * Returns the complete byte charge for a value and its key.
   *
   * Memory storage calls this hook only when {@link maxBytes} is active.
   * The built-in estimate does not count values deeper than eight levels.
   * Provide `sizeOf` for custom deep shapes and for values whose properties throw,
   * which memory storage otherwise refuses to store.
   * Invalid results and errors use the built-in estimate.
   */
  sizeOf?: (value: unknown, key: string) => number;
}

/** Creates Map-based memory storage with TTLs in seconds and LRU eviction. */
export function createMemoryStorage(opts: MemoryStorageOptions = {}): StorageInterface {
  const rawMaxSize = opts.maxSize ?? DEFAULT_MEMORY_MAX_SIZE;
  const rawMaxBytes = opts.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES;
  const maxSize = Number.isFinite(rawMaxSize) && rawMaxSize > 0 ? rawMaxSize : undefined;
  const maxBytes = Number.isFinite(rawMaxBytes) && rawMaxBytes > 0 ? rawMaxBytes : undefined;
  const sizeOf = opts.sizeOf;
  const map = new Map<string, { value: unknown; expires?: number; bytes: number }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // All removal paths must update this running byte total through `deleteEntry`.
  let totalBytes = 0;

  function deleteEntry(key: string) {
    const entry = map.get(key);
    if (entry) {
      totalBytes -= entry.bytes;
      map.delete(key);
    }
    clearTimer(timers, key);
  }

  return {
    // Declare the per-entry ceiling so callers can refuse oversized values earlier.
    maxEntryBytes: maxBytes,

    // Entries are held by reference, so a byte view survives a round trip as itself.
    binary: true,

    get(key) {
      const entry = map.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expires && Date.now() > entry.expires) {
        deleteEntry(key);
        return null;
      }
      // Move the entry to MRU without changing its byte charge.
      if (maxSize || maxBytes) {
        map.delete(key);
        map.set(key, entry);
      }
      return entry.value as any;
    },
    set(key, value, opts) {
      // Remove the previous byte charge and timer before replacement.
      deleteEntry(key);
      if (value === null || value === undefined) {
        return;
      }
      let bytes = 0;
      if (maxBytes) {
        const measured = entryBytes(key, value, sizeOf);
        // Refuse oversized entries to prevent a single-write cache-flush attack, and
        // unmeasurable ones because storing them at no charge removes the budget.
        if (measured === undefined || measured > maxBytes) {
          return;
        }
        bytes = measured;
      }
      const ttlMs = opts?.ttl ? opts.ttl * 1000 : undefined;
      map.set(key, {
        value,
        expires: ttlMs ? Date.now() + ttlMs : undefined,
        bytes,
      });
      totalBytes += bytes;
      if (ttlMs) {
        const timer = setTimeout(() => {
          deleteEntry(key);
        }, ttlMs);
        // Do not keep the process alive for cache timers.
        if (timer && typeof timer === "object" && "unref" in timer) {
          timer.unref();
        }
        timers.set(key, timer);
      }
      // Map iteration returns the least-recently-used key first.
      if (maxSize || maxBytes) {
        while ((maxSize && map.size > maxSize) || (maxBytes && totalBytes > maxBytes)) {
          const oldest = map.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          deleteEntry(oldest);
        }
      }
    },
  };
}

// The depth limit covers the common `CacheEntry<ResponseCacheEntry>` shape.
const ENTRY_OVERHEAD = 64;
const PROPERTY_OVERHEAD = 8;
const MAX_ESTIMATE_DEPTH = 8;

// Returns `undefined` when the value cannot be measured at all.
function entryBytes(
  key: string,
  value: unknown,
  sizeOf: MemoryStorageOptions["sizeOf"],
): number | undefined {
  if (sizeOf) {
    try {
      const size = sizeOf(value, key);
      if (Number.isFinite(size) && size >= 0) {
        return size;
      }
    } catch {
      // Use the built-in estimate.
    }
  }
  try {
    return estimateBytes(key) + ENTRY_OVERHEAD + estimateValue(value, 0, new Set());
  } catch {
    // A getter or proxy trap threw: the retained size is unknown, and charging only the
    // key would make an arbitrarily large value free. The caller refuses the entry.
    return undefined;
  }
}

// Charge two bytes per UTF-16 code unit; safe over-counting preserves the budget.
function estimateBytes(str: string): number {
  return str.length * 2;
}

// Track references and limit depth without allocating a JSON copy.
function estimateValue(value: unknown, depth: number, seen: Set<object>): number {
  switch (typeof value) {
    case "string": {
      return estimateBytes(value);
    }
    case "number":
    case "bigint": {
      return 8;
    }
    case "boolean": {
      return 4;
    }
    case "object": {
      break;
    }
    default: {
      // Ignore values with no estimated retained payload.
      return 0;
    }
  }
  if (value === null || seen.has(value) || depth >= MAX_ESTIMATE_DEPTH) {
    return 0;
  }
  seen.add(value);
  // A view retains its whole backing buffer, so charge the buffer, not the window.
  if (ArrayBuffer.isView(value)) {
    const buffer = value.buffer;
    if (seen.has(buffer)) {
      return 0;
    }
    seen.add(buffer);
    return buffer.byteLength;
  }
  if (isBuffer(value)) {
    return value.byteLength;
  }
  const next = depth + 1;
  let total = 0;
  // Object keys do not expose Array, Set, or Map contents.
  if (Array.isArray(value) || value instanceof Set) {
    for (const item of value as Iterable<unknown>) {
      total += PROPERTY_OVERHEAD + estimateValue(item, next, seen);
    }
  } else if (value instanceof Map) {
    for (const [k, v] of value) {
      total += PROPERTY_OVERHEAD + estimateValue(k, next, seen) + estimateValue(v, next, seen);
    }
  } else {
    for (const key of Object.keys(value)) {
      total +=
        PROPERTY_OVERHEAD +
        estimateBytes(key) +
        estimateValue((value as Record<string, unknown>)[key], next, seen);
    }
  }
  return total;
}

// A `SharedArrayBuffer` is not an `ArrayBuffer`, and the global is absent in some runtimes.
function isBuffer(value: object): value is ArrayBufferLike {
  return (
    value instanceof ArrayBuffer || (SharedBuffer !== undefined && value instanceof SharedBuffer)
  );
}

function clearTimer(timers: Map<string, ReturnType<typeof setTimeout>>, key: string) {
  const existing = timers.get(key);
  if (existing !== undefined) {
    clearTimeout(existing);
    timers.delete(key);
  }
}

/**
 * A backend that stores one byte payload per key.
 *
 * This is the shape a raw store already has: unstorage's `getItemRaw`/`setItemRaw`, a
 * filesystem `readFile`/`writeFile`, a Redis `getBuffer`/`set`, an object-store `get`/`put`.
 * {@link createBlobStorage} adapts one to a {@link StorageInterface}.
 */
export interface BlobBackend {
  /** Returns the stored bytes, or `null` when the key is absent. */
  get(key: string): BlobValue | null | undefined | Promise<BlobValue | null | undefined>;
  /** Stores the bytes, or removes the key when `value` is `null`. */
  set(key: string, value: Uint8Array | null, opts?: { ttl?: number }): void | Promise<void>;
  /** Largest byte charge one entry may have. Passed through to {@link StorageInterface}. */
  maxEntryBytes?: number;
}

/** What a byte backend may return: a view, or the buffer behind one. */
export type BlobValue = ArrayBufferView | ArrayBufferLike;

// Frame layout, all offsets fixed:
//
//   0  2  magic "oc"
//   2  1  version
//   3  1  flags
//   4  4  metadata length, big-endian
//   8  n  metadata JSON, UTF-8
//   8+n   payload bytes
//
// The payload sits last and its offset is known from the header alone, which is what a
// ranged read needs and what a `304` — headers only, never the body — could stop before.
const FRAME_MAGIC_0 = 0x6f; // "o"
const FRAME_MAGIC_1 = 0x63; // "c"
const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = 8;

/** A payload follows the metadata. */
const FLAG_PAYLOAD = 1;
/** That payload is bytes rather than UTF-8 text. */
const FLAG_PAYLOAD_BYTES = 2;

/** Reserved compression id field, bits 2-4. Only `0` is implemented. */
const COMPRESSION_MASK = 0b0001_1100;
const COMPRESSION_SHIFT = 2;

// Reserved: 0 none, 1 gzip, 2 deflate-raw, 3 brotli, 4 zstd, 5-7 unassigned.
const COMPRESSION_NONE = 0;

/** All bits defined by this frame layout. Unknown bits must miss. */
const ALL_FLAGS = FLAG_PAYLOAD | FLAG_PAYLOAD_BYTES | COMPRESSION_MASK;

const utf8Encoder = /* @__PURE__ */ new TextEncoder();
// Fatal, so a corrupted payload misses instead of decoding to replacement characters.
const utf8Decoder = /* @__PURE__ */ new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Adapts a byte-only backend into a {@link StorageInterface}, storing each entry as one frame.
 *
 * The entry's metadata travels as JSON and its payload travels as itself, appended after it.
 * That keeps a response body — text or binary — out of the JSON document: text pays no
 * escaping in either direction, and bytes pay no base64 and no 4/3 expansion in the backend.
 *
 * The payload is the one named by {@link CacheEntry.payload}, which the producer of the entry
 * declares — `http/entry.ts` for a response body, `cache.ts` for a byte value. Nothing here
 * infers a payload from a value's shape.
 *
 * This declares `binary`, because the frame carries the declared payload as bytes. Every
 * other member of the entry is JSON, exactly as it would be on a serializing backend: a byte
 * view hidden somewhere ocache did not put one does not survive, on this backend or on any
 * other JSON-shaped one.
 *
 * A frame written by a different version is read as a miss, so a format change costs one
 * revalidation rather than a mangled entry.
 *
 * @example
 * ```ts
 * const storage = createBlobStorage({
 *   get: (key) => unstorage.getItemRaw(key),
 *   set: (key, value, opts) =>
 *     value === null ? unstorage.removeItem(key) : unstorage.setItemRaw(key, value, opts),
 * });
 * ```
 */
export function createBlobStorage(backend: BlobBackend): StorageInterface {
  return {
    // The frame moves the declared payload intact, so a byte value never needs base64.
    binary: true,
    maxEntryBytes: backend.maxEntryBytes,

    async get(key) {
      const stored = await backend.get(key);
      return (stored ? decodeFrame(toBytes(stored)) : null) as any;
    },

    async set(key, value, opts) {
      await backend.set(
        key,
        value === null || value === undefined ? null : encodeFrame(value as CacheEntry),
        opts,
      );
    },
  };
}

/** Returns a `Uint8Array` over the same memory, whatever byte form the backend returned. */
function toBytes(value: BlobValue): Uint8Array {
  return ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
}

/** Returns the entry as one frame, with its declared payload appended after the metadata. */
function encodeFrame(entry: CacheEntry): Uint8Array {
  let flags = COMPRESSION_NONE << COMPRESSION_SHIFT;
  let payload: Uint8Array | undefined;
  let metadata: unknown = entry;

  // Read the payload from the declared location only. An entry that declares one whose value
  // is neither text nor bytes keeps it in the metadata, where JSON decides what happens to it.
  const location = entry.payload;
  const value = entry.value;
  const source =
    location === "value"
      ? value
      : location === "value.body" && typeof value === "object" && value !== null
        ? (value as { body?: unknown }).body
        : undefined;

  if (typeof source === "string") {
    payload = utf8Encoder.encode(source);
    flags = FLAG_PAYLOAD;
  } else if (ArrayBuffer.isView(source)) {
    payload = toBytes(source);
    flags = FLAG_PAYLOAD | FLAG_PAYLOAD_BYTES;
  }

  if (payload) {
    // `JSON.stringify` drops an `undefined` member, so this removes the payload rather than
    // storing it twice. `payload` itself stays: the read side needs the location back.
    metadata =
      location === "value"
        ? { ...entry, value: undefined }
        : { ...entry, value: { ...(value as object), body: undefined } };
  }

  const header = utf8Encoder.encode(JSON.stringify(metadata));
  const frame = new Uint8Array(FRAME_HEADER_BYTES + header.length + (payload?.length ?? 0));
  frame[0] = FRAME_MAGIC_0;
  frame[1] = FRAME_MAGIC_1;
  frame[2] = FRAME_VERSION;
  frame[3] = flags;
  new DataView(frame.buffer).setUint32(4, header.length);
  frame.set(header, FRAME_HEADER_BYTES);
  if (payload) {
    frame.set(payload, FRAME_HEADER_BYTES + header.length);
  }
  return frame;
}

/** Returns the framed entry, or `null` for anything this build cannot read back. */
function decodeFrame(frame: Uint8Array): CacheEntry | null {
  if (
    frame.length < FRAME_HEADER_BYTES ||
    frame[0] !== FRAME_MAGIC_0 ||
    frame[1] !== FRAME_MAGIC_1 ||
    frame[2] !== FRAME_VERSION
  ) {
    // Not a frame this build wrote. A miss re-resolves; a guess would serve wrong bytes.
    return null;
  }
  const flags = frame[3]!;
  if ((flags & ~ALL_FLAGS) !== 0) {
    return null;
  }
  if ((flags & COMPRESSION_MASK) >> COMPRESSION_SHIFT !== COMPRESSION_NONE) {
    return null;
  }
  const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4);
  const payloadStart = FRAME_HEADER_BYTES + headerLength;
  if (payloadStart > frame.length) {
    return null;
  }

  try {
    const entry = JSON.parse(
      utf8Decoder.decode(frame.subarray(FRAME_HEADER_BYTES, payloadStart)),
    ) as CacheEntry;
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    if (!(flags & FLAG_PAYLOAD)) {
      return entry;
    }
    const bytes = frame.subarray(payloadStart);
    const payload = flags & FLAG_PAYLOAD_BYTES ? bytes : utf8Decoder.decode(bytes);
    if (entry.payload === "value") {
      entry.value = payload;
    } else if (
      entry.payload === "value.body" &&
      typeof entry.value === "object" &&
      entry.value !== null
    ) {
      (entry.value as { body?: unknown }).body = payload;
    } else {
      // A payload with nowhere to go. Nothing can rebuild the entry it belongs to.
      return null;
    }
    return entry;
  } catch {
    // Corrupt metadata or a payload that is not the UTF-8 it was written as.
    return null;
  }
}

/**
 * A storage instance or a late-bound storage factory.
 *
 * The cache calls a factory once, on the first cache operation.
 */
export type StorageOption = StorageInterface | (() => StorageInterface);

// The first options object selects storage.
// Write the resolved instance to every options object for later purge operations.
export function resolveStorage(
  ...optsList: Array<{ storage?: StorageOption } | undefined>
): StorageInterface {
  const configured = optsList[0]?.storage;
  const resolved = typeof configured === "function" ? configured() : configured;
  const storage = resolved ?? createMemoryStorage();
  for (const opts of optsList) {
    if (opts) {
      opts.storage = storage;
    }
  }
  return storage;
}
