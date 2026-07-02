/**
 * Extended `Request` interface with optional `waitUntil` for background tasks.
 *
 * Compatible with srvx `ServerRequest`.
 */
export interface ServerRequest extends Request {
  waitUntil?: (promise: Promise<any>) => void;
}

/**
 * Minimal HTTP event object containing a request and an optional pre-parsed URL.
 */
export interface HTTPEvent {
  req: ServerRequest;

  /** Pre-parsed URL. Falls back to `new URL(req.url)` when not provided. */
  url?: URL;
}

/**
 * Handler function that receives an {@link HTTPEvent} and returns a response value.
 */
export type EventHandler<E extends HTTPEvent = HTTPEvent> = (
  event: E,
) => unknown | Promise<unknown>;

/**
 * Stored cache entry wrapping a cached value with metadata.
 */
export interface CacheEntry<T = any> {
  /** The cached value. */
  value?: T;
  /** Absolute timestamp (ms) when this entry expires. */
  expires?: number;
  /** Absolute timestamp (ms) when this entry was last resolved. */
  mtime?: number;
  /** Hash used to detect when the cached function or options have changed. */
  integrity?: string;
  /** When `true`, the entry is treated as expired on next access (set by `expireCache`). Cleared after a successful revalidation. */
  stale?: boolean;
}

/**
 * Reason a cache entry was (re)written, passed on `set` {@link CacheEvent}s.
 *
 * - `initial` — first population (no previous value).
 * - `maxAge` — the previous value's TTL (`maxAge`) had elapsed.
 * - `stale` — the entry had been marked stale (e.g. by `expireCache`).
 * - `invalid` — integrity changed or `validate()` rejected the previous value.
 * - `manual` — re-resolved because `shouldInvalidateCache` returned `true`.
 */
export type CacheSetReason = "initial" | "maxAge" | "stale" | "invalid" | "manual";

/**
 * Reason a cache entry was removed, passed on `evict` {@link CacheEvent}s.
 *
 * - `error` — the resolver threw, so the stale entry was dropped.
 * - `invalid` — revalidation produced a value that failed `validate()`.
 * - `manual` — removed via `invalidateCache` / `.invalidate()`.
 */
export type CacheEvictReason = "error" | "invalid" | "manual";

/**
 * Cache lifecycle event types (the `type` discriminant of {@link CacheEvent}).
 *
 * Importable named constants so consumers can avoid string literals:
 * `if (event.type === CacheEventType.Hit)`. The values are plain strings, so
 * `event.type === "hit"` keeps working too.
 */
export const CacheEventType = {
  Hit: "hit",
  Miss: "miss",
  Stale: "stale",
  Set: "set",
  Evict: "evict",
} as const;

/** Union of {@link CacheEventType} values (`"hit" | "miss" | "stale" | "set" | "evict"`). */
export type CacheEventType = (typeof CacheEventType)[keyof typeof CacheEventType];

/**
 * A cache lifecycle event passed to the {@link CacheOptions.onCacheEvent} hook.
 *
 * A discriminated union on `type` ({@link CacheEventType}):
 * - `hit` — a fresh cached value was served.
 * - `miss` — nothing servable was cached; the resolver ran to populate it.
 * - `stale` — a stale value was served while a background refresh runs (SWR).
 * - `set` — a value was (re)written to storage (carries `oldValue`/`newValue`/`reason`).
 * - `evict` — an entry was removed from storage (carries `oldValue`/`reason`).
 *
 * `key` is the resolved logical cache key; `name` is a human-readable label
 * (the cached function's `name`, or the request route for HTTP handlers). For HTTP
 * handlers `name` is the raw route including the query string, so sanitize it before
 * logging if URLs may carry secrets.
 */
export type CacheEvent<T = any> =
  | { type: typeof CacheEventType.Hit; key: string; name: string; value: T }
  | { type: typeof CacheEventType.Miss; key: string; name: string }
  | { type: typeof CacheEventType.Stale; key: string; name: string; value: T }
  | {
      type: typeof CacheEventType.Set;
      key: string;
      name: string;
      oldValue?: T;
      newValue: T;
      reason: CacheSetReason;
    }
  | {
      type: typeof CacheEventType.Evict;
      key: string;
      name: string;
      oldValue: T;
      reason: CacheEvictReason;
    };

