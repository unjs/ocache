export interface StorageInterface {
  get<T = unknown>(key: string): T | null | Promise<T | null>;
  set<T = unknown>(key: string, value: T, opts?: { ttl?: number }): void | Promise<void>;
}

/** Default entry ceiling for the built-in memory storage before LRU eviction kicks in. */
const DEFAULT_MEMORY_MAX_SIZE = 10_000;

/** Default byte ceiling (100 MB of estimated retained bytes) before LRU eviction kicks in. */
const DEFAULT_MEMORY_MAX_BYTES = 100 * 1024 * 1024;

export interface MemoryStorageOptions {
  /**
   * Maximum number of entries to keep. When exceeded, the least-recently-used
   * entries are evicted. Defaults to `10 000`. Pass `Infinity` (or `0`) to
   * disable the ceiling and grow unbounded.
   *
   * This bounds entry **count**, never memory — the retained bytes are
   * `maxSize × whatever an entry weighs`, which for cached HTTP responses is
   * attacker-influenced. {@link maxBytes} is the memory bound.
   */
  maxSize?: number;

  /**
   * Maximum total **estimated bytes** to keep, the key's own weight included.
   * When exceeded, least-recently-used entries are evicted until the total is
   * back under it. Defaults to `100 MB`. Pass `Infinity` (or `0`) to disable the
   * budget and grow unbounded.
   *
   * An entry that alone exceeds the budget is **not stored** (and any previous
   * value under its key is dropped), rather than flushing the whole cache for
   * something that still would not fit.
   */
  maxBytes?: number;

  /**
   * Per-entry byte estimate, replacing the built-in one. Returns the **whole**
   * charge for the entry — the key included; nothing is added on top. Only called
   * when {@link maxBytes} is armed. A throwing hook, or a result that is not a
   * finite non-negative number, falls back to the built-in estimate.
   */
  sizeOf?: (value: unknown, key: string) => number;
}

