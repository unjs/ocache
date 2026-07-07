import { hash } from "ohash";
import { useStorage } from "./storage.ts";

import type { HTTPEvent, CacheEntry, CacheOptions, CacheStatus } from "./types.ts";

function defaultCacheOptions() {
  return {
    name: "_",
    base: "/cache",
    swr: true,
    maxAge: 1,
  } as const;
}

type ResolvedCacheEntry<T> = CacheEntry<T> & { value: T; status: CacheStatus };

export type CachedFunction<T, ArgsT extends unknown[]> = {
  (...args: ArgsT): Promise<T>;
  /** Resolves all storage keys (one per base prefix) for the given arguments. */
  resolveKeys: (...args: ArgsT) => Promise<string[]>;
  /** Invalidates (removes) cached entries for the given arguments across all base prefixes. */
  invalidate: (...args: ArgsT) => Promise<void>;
  /** Marks cached entries as stale across all base prefixes. With SWR, stale values are still served (within `staleMaxAge`) while the next access triggers a background refresh. */
  expire: (...args: ArgsT) => Promise<void>;
};

/**
 * Wraps a function with caching support including TTL, SWR, integrity checks, and request deduplication.
 *
 * @param fn - The function to cache.
 * @param opts - Cache configuration options.
 * @returns A cached function with a `.resolveKey(...args)` method for cache key resolution.
 */
