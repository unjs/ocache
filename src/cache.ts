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

/**
 * Wraps a function with caching support including TTL, SWR, integrity checks, and request deduplication.
 *
 * @param fn - The function to cache.
 * @param opts - Cache configuration options.
 * @returns A new async function that returns cached results when available.
 */
export function defineCachedFunction<T, ArgsT extends unknown[] = any[]>(
  fn: (...args: ArgsT) => T | Promise<T>,
  opts: CacheOptions<T, ArgsT> = {},
): (...args: ArgsT) => Promise<T> {
  opts = { ...defaultCacheOptions(), ...opts };

  const pending: { [key: string]: Promise<T> } = {};

  // Normalize cache params
  const group = opts.group || "ocache/functions";
  const name = opts.name || fn.name || "_";
  const integrity = opts.integrity || hash([fn, opts]);
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
    const cacheKey = [opts.base, group, name, key + ".json"]
      .filter(Boolean)
      .join(":")
      .replace(/:\/$/, ":index");

    let entry: CacheEntry<T> =
      ((await Promise.resolve(useStorage().get(cacheKey)).catch((error) => {
        _onError("[cache] Cache read error.", error);
      })) as CacheEntry<T>) || {};

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

    const expired =
      shouldInvalidateCache ||
      entry.integrity !== integrity ||
      ttl === 0 ||
      Date.now() - (entry.mtime || 0) > ttl ||
      validate(entry) === false;

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
          if (opts.maxAge != null && opts.maxAge > 0 && !opts.swr /* TODO: respect staleMaxAge */) {
            setOpts = { ttl: opts.maxAge };
          }
          const promise = Promise.resolve(useStorage().set(cacheKey, entry, setOpts)).catch(
            (error) => {
              _onError("[cache] Cache write error.", error);
            },
          );
          if ((event?.req as any)?.waitUntil) {
            (event!.req as any).waitUntil(promise);
          }
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

  return async (...args) => {
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
}

/** Alias for {@link defineCachedFunction}. */
export const cachedFunction = defineCachedFunction;

// --- Internal helpers ---

function isHTTPEvent(input: unknown): input is HTTPEvent {
  return (input as any)?.req instanceof Request;
}

function getKey(...args: unknown[]) {
  return args.length > 0 ? hash(args) : "";
}
