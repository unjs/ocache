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
   * HTTP methods whose responses are cacheable. Requests using any other method bypass the cache.
   *
   * Defaults to `["GET", "HEAD", "QUERY"]`. `QUERY` (RFC 10008) is safe and idempotent like `GET`,
   * but carries its input in the request body — so for body-bearing methods the request content and
   * its `content-type` / `accept` are folded into the cache key (RFC 10008, Section 2.7).
   */
  methods?: string[] | readonly string[];

  /**
   * Media type(s) advertised via the `Accept-Query` response header (RFC 10008, Section 3), signaling
   * which query formats the resource supports. Serialized as a Structured Fields list. Only set when
   * the handler has not already provided an `accept-query` header.
   *
   * @example ["application/jsonpath", "application/sql;charset=UTF-8"]
   */
  acceptQuery?: string | string[] | readonly string[];

  /**
   * Normalize a body-bearing request's content before it is hashed into the cache key
   * (RFC 10008, Section 2.7 — "semantically insignificant differences" may be removed).
   *
   * Return any value; it is hashed with `ohash`. When omitted, the built-in normalizer canonicalizes
   * JSON content types (via structural hashing) and hashes other bodies as raw bytes. Skipped entirely
   * when the request carries the `no-transform` cache directive.
   */
  normalizeQueryKey?: (input: {
    body: ArrayBuffer;
    contentType: string;
    event: E;
  }) => unknown | Promise<unknown>;

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
