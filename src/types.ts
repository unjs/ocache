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
 * How a cached value was served on a given call.
 *
 * - `"hit"` — a fresh cached value was returned without re-resolving.
 * - `"stale"` — a stale value was served while a background SWR refresh runs.
 * - `"revalidated"` — a prior value existed but was expired/invalid, so it was
 *   re-resolved in the foreground (no stale value served) before returning.
 * - `"miss"` — the value was resolved fresh on this call (nothing was cached).
 */
export type CacheStatus = "hit" | "stale" | "revalidated" | "miss";

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
  /** Resolved per-entry `maxAge` (seconds) set by the `getMaxAge` hook. Overrides `CacheOptions.maxAge` for this entry's freshness check and storage TTL. */
  maxAge?: number;
  /** Resolved per-entry `staleMaxAge` (seconds) set by the `getMaxAge` hook. Overrides `CacheOptions.staleMaxAge` for this entry. */
  staleMaxAge?: number;
  /**
   * How this value was served on the current call (`"hit"` / `"stale"` / `"revalidated"` / `"miss"`).
   *
   * Populated per-call on the entry passed to `transform` — it is **not** persisted
   * to storage. Read it from `transform` for metrics/observability or to drive
   * conditional logic. See {@link CacheStatus}.
   */
  status?: CacheStatus;
}

/**
 * Options for configuring cached functions created by `defineCachedFunction`.
 */