/**
 * Options for configuring cached functions created by `defineCachedFunction`.
 */
export interface CacheOptions<T = any, ArgsT extends unknown[] = any[]> {
  /** Name used as part of the cache key. Defaults to the function name or `"_"`. */
  name?: string;
  /** Custom cache key generator. Receives the same arguments as the cached function. */
  getKey?: (...args: ArgsT) => string | Promise<string>;
  /** Transform the cached entry before returning. Return value replaces the cached value. */
  transform?: (entry: CacheEntry<T>, ...args: ArgsT) => any;
  /** Validate a cache entry. Return `false` to treat the entry as invalid and re-resolve. */
  validate?: (entry: CacheEntry<T>, ...args: ArgsT) => boolean;
  /** When returns `true`, the cache is invalidated and the function is re-invoked. */
  shouldInvalidateCache?: (...args: ArgsT) => boolean | Promise<boolean>;
  /** When returns `true`, the cache is bypassed entirely and the function is called directly. */
  shouldBypassCache?: (...args: ArgsT) => boolean | Promise<boolean>;
  /** Cache key group prefix. Defaults to `"ocache/functions"`. */
  group?: string;
  /** Custom integrity value. Auto-generated from the function and options by default. */
  integrity?: any;
  /** Number of seconds to cache the response. Defaults to `1`. */
  maxAge?: number;
  /** Enable stale-while-revalidate behavior. When `true`, returns stale cache while refreshing in the background. Defaults to `true`. */
  swr?: boolean;
  /** Maximum number of seconds a stale entry can be served while revalidating. */
  staleMaxAge?: number;
  /** Base path prefix(es) for cache keys. When an array, reads try each prefix in order (multi-tier) and writes go to all prefixes. Defaults to `"/cache"`. */
  base?: string | string[];
  /** Optional error handler called for all cache-related errors (read, write, SWR, malformed data). */
  onError?: (error: unknown) => void;
  /**
   * Observability hook called on cache lifecycle events (`hit`, `miss`, `stale`, `set`, `evict`).
   *
   * Fires synchronously for the served value and (for background SWR refreshes) when the
   * refresh writes or evicts. Errors thrown here are caught and routed to `onError` — they
   * never affect caching. Does not influence integrity, so adding/removing it never
   * invalidates existing entries.
   */
  onCacheEvent?: (event: CacheEvent<T>) => void;
}

/**
 * Serialized HTTP response stored in the cache by `defineCachedHandler`.
 */
export interface ResponseCacheEntry {
  /** HTTP status code. */
  status: number;
  /** HTTP status text. */
  statusText: string | undefined;
  /** Response headers as a flat key-value record. */
  headers: Record<string, string>;
  /** Response body as a string. */
  body: string | undefined;
}

/**
 * Conditional cache header options passed to the `handleCacheHeaders` hook.
 */
export interface CacheConditions {
  modifiedTime?: Date;
  maxAge?: number;
  etag?: string;
}

/**
 * Options for configuring cached HTTP handlers created by `defineCachedHandler`.
 *
 * Extends {@link CacheOptions} (without `transform` and `validate`, which are set internally).
 */
export interface CachedEventHandlerOptions<E extends HTTPEvent = HTTPEvent> extends Omit<
  CacheOptions<ResponseCacheEntry, [E]>,
  "transform" | "validate"
> {
  /** When `true`, only handles conditional headers (304 responses) without full response caching. */
  headersOnly?: boolean;
  /** Request header names that should vary the cache key (e.g., `["accept-language"]`). */
  varies?: string[] | readonly string[];

  /**
   * Convert handler return value to a Response.
   * Default: `rawValue instanceof Response ? rawValue : new Response(String(rawValue))`.
   */
  toResponse?: (value: unknown, event: E) => Response | Promise<Response>;

  /**
   * Create the final cached Response from serialized cache entry data.
   * Default: `new Response(body, init)`.
   */
  createResponse?: (body: string | null, init: ResponseInit) => Response;

  /**
   * Check conditional request headers (etag/if-modified-since).
   * Return `true` to short-circuit with a 304 response.
   * Default: built-in if-none-match / if-modified-since check.
   */
  handleCacheHeaders?: (event: E, conditions: CacheConditions) => boolean;
}
