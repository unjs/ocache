// Docs: @docs/2.functions.md, @docs/3.storage.md, @docs/5.handler.md, @docs/6.query-params.md, @docs/7.cookies.md, @docs/8.cache-control.md, @docs/9.isr.md, @docs/10.api.md

import type { StorageOption } from "./storage.ts";

/** Request with the srvx-compatible `waitUntil` background task hook. */
export interface ServerRequest extends Request {
  waitUntil?: (promise: Promise<any>) => void;
}

/** Minimal HTTP event accepted by cached handlers. */
export interface HTTPEvent {
  req: ServerRequest;

  /** Parsed URL. Defaults to `new URL(req.url)`. */
  url?: URL;
}

/** Handler that receives an HTTP event. */
export type EventHandler<E extends HTTPEvent = HTTPEvent> = (
  event: E,
) => unknown | Promise<unknown>;

/**
 * Cached handler with resource-level cache management methods.
 *
 * Each method covers GET and HEAD variants in every base prefix.
 */
export type CachedEventHandler<E extends HTTPEvent = HTTPEvent> = EventHandler<E> & {
  /** Returns all resource keys, with the event's method first. */
  resolveKeys: (event: E) => Promise<string[]>;
  /** Removes all entries for the event's resource. */
  invalidate: (event: E) => Promise<void>;
  /** Marks all entries for the event's resource as stale. */
  expire: (event: E) => Promise<void>;
};

/**
 * Result of one cache call.
 *
 * - `"hit"`: returned a fresh stored value.
 * - `"stale"`: returned stale data and started background revalidation.
 * - `"revalidated"`: replaced an old value before returning.
 * - `"miss"`: resolved a value when none existed.
 */
export type CacheStatus = "hit" | "stale" | "revalidated" | "miss";

/** Cached value and its metadata. */
export interface CacheEntry<T = any> {
  value?: T;
  /** Expiry time in Unix milliseconds. */
  expires?: number;
  /** Last resolution time in Unix milliseconds. */
  mtime?: number;
  /** Hash of the cached function and computation options. */
  integrity?: string;
  /** Forces revalidation on the next access. */
  stale?: boolean;
  /** Per-entry fresh lifetime in seconds. */
  maxAge?: number;
  /** Per-entry stale lifetime in seconds. */
  staleMaxAge?: number;
  /**
   * Status for the current call.
   * This field is available to `transform` and is not stored.
   */
  status?: CacheStatus;
}

/**
 * Options for cached functions.
 *
 * Explicit `undefined` values use defaults.
 * `null` values remain unchanged.
 */
