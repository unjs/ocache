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