export interface CacheOptions<T = any, ArgsT extends unknown[] = any[]> {
  /** Name used as part of the cache key. Defaults to the function name or `"_"`. */
  name?: string;
  /** Custom cache key generator. Receives the same arguments as the cached function. */
  getKey?: (...args: ArgsT) => string | Promise<string>;
  /**
   * Transform the cached entry before returning. Return value replaces the cached value.
   *
   * The passed entry carries `entry.status` (`"hit"` / `"stale"` / `"revalidated"` / `"miss"`) describing
   * how the value was served on this call — useful for metrics or conditional logic.
   */
  transform?: (entry: CacheEntry<T>, ...args: ArgsT) => any;
  /**
   * Prepare the resolved value for storage — the write-side counterpart of `transform`.
   *
   * Runs once, right after the resolver (and after `getMaxAge`, so that hook still sees the
   * raw value) and before the entry is persisted. Return the value to store (the storable
   * shape usually differs from `T`, so the return is untyped like `transform`); `transform`
   * then reconstructs the usable value when the entry is read back.
   *
   * Use this when the resolver returns something a storage backend can't persist as-is
   * (e.g. a `ReadableStream` or a class instance): `serialize` converts it to a storable
   * form on write, `transform` restores it on read. Because it runs exactly once per
   * resolution — even under concurrent, deduplicated calls, where every caller observes
   * the serialized value — it is safe to consume a one-shot source such as a stream here.
   *
   * The second argument carries the `args` the cached function was called with (same
   * shape as `validate`), so serialization can depend on the current call.
   *
   * Note: `validate` always inspects the serialized (stored) shape — on write it runs
   * right after this hook, and on read it sees the entry as persisted.
   *
   * @example
   * ```ts
   * // Persist a ReadableStream body as a string, restore it on read.
   * serialize: async (entry) => ({ ...entry.value, body: await streamToString(entry.value.body) }),
   * transform: (entry) => ({ ...entry.value, body: stringToStream(entry.value.body) }),
   * ```
   */
  serialize?: (entry: CacheEntry<T>, ctx: { args: ArgsT }) => any;
  /**
   * Validate a cache entry. Return `false` (or a Promise resolving to `false`) to treat
   * the entry as invalid and re-resolve. Asynchronous validation is supported for cases
   * that need to check the cached value against an external source (e.g. fetching a
   * signed URL to confirm it is still valid).
   *
   * The second argument carries the `args` the cached function was called with, so the
   * entry can be validated against the current call (e.g. comparing a request parameter
   * against `entry.mtime`).
   */
  validate?: (entry: CacheEntry<T>, ctx: { args: ArgsT }) => boolean | Promise<boolean>;
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
  /** Enable stale-while-revalidate behavior. When `true`, returns stale cache while refreshing in the background. Defaults to `false` (an expired entry is re-resolved in the foreground before returning). */
  swr?: boolean;
  /** Maximum number of seconds a stale entry can be served while revalidating. `0` means stale is never served — once expired, revalidation blocks the request. */
  staleMaxAge?: number;
  /**
   * Derive the per-entry cache lifetime from the resolved value. Runs after the resolver and before
   * the entry is persisted. Return a number (seconds) as shorthand for `maxAge`, or an object to also
   * override `staleMaxAge`. The resolved values override the static options for that entry and drive
   * both the read freshness check and the storage TTL. Return `undefined` (or omit a field) to fall
   * back to the static option. A resolved value `<= 0` disables caching for that entry (re-resolves
   * on every access); negatives are clamped to `0` rather than treated as "cache forever".
   *
   * @example
   * ```ts
   * // Cache an OAuth token for exactly its `expires_in`
   * getMaxAge: (entry) => entry.value?.expires_in,
   * // Override both the fresh and stale windows
   * getMaxAge: (entry) => ({ maxAge: 60, staleMaxAge: 300 }),
   * ```
   */
  getMaxAge?: (
    entry: CacheEntry<T>,
  ) =>
    | number
    | { maxAge?: number; staleMaxAge?: number }
    | undefined
    | Promise<number | { maxAge?: number; staleMaxAge?: number } | undefined>;
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
  /**
   * Serialized response body. Text bodies are stored verbatim; bodies that aren't
   * valid UTF-8 (images, protobuf, other binary payloads) are base64-encoded and
   * flagged with {@link base64}, so they survive both the lossy `res.text()` decode
   * and JSON-serializing storage backends. Always a string when set.
   */
  body: string | undefined;
  /**
   * When `true`, {@link body} is base64-encoded raw bytes (a non-UTF-8 binary body).
   * The read path decodes it back to a `Uint8Array` before rebuilding the Response.
   * Absent for text bodies.
   */
  base64?: boolean;
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
 * Extends {@link CacheOptions} (without `transform`, `validate`, and `serialize`, which are
 * set internally): the resolver returns the live `Response`, an internal `serialize` hook
 * turns it into the stored `ResponseCacheEntry`, and `transform` reconstructs the servable
 * shape on read. Because the cached value is the `Response`, hooks that run before
 * serialization — notably `getMaxAge` — receive `CacheEntry<Response>` (inspect its headers
 * or status; do not consume its body, which `serialize` reads exactly once).
 */
export interface CachedEventHandlerOptions<E extends HTTPEvent = HTTPEvent> extends Omit<
  CacheOptions<Response, [E]>,
  "transform" | "validate" | "serialize"
> {
  /** When `true`, only handles conditional headers (304 responses) without full response caching. */
  headersOnly?: boolean;
  /**
   * Request header names that should vary the cache key (e.g., `["accept-language"]`).
   * These names are also merged into the response's `Vary` header so downstream
   * caches/CDNs/browsers store a separate variant per value.
   */
  varies?: string[] | readonly string[];

  /**
   * Allowlist of query parameter names that vary the cache key (e.g., `["color"]`).
   * When set, only these params affect the auto-generated key; all others are
   * ignored. When unset, the full query string varies the key. Case-sensitive.
   *
   * If a custom `getKey` is provided it controls the key entirely and this no
   * longer affects it, but non-allowlisted params are still stripped from the
   * URL the handler sees.
   */
  allowQuery?: string[] | readonly string[];

  /**
   * Allowlist of cookie names that participate in caching.
   *
   * **By default no cookies are allowed** (secure default):
   * - the `Cookie` request header is stripped before the handler runs and never
   *   varies the cache key, so a handler cannot produce cookie-dependent output
   *   that leaks across users, and
   * - any response carrying a `Set-Cookie` header is refused storage — it is still
   *   returned to the caller that triggered it, but never cached and replayed to
   *   other requests (which would leak a per-request cookie such as a session id).
   *
   * When set, only the listed cookies are kept: their name/value pairs vary the
   * cache key (sorted, order-independent — like {@link allowQuery}) and survive in
   * the `Cookie` header the handler sees, and a `Set-Cookie` response is cacheable
   * only when every cookie it sets is in this list. Case-sensitive.
   *
   * Only cacheable requests (`GET`/`HEAD`) are affected: methods that bypass
   * caching (e.g. `POST`) reach the handler with their request untouched.
   *
   * Supersedes `varies: ["cookie"]` (which hashes the entire raw `Cookie` header).
   */
  allowCookies?: string[] | readonly string[];

  /**
   * Whether to synthesize a `Cache-Control` response header. Defaults to `true`.
   *
   * Set to `false` for **server-only caching**: the response is still stored and
   * served from cache (SWR, `etag`, and `last-modified` all still apply), but no
   * `Cache-Control` header is emitted to clients/CDNs. This decouples internal
   * storage caching from downstream cache advertisement — unlike setting
   * `Cache-Control: no-store`/`private` on the response, which also disqualifies
   * the entry from storage via the built-in `validate` checks.
   *
   * Only governs ocache's own synthesis: a `Cache-Control` the handler set
   * explicitly is left untouched (as always) and still sent.
   */
  sendCacheControl?: boolean;

  /**
   * Add a cache-status response header (CDN-style `X-Cache: HIT | STALE | REVALIDATED | MISS`).
   *
   * - `true` (default) — sets the `X-Cache` header.
   * - a string — sets a custom header name (e.g. `"x-nitro-cache"`).
   * - `false` — no header is set.
   *
   * Has no effect in `headersOnly` mode (no value is cached there).
   */
  cacheStatusHeader?: boolean | string;

  /**
   * Convert handler return value to a Response.
   * Default: `rawValue instanceof Response ? rawValue : new Response(String(rawValue))`.
   */
  toResponse?: (value: unknown, event: E) => Response | Promise<Response>;

  /**
   * Create the final cached Response from serialized cache entry data. The body is a
   * `string` for text responses, a `Uint8Array` for cached binary responses (decoded
   * from the stored base64), or `null` for empty/304 responses.
   * Default: `new Response(body, init)`.
   */
  createResponse?: (body: string | Uint8Array | null, init: ResponseInit) => Response;

  /**
   * Check conditional request headers (etag/if-modified-since).
   * Return `true` to short-circuit with a 304 response.
   * Default: built-in if-none-match / if-modified-since check.
   */
  handleCacheHeaders?: (event: E, conditions: CacheConditions) => boolean;

  /**
   * Additional predicate deciding whether a handler response is cacheable.
   *
   * Runs *after* — and in addition to — the built-in response validation, which
   * always applies and cannot be bypassed (it rejects `4xx`/`5xx` statuses,
   * `Cache-Control: no-store`/`private`, missing bodies, and absent
   * `etag`/`last-modified`). Return `false` (or a Promise resolving to `false`)
   * to treat the response as non-cacheable; it is still returned to the caller,
   * just not stored. Receives the serialized response entry.
   *
   * Because it is ANDed with the built-ins, it can only *narrow* what gets
   * cached — it cannot force-cache a response the built-in checks reject.
   *
   * Note it gates both storing a fresh response **and** serving a stored one, so
   * it also runs on cache reads (including the stale-while-revalidate serve
   * decision). Keep it fast and pure (decide only from `entry`); a throwing hook
   * fails closed (treated as non-cacheable) and is reported via `onError`.
   *
   * @example
   * ```ts
   * // Don't cache redirects (3xx), which the built-in checks would otherwise allow.
   * shouldCache: (res) => res.status < 300 || res.status >= 400,
   * ```
   */
  shouldCache?: (entry: ResponseCacheEntry) => boolean | Promise<boolean>;
}
