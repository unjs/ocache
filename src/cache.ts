import { hash } from "ohash";
import { useStorage } from "./storage.ts";

import type { HTTPEvent, CacheEntry, CacheOptions } from "./types.ts";

function defaultCacheOptions() {
  return {
    name: "_",
    base: "/cache",
    swr: true,
    maxAge: 1,
  } as const;
}

type ResolvedCacheEntry<T> = CacheEntry<T> & { value: T };

export type CachedFunction<T, ArgsT extends unknown[]> = {
  (...args: ArgsT): Promise<T>;
  /** Resolves all storage keys (one per base prefix) for the given arguments. */
  resolveKeys: (...args: ArgsT) => Promise<string[]>;
  /** Invalidates (removes) cached entries for the given arguments across all base prefixes. */
  invalidate: (...args: ArgsT) => Promise<void>;
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
    try {
      // Multi-tier read: try each base prefix in order, use first hit
      for (const base of bases) {
        const result = (await useStorage().get(
          _buildCacheKey(key, { group, name }, base),
        )) as CacheEntry<T> | null;
        if (result) {
          entry = result;
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
    }

    const ttl = (opts.maxAge ?? 0) * 1000;
    if (ttl > 0) {
      entry.expires = Date.now() + ttl;
    }

    const staleTtl =
      opts.swr && opts.staleMaxAge != null && opts.staleMaxAge >= 0
        ? opts.staleMaxAge * 1000
        : undefined;

    // When staleMaxAge is set, an entry is completely dead after maxAge + staleMaxAge
    const isFullyExpired =
      staleTtl !== undefined && ttl > 0 && Date.now() - (entry.mtime || 0) > ttl + staleTtl;

    const expired =
      shouldInvalidateCache ||
      entry.integrity !== integrity ||
      opts.maxAge === 0 ||
      (ttl > 0 && Date.now() - (entry.mtime || 0) > ttl) ||
      validate(entry) === false;

    // If fully expired beyond staleMaxAge, clear the stale value so SWR won't serve it
    if (isFullyExpired) {
      entry.value = undefined;
      entry.integrity = undefined;
      entry.mtime = undefined;
      entry.expires = undefined;
    }

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
          _evictFromStorage(key, bases, group, name);
        }
        // Re-throw error to make sure the caller knows the task failed.
        throw error;
      }

      if (!isPending) {
        // Update mtime, integrity + validate and set the value in cache only the first time the request is made.
        entry.mtime = Date.now();
        entry.integrity = integrity;
        delete pending[key];
        if (validate(entry) !== false) {
          let setOpts: { ttl?: number } | undefined;
          if (opts.maxAge != null && opts.maxAge > 0) {
            if (opts.swr) {
              // With SWR, storage TTL must cover maxAge + staleMaxAge window
              if (opts.staleMaxAge != null && opts.staleMaxAge >= 0) {
                setOpts = { ttl: opts.maxAge + opts.staleMaxAge };
              }
              // If staleMaxAge is not set, no storage TTL (entry lives until manually evicted)
            } else {
              setOpts = { ttl: opts.maxAge };
            }
          }
          const promise = (async () => {
            try {
              // Multi-tier write: write to all base prefixes
              await Promise.all(
                bases.map((b) =>
                  useStorage().set(_buildCacheKey(key, { group, name }, b), entry, setOpts),
                ),
              );
            } catch (error) {
              _onError("[cache] Cache write error.", error);
            }
          })();
          if ((event?.req as any)?.waitUntil) {
            (event!.req as any).waitUntil(promise);
          }
        } else {
          // Revalidation produced an invalid result — evict stale entry from storage
          _evictFromStorage(key, bases, group, name);
        }
      }
    };

    const _resolvePromise = expired ? _resolve() : Promise.resolve();

    if (entry.value === undefined) {
      await _resolvePromise;
    } else if (expired && (event?.req as any)?.waitUntil) {
      (event!.req as any).waitUntil(_resolvePromise);
    }

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

// --- Internal helpers ---

function isHTTPEvent(input: unknown): input is HTTPEvent {
  return (input as any)?.req instanceof Request;
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

function _evictFromStorage(key: string, bases: string[], group: string, name: string) {
  for (const b of bases) {
    useStorage().set(_buildCacheKey(key, { group, name }, b), null);
  }
}

/** Strips storage-location fields from opts so integrity only reflects the cached computation. */
function _integrityOpts(opts: CacheOptions): Omit<CacheOptions, "base" | "group" | "name"> {
  const { base: _, group: _g, name: _n, ...rest } = opts;
  return rest;
}