export function defineCachedFunction<T, ArgsT extends unknown[] = any[]>(
  fn: (...args: ArgsT) => T | Promise<T>,
  opts: CacheOptions<T, ArgsT> = {},
): CachedFunction<T, ArgsT> {
  opts = { ...defaultCacheOptions(), ...opts };

  const pending: { [key: string]: Promise<T> } = {};

  // Normalize cache params
  const group = opts.group || "functions";
  const name = opts.name || fn.name || "_";
  const integrity = opts.integrity || hash([fn, _integrityOpts(opts)]);
  const validate = opts.validate || ((entry) => entry.value !== undefined);
  const _onError = (context: string, error: unknown) => {
    if (opts.onError) {
      opts.onError(error);
    } else {
      console.error(context, error);
    }
  };

  async function get(
    key: string,
    resolver: () => T | Promise<T>,
    shouldInvalidateCache?: boolean,
    event?: HTTPEvent,
  ): Promise<ResolvedCacheEntry<T>> {
    // Use extension for key to avoid conflicting with parent namespace (foo/bar and foo/bar/baz)
    const bases = _normalizeBases(opts.base);

    let entry: CacheEntry<T> = {} as CacheEntry<T>;
    // Index of the base that had a cache hit (-1 = miss on all tiers)
    let hitIndex = -1;
    try {
      // Multi-tier read: try each base prefix in order, use first hit
      for (let i = 0; i < bases.length; i++) {
        const result = (await useStorage().get(
          _buildCacheKey(key, { group, name }, bases[i]!),
        )) as CacheEntry<T> | null;
        if (result) {
          entry = result;
          hitIndex = i;
          break;
        }
      }
    } catch (error) {
      _onError("[cache] Cache read error.", error);
    }

    // https://github.com/nitrojs/nitro/issues/2160
    if (typeof entry !== "object") {
      entry = {};
      const error = new Error("Malformed data read from cache.");
      _onError("[cache]", error);
    } else {
      // Work on a per-call shallow clone: a storage backend may return the entry by
      // reference (the built-in memory storage does), so all subsequent in-place
      // mutations below — freshness resets, the `status` attach, the SWR value
      // refresh — must not corrupt the object still held in storage or let
      // concurrent same-key calls overwrite each other's per-call fields.
      entry = { ...entry };
    }

    // Per-entry TTL (set by the `getMaxAge` hook on the previous write) takes precedence over static options.
    const readMaxAge = entry.maxAge ?? opts.maxAge;
    const readStaleMaxAge = entry.staleMaxAge ?? opts.staleMaxAge;

    const ttl = (readMaxAge ?? 0) * 1000;
    if (ttl > 0) {
      entry.expires = Date.now() + ttl;
    }

    const staleTtl =
      opts.swr && readStaleMaxAge != null && readStaleMaxAge >= 0
        ? readStaleMaxAge * 1000
        : undefined;

    // When staleMaxAge is set, an entry is completely dead after maxAge + staleMaxAge
    const isFullyExpired =
      staleTtl !== undefined && ttl > 0 && Date.now() - (entry.mtime || 0) > ttl + staleTtl;

    // Computed once and reused for both the `expired` check and the `status`
    // decision below (same entry state, so re-validating would just repeat work).
    const _isValid = validate(entry) !== false;

    const expired =
      shouldInvalidateCache ||
      entry.stale === true ||
      entry.integrity !== integrity ||
      readMaxAge === 0 ||
      (ttl > 0 && Date.now() - (entry.mtime || 0) > ttl) ||
      !_isValid;

    // If fully expired beyond staleMaxAge, clear the stale value so SWR won't serve it
    if (isFullyExpired) {
      entry.value = undefined;
      entry.integrity = undefined;
      entry.mtime = undefined;
      entry.expires = undefined;
    }

    // Determine how this call will be served (mirrors the serve decision below):
    // - no usable cached value -> resolved fresh (miss)
    // - fresh cached value -> hit
    // - expired but served stale under SWR -> stale
    // - a prior value existed but was expired/invalid and re-resolved in the
    //   foreground (no stale served) -> revalidated
    const status: CacheStatus =
      entry.value === undefined
        ? "miss"
        : !expired
          ? "hit"
          : opts.swr && _isValid
            ? "stale"
            : "revalidated";

    const _resolve = async () => {
      const isPending = pending[key];
      if (!isPending) {
        if (entry.value !== undefined && (opts.staleMaxAge || 0) >= 0 && opts.swr === false) {
          // Remove cached entry to prevent using expired cache on concurrent requests
          entry.value = undefined;
          entry.integrity = undefined;
          entry.mtime = undefined;
          entry.expires = undefined;
        }
        pending[key] = Promise.resolve(resolver());
      }

      try {
        entry.value = await pending[key];
      } catch (error) {
        // Make sure entries that reject get removed.
        if (!isPending) {
          delete pending[key];
          // Evict stale entry from storage so SWR doesn't keep serving it
          const evictPromise = _evictFromStorage(key, bases, group, name).catch((error) => {
            _onError("[cache] Cache eviction error.", error);
          });
          event?.req.waitUntil?.(evictPromise);
        }
        // Re-throw error to make sure the caller knows the task failed.
        throw error;
      }

      if (isPending && opts.isShareable?.(entry) === false) {
        // This call was coalesced onto another request's in-flight resolution, but the
        // resolved value must not be shared with concurrent callers (e.g. a
        // `Cache-Control: private` / `no-store` response). Re-resolve independently so one
        // caller's private response never bleeds to another. The result is never stored
        // (only the leader, `!isPending`, writes to the cache).
        entry.value = await resolver();
      }

      if (!isPending) {
        // Update mtime, integrity + validate and set the value in cache only the first time the request is made.
        entry.mtime = Date.now();
        entry.integrity = integrity;
        entry.stale = undefined;
        delete pending[key];
        // Derive per-entry lifetime from the resolved value, overriding static options for this write.
        if (opts.getMaxAge) {
          try {
            const resolved = await opts.getMaxAge(entry);
            // A bare number is shorthand for `{ maxAge }`.
            const dynamic = typeof resolved === "number" ? { maxAge: resolved } : resolved;
            // Clamp to a non-negative TTL: a value <= 0 means "don't cache" (re-resolve every
            // access), never "cache forever as fresh". Non-finite (NaN) falls back to static options.
            entry.maxAge = _clampTtl(dynamic?.maxAge);
            entry.staleMaxAge = _clampTtl(dynamic?.staleMaxAge);
          } catch (error) {
            _onError("[cache] getMaxAge hook error.", error);
          }
        }
        if (validate(entry) !== false) {
          // Per-entry TTL (from the `getMaxAge` hook) falls back to static options when not provided.
          const writeMaxAge = entry.maxAge ?? opts.maxAge;
          const writeStaleMaxAge = entry.staleMaxAge ?? opts.staleMaxAge;
          let setOpts: { ttl?: number } | undefined;
          if (writeMaxAge != null && writeMaxAge > 0) {
            if (opts.swr) {
              // With SWR, storage TTL must cover maxAge + staleMaxAge window
              if (writeStaleMaxAge != null && writeStaleMaxAge >= 0) {
                setOpts = { ttl: writeMaxAge + writeStaleMaxAge };
              }
              // If staleMaxAge is not set, no storage TTL (entry lives until manually evicted)
            } else {
              setOpts = { ttl: writeMaxAge };
            }
          }
          // Multi-tier write: only write to tiers up to the one that matched.
          // If no tier had a hit (hitIndex === -1), write to all tiers.
          // If tier N matched, write to tiers 0..N (promote upward + refresh hit tier).
          const writeBases = hitIndex < 0 ? bases : bases.slice(0, hitIndex + 1);
          // `status` is a per-call field — never persist it to storage.
          const { status: _status, ...toStore } = entry;
          const promise = (async () => {
            try {
              await Promise.all(
                writeBases.map((b) =>
                  useStorage().set(_buildCacheKey(key, { group, name }, b), toStore, setOpts),
                ),
              );
            } catch (error) {
              _onError("[cache] Cache write error.", error);
            }
          })();
          event?.req.waitUntil?.(promise);
        } else {
          // Revalidation produced an invalid result — evict stale entry from storage
          const evictPromise = _evictFromStorage(key, bases, group, name).catch((error) => {
            _onError("[cache] Cache eviction error.", error);
          });
          event?.req.waitUntil?.(evictPromise);
        }
      }
    };

    const _resolvePromise = expired ? _resolve() : Promise.resolve();

    if (entry.value === undefined) {
      await _resolvePromise;
    } else if (expired) {
      event?.req.waitUntil?.(_resolvePromise);
    }

    // Attach the per-call `status` to `entry`. `entry` is a per-call clone (see the
    // read path above), never the object a ref-sharing storage backend still holds,
    // so this can't corrupt shared state or race with concurrent same-key calls. It's
    // still marked NON-ENUMERABLE as defence-in-depth so it stays out of every
    // persistence path (object spreads, JSON/structuredClone). Attaching to the live
    // clone (rather than a fresh return-time copy) means a synchronous SWR
    // revalidation that updates `entry.value` in a microtask is reflected in the
    // returned value.
    Object.defineProperty(entry, "status", {
      value: status,
      enumerable: false,
      writable: true,
      configurable: true,
    });

    if (opts.swr && validate(entry) !== false) {
      _resolvePromise.catch((error) => {
        _onError("[cache] SWR handler error.", error);
      });
      return entry as ResolvedCacheEntry<T>;
    }

    return _resolvePromise.then(() => entry) as Promise<ResolvedCacheEntry<T>>;
  }

  const cachedFn = async (...args: ArgsT) => {
    const shouldBypassCache = await opts.shouldBypassCache?.(...args);
    if (shouldBypassCache) {
      return fn(...args);
    }
    const key = await (opts.getKey || getKey)(...args);
    const shouldInvalidateCache = await opts.shouldInvalidateCache?.(...args);
    const entry = await get(
      key,
      () => fn(...args),
      shouldInvalidateCache,
      isHTTPEvent(args[0]) ? args[0] : undefined,
    );
    let value = entry.value;
    if (opts.transform) {
      value = (await opts.transform(entry, ...args)) || value;
    }
    return value;
  };

  cachedFn.resolveKeys = (...args: ArgsT) => resolveCacheKeys({ options: opts, args });
  cachedFn.invalidate = (...args: ArgsT) => invalidateCache({ options: opts, args });
  cachedFn.expire = (...args: ArgsT) => expireCache({ options: opts, args });

  return cachedFn;
}