/** Creates an in-memory storage backed by a `Map` with optional TTL support (in seconds) and LRU eviction. */
export function createMemoryStorage(opts: MemoryStorageOptions = {}): StorageInterface {
  const rawMaxSize = opts.maxSize ?? DEFAULT_MEMORY_MAX_SIZE;
  const rawMaxBytes = opts.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES;
  // A finite positive ceiling enables LRU eviction; Infinity / 0 / negative disable it.
  const maxSize = Number.isFinite(rawMaxSize) && rawMaxSize > 0 ? rawMaxSize : undefined;
  const maxBytes = Number.isFinite(rawMaxBytes) && rawMaxBytes > 0 ? rawMaxBytes : undefined;
  const sizeOf = opts.sizeOf;
  const map = new Map<string, { value: unknown; expires?: number; bytes: number }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Running total of every live entry's `bytes`. Kept incrementally because recomputing it
  // would be O(cache) per write — which means *every* path that removes an entry has to go
  // through `deleteEntry`, and the only path that adds one is the single `map.set` below.
  // A leaked count is worse than no budget at all: it converges on evicting everything.
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
    get(key) {
      const entry = map.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expires && Date.now() > entry.expires) {
        deleteEntry(key);
        return null;
      }
      // Mark as most-recently-used by reinserting (Map preserves insertion order). Raw map
      // operations on purpose: the entry object — and with it its byte charge — is preserved,
      // so this is a move, not a delete followed by an insert.
      if (maxSize || maxBytes) {
        map.delete(key);
        map.set(key, entry);
      }
      return entry.value as any;
    },
    set(key, value, opts) {
      // Every branch below either replaces or removes the key, so drop the previous entry
      // first: it releases its bytes and its TTL timer, and reinsertion then lands the key in
      // the most-recent position.
      deleteEntry(key);
      if (value === null || value === undefined) {
        return;
      }
      // The estimate is only ever needed to police a budget, so an opted-out storage never
      // pays for it (nor calls a user `sizeOf`).
      const bytes = maxBytes ? entryBytes(key, value, sizeOf) : 0;
      if (maxBytes && bytes > maxBytes) {
        // A single entry over the whole budget is refused rather than stored: storing it would
        // leave the cache permanently over its ceiling, and evicting down to fit it would flush
        // every other entry for something that still would not fit — one oversized response
        // wiping the hot set is the cache-flush DoS with extra steps. The previous value under
        // this key is gone (deleted above): `set` was asked to replace it, and serving the old
        // one afterwards would be a lie about what is cached. Callers who cache a few very large
        // values should raise `maxBytes`; the read simply misses and re-resolves.
        return;
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
        // Allow the process to exit even if timers are pending
        if (timer && typeof timer === "object" && "unref" in timer) {
          timer.unref();
        }
        timers.set(key, timer);
      }
      // Evict least-recently-used entries once over either ceiling. Both are checked in one
      // loop so the map ends up under *both*; `map.keys()` is insertion-ordered, i.e. oldest
      // first. The empty-map guard is what makes termination unconditional.
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

// Bookkeeping charged on top of the walked payload — per entry (Map node, entry object, timer
// slot) and per property/slot — plus the depth at which the walk stops (`CacheEntry<ResponseCacheEntry>`
// needs 3). Deliberately `//`, not JSDoc: internals stay out of the generated API docs.
const ENTRY_OVERHEAD = 64;
const PROPERTY_OVERHEAD = 8;
const MAX_ESTIMATE_DEPTH = 8;

// Resolves an entry's byte charge: the user's `sizeOf` if it produced a usable number,
// otherwise the built-in estimate. A hook that throws must not take the write down with it —
// the budget degrades to the built-in estimate, never to "free".
function entryBytes(key: string, value: unknown, sizeOf: MemoryStorageOptions["sizeOf"]): number {
  if (sizeOf) {
    try {
      const size = sizeOf(value, key);
      if (Number.isFinite(size) && size >= 0) {
        return size;
      }
    } catch {
      // fall through to the built-in estimate
    }
  }
  try {
    return estimateBytes(key) + ENTRY_OVERHEAD + estimateValue(value, 0, new Set());
  } catch {
    // Exotic values only: a throwing getter or proxy trap. Charge the part we know.
    return estimateBytes(key) + ENTRY_OVERHEAD;
  }
}

// Strings are charged at 2 bytes per UTF-16 code unit. That is the *upper* bound — engines
// store latin1-only strings at one byte per character, so an ASCII body is over-charged by up
// to 2× — and over-charging is the only safe direction here: a budget that under-counts is not
// a bound, which is the entire failing this exists to fix (finding 14.1). The key is measured
// the same way; the finding's second measurement (10 000 × 8 KB attacker-chosen paths, 296 MB
// RSS) is pure key weight.
function estimateBytes(str: string): number {
  return str.length * 2;
}

// A depth-limited, cycle-safe structural walk. Deliberately not `JSON.stringify(value).length`:
// that throws on cycles and BigInt, silently drops non-JSON values, and allocates a full second
// copy of a body we are measuring precisely *because* it is large. This walk allocates nothing
// beyond the `seen` set and touches each string once, so the dominant real shape —
// `CacheEntry<ResponseCacheEntry>`, whose weight is `value.value.body` plus the header record —
// costs a handful of property reads plus one `.length` per string.
//
// Two bounds keep it total on hostile input: `seen` charges any object once (so a cycle or a
// shared subtree terminates and is not double-counted) and the depth cap keeps recursion off
// the stack limit for pathologically deep values, at the price of under-counting below it —
// that is what `sizeOf` is for.
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
      // undefined, symbol, function: no retained payload worth counting.
      return 0;
    }
  }
  if (value === null || seen.has(value) || depth >= MAX_ESTIMATE_DEPTH) {
    return 0;
  }
  seen.add(value);
  // Binary payloads: the byte length *is* the weight, and walking their indices would be both
  // O(n) property reads and wildly wrong.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return value.byteLength;
  }
  const next = depth + 1;
  let total = 0;
  // Array/Set iterate as values, Map as pairs: their payload lives outside own properties,
  // where `Object.keys` would price them at zero — the dangerous direction.
  if (Array.isArray(value) || value instanceof Set) {
    for (const item of value as Iterable<unknown>) {
      total += PROPERTY_OVERHEAD + estimateValue(item, next, seen);
    }
  } else if (value instanceof Map) {
    for (const [k, v] of value) {
      total += PROPERTY_OVERHEAD + estimateValue(k, next, seen) + estimateValue(v, next, seen);
    }
  } else {
    // Plain objects and class instances alike: own enumerable properties.
    for (const key of Object.keys(value)) {
      total +=
        PROPERTY_OVERHEAD +
        estimateBytes(key) +
        estimateValue((value as Record<string, unknown>)[key], next, seen);
    }
  }
  return total;
}

function clearTimer(timers: Map<string, ReturnType<typeof setTimeout>>, key: string) {
  const existing = timers.get(key);
  if (existing !== undefined) {
    clearTimeout(existing);
    timers.delete(key);
  }
}

/**
 * Where a cached function/handler persists its entries: a ready {@link StorageInterface},
 * or a factory returning one.
 *
 * The factory form exists for **late binding** — handlers are typically defined at module
 * load while the real backend (Redis, KV, ...) only exists once the server has started.
 * It is called on the first actual cache read/write, never at definition time, and at
 * most once per cached function/handler.
 */
export type StorageOption = StorageInterface | (() => StorageInterface);

// Resolves `opts.storage` into a concrete backend, memoizing it back into every options
// object passed. `optsList[0]` is the source of truth and must be the one stable object per
// cached function/handler instance; the rest are mirrors (internal clones of it).
//
// There is deliberately no ambient storage to fall back on. The removed `setStorage()`
// singleton meant the *last* call won for every consumer in the process — including
// unrelated `defineCachedFunction` callers who never asked for it — which is how two
// independent apps, each constructing its own handler and its own storage, ended up sharing
// one backend and serving each other's cached response bodies (h3#1524 audit, finding #2).
// So an unset `storage` yields a *fresh* memory storage per cached function/handler:
// colliding by accident is now impossible, and callers who want a shared cache pass the
// same `storage` explicitly.
//
// The write-back is what lets the standalone `resolveCacheKeys` / `invalidateCache` /
// `expireCache` helpers reach the same store as the cached function — hand them the same
// options object and they see the memoized instance. Same mechanism (and same caveat) as
// the resolved `name`. It also guarantees a factory runs at most once.
//
// Internal (deliberately not a JSDoc block: it must stay out of the generated API docs).
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