export interface CacheOptions<T = any, ArgsT extends unknown[] = any[]> {
  /**
   * Cache-key name.
   *
   * Defaults to the function name or an anonymous function source hash.
   * Pass an explicit name for equal-source closures created by factories or loops.
   */
  name?: string;
  /** Returns a cache key from the function arguments. */
  getKey?: (...args: ArgsT) => string | Promise<string>;
  /** Transforms an entry before return. The return value replaces the cached value unless it is `undefined`. */
  transform?: (entry: CacheEntry<T>, ...args: ArgsT) => any;
  /**
   * Converts a resolved value to its stored form.
   *
   * Runs once per resolution after `getMaxAge`.
   * It may safely consume a one-use source shared by deduplicated callers.
   * `validate` receives this stored form on writes and reads.
   *
   * @example
   * ```ts
   * serialize: async (entry) => ({ ...entry.value, body: await streamToString(entry.value.body) }),
   * ```
   */
  serialize?: (entry: CacheEntry<T>, ctx: { args: ArgsT }) => any;
  /**
   * Validates an entry for the current arguments.
   * Return or resolve to `false` to revalidate it.
   */
  validate?: (entry: CacheEntry<T>, ctx: { args: ArgsT }) => boolean | Promise<boolean>;
  /** Return `true` to trigger revalidation. */
  shouldInvalidateCache?: (...args: ArgsT) => boolean | Promise<boolean>;
  /** Return `true` to call the function without cache processing. */
  shouldBypassCache?: (...args: ArgsT) => boolean | Promise<boolean>;
  /** Cache-key group. Defaults to `"functions"`. Escaped like `name`. */
  group?: string;
  /** Integrity value. Defaults to a hash of the function and options. */
  integrity?: any;
  /**
   * Fresh lifetime in seconds. Defaults to `1`.
   * A non-positive lifetime prevents storage.
   */
  maxAge?: number;
  /**
   * Enables stale-while-revalidate. Defaults to `false`.
   *
   * Without {@link staleMaxAge}, stale reuse is limited only by backend eviction.
   */
  swr?: boolean;
  /**
   * Stale lifetime in seconds.
   *
   * `0` requires foreground revalidation.
   * An unset value allows stale reuse until backend eviction.
   */
  staleMaxAge?: number;
  /**
   * Returns per-entry lifetimes after resolution and before storage.
   *
   * A number sets `maxAge`.
   * An object can set `maxAge` and `staleMaxAge`.
   * Returned fields override static options for freshness, storage, and Cache-Control.
   * Non-positive `maxAge` values prevent storage.
   *
   * @example
   * ```ts
   * getMaxAge: (entry) => entry.value?.expires_in,
   * getMaxAge: () => ({ maxAge: 60, staleMaxAge: 300 }),
   * ```
   */
  getMaxAge?: (
    entry: CacheEntry<T>,
  ) =>
    | number
    | { maxAge?: number; staleMaxAge?: number }
    | undefined
    | Promise<number | { maxAge?: number; staleMaxAge?: number } | undefined>;
  /**
   * Deadline for one shared resolution and its hooks, in seconds.
   *
   * Defaults to `30`.
   * Set `Infinity` or `0` to disable the deadline.
   * On timeout, all waiters reject with `TimeoutError` and the old entry is evicted.
   * A handler's `event.req.signal` aborts with that error; a plain resolver receives no
   * signal, so it continues but cannot write its late result.
   */
  maxResolveTime?: number;
  /**
   * Cache-key base prefixes. Defaults to `"/cache"`.
   * Reads stop at the first hit. Misses write every prefix.
   * Revalidation writes the hit prefix and every earlier prefix.
   */
  base?: string | string[];
  /**
   * Storage instance or late-bound factory.
   *
   * Defaults to one memory store per cached function or handler.
   * Pass the same instance to share entries.
   * A factory runs once on the first cache operation.
   * The cache writes the resolved instance back to this options object.
   *
   * @example
   * ```ts
   * const storage = createMemoryStorage();
   * const a = cachedFunction(fnA, { storage });
   * const b = cachedFunction(fnB, { storage });
   * ```
   */
  storage?: StorageOption;
  /** Receives handled cache, hook, and background errors. */
  onError?: (error: unknown) => void;
}

/** Stored HTTP response data. */
export interface ResponseCacheEntry {
  status: number;
  statusText: string | undefined;
  /** Response headers as key-value pairs. */
  headers: Record<string, string>;
  /**
   * Stored response body.
   * Invalid UTF-8 bytes use base64 and set {@link base64}.
   */
  body: string | undefined;
  /** Marks a base64-encoded binary {@link body}. */
  base64?: boolean;
}

/**
 * Values passed to the conditional response hook.
 *
 * The request validators are captured before narrowing, because narrowing forwards
 * only headers the cache key covers and no key covers a validator. Read them here
 * rather than from `event.req`, which no longer carries them.
 */
export interface CacheConditions {
  modifiedTime?: Date;
  maxAge?: number;
  etag?: string;
  /** The request's `If-None-Match`, captured before narrowing. */
  ifNoneMatch?: string;
  /** The request's `If-Modified-Since`, captured before narrowing. */
  ifModifiedSince?: string;
}