/** Alias for {@link defineCachedFunction}. */
export const cachedFunction = defineCachedFunction;

// --- Public helpers ---

/**
 * Resolves all cache storage keys (one per base prefix) for given arguments and cache options.
 *
 * Uses the same key derivation as `defineCachedFunction` internally:
 * - When `opts.getKey` is provided, it is called with `args` to produce the key segment.
 * - Otherwise, `args` are hashed with `ohash` (same default as `defineCachedFunction`).
 *
 * Pass the same `getKey`, `name`, `group`, and `base` options you use in
 * `defineCachedFunction` / `defineCachedHandler` to get the exact storage keys.
 *
 * @param input - Object with `options` (cache options) and optional `args` (function arguments).
 * @returns An array of storage key strings (one per base prefix).
 *
 * @example
 * ```ts
 * const keys = await resolveCacheKeys({
 *   options: { name: "fetchUser", getKey: (id: string) => id },
 *   args: ["user-123"],
 * });
 * for (const key of keys) {
 *   await useStorage().set(key, null); // invalidate all tiers
 * }
 * ```
 */
export async function resolveCacheKeys<ArgsT extends unknown[] = any[]>(
  input: {
    options?: Pick<CacheOptions<any, ArgsT>, "base" | "group" | "name" | "getKey">;
    args?: ArgsT;
  } = {},
): Promise<string[]> {
  const opts = input.options ?? {};
  const args = input.args ?? ([] as unknown as ArgsT);
  const key = await (opts.getKey || getKey)(...args);
  return _normalizeBases(opts.base).map((base) => _buildCacheKey(key, opts, base));
}

/**
 * Invalidates (removes) cached entries for given arguments and cache options across all base prefixes.
 *
 * Uses the same key derivation as `defineCachedFunction` / `resolveCacheKeys`.
 *
 * @param input - Object with `options` (cache options) and optional `args` (function arguments).
 *
 * @example
 * ```ts
 * // Invalidate a specific cached entry
 * await invalidateCache({
 *   options: { name: "fetchUser", getKey: (id: string) => id },
 *   args: ["user-123"],
 * });
 * ```
 */
export async function invalidateCache<ArgsT extends unknown[] = any[]>(
  input: {
    options?: Pick<CacheOptions<any, ArgsT>, "base" | "group" | "name" | "getKey">;
    args?: ArgsT;
  } = {},
): Promise<void> {
  const keys = await resolveCacheKeys(input);
  const storage = useStorage();
  await Promise.all(keys.map((key) => storage.set(key, null)));
}

/**
 * Expires cached entries for given arguments and cache options across all base prefixes,
 * without removing them.
 *
 * Unlike {@link invalidateCache} (which removes entries entirely), expired entries keep
 * serving the stale value with SWR — still bounded by the originally configured
 * `staleMaxAge` window — while the next access triggers a background refresh.
 * Without SWR, the next call re-resolves before returning.
 *
 * Uses the same key derivation as `defineCachedFunction` / `resolveCacheKeys`.
 * Pass the same `maxAge` / `swr` / `staleMaxAge` options you cache with so the
 * remaining storage TTL is preserved.
 *
 * @param input - Object with `options` (cache options) and optional `args` (function arguments).
 *
 * @example
 * ```ts
 * // Mark a cached entry for background refresh on next access
 * await expireCache({
 *   options: { name: "fetchUser", getKey: (id: string) => id, maxAge: 60, staleMaxAge: 300 },
 *   args: ["user-123"],
 * });
 * ```
 */
export async function expireCache<ArgsT extends unknown[] = any[]>(
  input: {
    options?: Pick<
      CacheOptions<any, ArgsT>,
      "base" | "group" | "name" | "getKey" | "maxAge" | "swr" | "staleMaxAge"
    >;
    args?: ArgsT;
  } = {},
): Promise<void> {
  const opts = input.options ?? {};
  const keys = await resolveCacheKeys(input);
  const storage = useStorage();
  await Promise.all(
    keys.map(async (key) => {
      const entry = (await storage.get(key)) as CacheEntry | null;
      if (!entry || typeof entry !== "object" || entry.value === undefined) {
        return;
      }
      await storage.set(key, { ...entry, stale: true }, _remainingTtl(entry, opts));
    }),
  );
}

// --- Internal helpers ---

function isHTTPEvent(input: unknown): input is HTTPEvent {
  return (input as any)?.req instanceof Request;
}

/** Normalizes a dynamic TTL: clamps negatives to 0, treats nullish/non-finite as "unset" (static fallback). */
function _clampTtl(value: number | undefined): number | undefined {
  return value == null || !Number.isFinite(value) ? undefined : Math.max(0, value);
}

function getKey(...args: unknown[]) {
  return args.length > 0 ? hash(args) : "";
}

function _buildCacheKey(
  key: string,
  opts: Pick<CacheOptions, "group" | "name">,
  base: string,
): string {
  const group = opts.group || "functions";
  const name = opts.name || "_";
  return [base, group, name, key + ".json"].filter(Boolean).join(":").replace(/:\/$/, ":index");
}

function _normalizeBases(base: CacheOptions["base"]): [string, ...string[]] {
  if (Array.isArray(base)) return base as [string, ...string[]];
  return [base ?? "/cache"];
}

async function _evictFromStorage(key: string, bases: string[], group: string, name: string) {
  await Promise.all(
    bases.map((b) => useStorage().set(_buildCacheKey(key, { group, name }, b), null)),
  );
}

/** Computes remaining storage TTL (seconds) so expiring an entry doesn't extend its original lifetime. */
function _remainingTtl(
  entry: CacheEntry,
  opts: Pick<CacheOptions, "maxAge" | "swr" | "staleMaxAge">,
): { ttl: number } | undefined {
  // Prefer the per-entry TTL persisted by `getMaxAge`, falling back to static options.
  const maxAge = entry.maxAge ?? opts.maxAge;
  const staleMaxAge = entry.staleMaxAge ?? opts.staleMaxAge;
  if (!entry.mtime || maxAge == null || maxAge <= 0) {
    return undefined;
  }
  // Mirrors the TTL window used on cache writes (see `get` in defineCachedFunction)
  const ttlWindow =
    opts.swr === false
      ? maxAge
      : staleMaxAge != null && staleMaxAge >= 0
        ? maxAge + staleMaxAge
        : undefined;
  if (ttlWindow === undefined) {
    return undefined;
  }
  return { ttl: Math.max(Math.ceil((entry.mtime + ttlWindow * 1000 - Date.now()) / 1000), 1) };
}

/** Strips storage-location fields from opts so integrity only reflects the cached computation. */
function _integrityOpts(opts: CacheOptions): Omit<CacheOptions, "base" | "group" | "name"> {
  const { base: _, group: _g, name: _n, ...rest } = opts;
  return rest;
}