/**
 * Options for cached HTTP handlers.
 *
 * Internal hooks serialize and validate Response values.
 * `getMaxAge` may inspect response metadata but must not consume the body.
 */
export interface CachedEventHandlerOptions<E extends HTTPEvent = HTTPEvent> extends Omit<
  CacheOptions<Response, [E]>,
  "transform" | "validate" | "serialize"
> {
  /**
   * Answers conditional requests with 304 without storing responses.
   *
   * The handler always runs, and its own `etag` and `last-modified` are the conditions.
   */
  headersOnly?: boolean;
  /**
   * Request headers that reach the handler, vary the key, and appear in `Vary`.
   *
   * A response with an undeclared Vary name is returned but not stored.
   * Listing Cookie or Authorization keys the complete raw header value.
   * Prefer {@link allowCookies} for a cookie subset.
   */
  varies?: string[] | readonly string[];

  /**
   * Case-sensitive query names that reach the handler and generated key.
   *
   * When unset, the full query varies the key.
   * A custom `getKey` replaces key generation but does not disable URL filtering.
   */
  allowQuery?: string[] | readonly string[];

  /**
   * Case-sensitive cookie names that reach the handler and vary the key.
   *
   * By default, no request cookies reach cacheable handlers.
   * Values select shared representations and must not contain per-user secrets.
   * This option emits `Vary: Cookie`, which can reduce downstream cache hits.
   * Use {@link sendCacheControl} set to `false` for server-only cookie caching.
   * Cacheable responses always remove `Set-Cookie`.
   * This option overrides `varies: ["cookie"]`.
   */
  allowCookies?: string[] | readonly string[];

  /**
   * Allows Authorization and Proxy-Authorization to reach the handler and vary the key.
   *
   * Defaults to `false`, which strips these credentials from cacheable requests.
   * Enabled responses are shared by callers with the same credential value.
   * Bypass caching when responses must not be shared.
   */
  allowAuthorization?: boolean;

  /**
   * Enables generated Cache-Control headers. Defaults to `true`.
   *
   * Set to `false` to suppress ocache's synthesized downstream freshness lifetime.
   * This does not emit `no-store` or prevent downstream storage.
   * Explicit handler Cache-Control headers remain unchanged.
   */
  sendCacheControl?: boolean;

  /**
   * Cache-status response header.
   *
   * `true` uses `X-Cache`, a string sets its name, and `false` disables it.
   * This option has no effect in `headersOnly` mode.
   */
  cacheStatusHeader?: boolean | string;

  /** Converts a handler value to Response. Defaults to the built-in Response conversion. */
  toResponse?: (value: unknown, event: E) => Response | Promise<Response>;

  /**
   * Creates a Response from stored data.
   * The body is text, binary bytes, or `null`.
   * Defaults to `new Response(body, init)`.
   */
  createResponse?: (body: string | Uint8Array | null, init: ResponseInit) => Response;

  /**
   * Largest response body, in bytes, that may be buffered for storage.
   *
   * Defaults to the largest body the storage backend could store, derived from the
   * per-entry ceiling it declares. Memory storage declares its `maxBytes`.
   * A larger response streams through uncached, exactly as a bypassed request does.
   * Set `Infinity` or `0` to buffer every response the backend accepts.
   */
  maxBodySize?: number;

  /** Returns `true` to answer matching conditional headers with 304. */
  handleCacheHeaders?: (event: E, conditions: CacheConditions) => boolean;

  /**
   * Applies an additional cacheability check to serialized responses.
   *
   * This hook can reject but cannot override built-in validation.
   * A rejected fresh response is returned but not stored.
   * It runs on writes and reads, including stale reads.
   * Errors fail closed and reach `onError`.
   *
   * @example
   * ```ts
   * shouldCache: (response) => response.status < 300,
   * ```
   */
  shouldCache?: (entry: ResponseCacheEntry) => boolean | Promise<boolean>;
}
