import type { StorageOption } from "./storage.ts";

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
 * Cached event handler returned by `defineCachedHandler`.
 *
 * An {@link EventHandler} augmented with on-demand revalidation methods. Each accepts the
 * {@link HTTPEvent} directly and derives the exact storage keys the handler caches under,
 * so no manual key reconstruction is needed.
 *
 * They target the resource rather than one method variant of it: `GET` and `HEAD` responses
 * are cached under separate keys, but all of a resource's variants are covered whichever
 * method the passed event carries.
 */
export type CachedEventHandler<E extends HTTPEvent = HTTPEvent> = EventHandler<E> & {
  /** Resolves all storage keys (one per base prefix per method variant, the event's own first) the handler would cache the event under. */
  resolveKeys: (event: E) => Promise<string[]>;
  /** Invalidates (removes) cached entries for the event's resource — every method variant, across all base prefixes. */
  invalidate: (event: E) => Promise<void>;
  /** Marks cached entries for the event's resource (every method variant, across all base prefixes) as stale. With SWR, stale values are still served (within `staleMaxAge`) while the next access triggers a background refresh. */
  expire: (event: E) => Promise<void>;
};

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
 *
 * **An option explicitly set to `undefined` is treated as unset** and takes its default —
 * `{ maxAge: undefined }` caches exactly like `{}`. This matters because that spelling comes
 * from plumbing rather than from anyone's keyboard: `{ maxAge: routeConfig.maxAge }` where the
 * rule sets no `maxAge`. `null` is not `undefined` and is left as written. Same rule for
 * {@link CachedEventHandlerOptions}.
 */
export interface CacheOptions<T = any, ArgsT extends unknown[] = any[]> {
  /**
   * Name used as part of the cache key.
   *
   * Defaults to the cached function's (or handler's) own `name`, falling back to a hash of
   * its source for anonymous ones. A source hash cannot distinguish same-source functions
   * that differ only by a closed-over variable (the classic factory:
   * `const make = (tenant) => defineCachedHandler(() => render(tenant), { storage })`) —
   * those share a key, and with a shared `storage` they share entries outright. Pass an
   * explicit `name` whenever instances are built in a factory or a loop.
   */
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
  /**
   * Number of seconds to cache the response. Defaults to `1` — including when it is passed
   * as an explicit `undefined` (see the note on this interface).
   *
   * A lifetime of `0` means **nothing is stored**: such an entry is expired the moment it is
   * written, so the value is re-resolved on every access either way, and persisting it would
   * leave behind an entry with neither an expiry nor a storage TTL, which nothing could ever
   * serve or reclaim.
   */
  maxAge?: number;
  /**
   * Enable stale-while-revalidate behavior. When `true`, returns stale cache while refreshing
   * in the background. Defaults to `false` (an expired entry is re-resolved in the foreground
   * before returning).
   *
   * With no {@link staleMaxAge} there is no point at which the value becomes too old to
   * serve: the last successful resolution keeps being served until a background refresh
   * replaces it (the ISR shape), and the entry is retained until the storage backend evicts
   * it. Set `staleMaxAge` for a hard cutoff and a storage TTL of `maxAge + staleMaxAge`.
   */
  swr?: boolean;
  /**
   * Maximum number of seconds a stale entry can be served while revalidating, and the extra
   * time it stays in storage (the TTL is `maxAge + staleMaxAge`). `0` means stale is never
   * served — once expired, revalidation blocks the request.
   *
   * Unset is **not** the same as `0`: it means the stale window is unbounded — under
   * {@link swr} the entry is served stale for as long as the storage backend keeps it.
   */
  staleMaxAge?: number;
  /**
   * Derive the per-entry cache lifetime from the resolved value. Runs after the resolver and before
   * the entry is persisted. Return a number (seconds) as shorthand for `maxAge`, or an object to also
   * override `staleMaxAge`. The resolved values override the static options for that entry and drive
   * the read freshness check, the storage TTL and — in `defineCachedHandler` — the synthesized
   * `Cache-Control`, so the lifetime advertised downstream is the one actually enforced here.
   * Return `undefined` (or omit a field) to fall back to the static option. A resolved value
   * `<= 0` disables caching for that entry — it is
   * re-resolved on every access and never written to storage; negatives are clamped to `0`
   * rather than treated as "cache forever".
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
  /**
   * Deadline in **milliseconds** on one shared resolution — the resolver plus the
   * `getMaxAge`/`serialize` hooks folded into it. Defaults to `30 000`; `Infinity` (or `0`)
   * waits forever.
   *
   * Concurrent calls for a key share one in-flight resolution, so a resolver that never
   * settles would otherwise pin that key for the lifetime of the process: every later call
   * joins a resolution that will never finish. On the deadline that resolution is abandoned
   * and **every caller awaiting it rejects** with a `TimeoutError`, which frees the key —
   * the next call resolves it afresh.
   *
   * The abandoned resolver is not cancelled (there is nothing here to cancel it with): it
   * keeps running and may still settle, but into a promise nobody is awaiting, so its value
   * is never served and can never be written over what a later call has cached. A timed-out
   * resolution counts as a failed one in every respect, including evicting the entry it was
   * refreshing. Under `swr` it also bounds the background refresh, whose failure is reported
   * through `onError` rather than thrown.
   */
  resolverTimeout?: number;
  /** Base path prefix(es) for cache keys. When an array, reads try each prefix in order (multi-tier) and writes go to all prefixes. Defaults to `"/cache"`. */
  base?: string | string[];
  /**
   * Where to persist cache entries: a {@link StorageInterface}, or a factory returning
   * one. **Defaults to a fresh in-memory storage per cached function/handler.**
   *
   * Storage is per instance — there is no global backend. Two cached functions that both
   * take the default never share entries, even under an identical `name`/key, so two
   * independent apps in one process cannot leak cached values into each other. To share a
   * cache, pass the *same* `storage` to each caller that should see it.
   *
   * The factory form is for late binding: it is called on the first cache read/write
   * (never at definition time) and at most once, so a handler can be defined at module
   * load while its backend is only configured at server start.
   *
   * The resolved instance is written back into this options object, so passing the *same*
   * object to `resolveCacheKeys` / `invalidateCache` / `expireCache` targets the same
   * store. A different object literal — even a structurally identical one — resolves its
   * own storage and would silently act on an unrelated store, exactly like passing a
   * different `name`.
   *
   * @example
   * ```ts
   * // Shared between two cached functions
   * const storage = createMemoryStorage();
   * const a = cachedFunction(fnA, { storage });
   * const b = cachedFunction(fnB, { storage });
   *
   * // Late-bound backend, resolved on first use
   * let redis: StorageInterface;
   * const handler = defineCachedHandler(h, { storage: () => redis });
   * ```
   */
  storage?: StorageOption;
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
   *
   * This list is also what a **handler-set `Vary` is checked against**: a response
   * declaring a header that is not varied on here (nor `Cookie` under
   * {@link allowCookies}) is returned to the caller but never stored, and gets no
   * synthesized `Cache-Control` — one entry cannot honor a variance the key doesn't
   * capture, and replaying the first variant to every other one is the bug that rule
   * prevents. Declare the header here and the response caches normally.
   *
   * Varying headers stay visible to the handler: their value is part of the cache key,
   * so the handler can safely render from them (a per-value entry is stored for each).
   * This includes the credential headers — listing `cookie` (with no {@link allowCookies})
   * or `authorization` here is a **coarse opt-in**: the raw header composes the key *and*
   * reaches the handler. The cost is one cached entry per distinct raw header value, which
   * for `Cookie` is effectively per visitor; prefer {@link allowCookies}, which keys on and
   * forwards a named subset instead.
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
   * Allowlist of `Cookie` **request** header names that participate in caching.
   *
   * **By default no cookies are allowed** (secure default): the `Cookie` header is
   * stripped before the handler runs and never varies the cache key, so a handler
   * cannot produce cookie-dependent output that then leaks across users.
   *
   * When set, only the listed cookies survive in the `Cookie` header the handler sees,
   * and their name/value pairs vary the cache key (sorted, order-independent — like
   * {@link allowQuery}). Case-sensitive. Allowlist a cookie whose value legitimately
   * selects a *representation* — a `theme`/`locale` preference that becomes part of the
   * key — not a per-user secret: everyone presenting the same value shares one entry.
   *
   * ⚠️ **Setting this emits `Vary: Cookie` on the response**, because the response really
   * does vary by the `Cookie` request header and `Vary` has no finer granularity than the
   * header name — a shared cache cannot be told "only the `theme` cookie matters". This is
   * correctness, but it has a price: `Vary: Cookie` is notoriously destructive to CDN /
   * shared-proxy hit rates, since any unrelated cookie (analytics, A/B, consent) makes a
   * request its own variant, so downstream caching effectively stops. Previously ocache
   * omitted the header and advertised `s-maxage`/`max-age` regardless — shared caches
   * cached more, and served one visitor's variant to everyone. **If downstream hit rate is
   * what you need, do not key by cookie at all**: drop `allowCookies` (the default strips
   * the header) and select the representation from the URL instead ({@link allowQuery}, or
   * distinct paths). {@link sendCacheControl}`: false` is the other option — keep the
   * cookie-keyed server-side cache and advertise nothing downstream.
   *
   * **This option has no effect on the response.** No `Set-Cookie` ever survives a
   * cacheable response, allowlisted or not: it is stripped before the entry is stored
   * *and* before the response is returned, mirroring how shared caches / CDNs drop
   * `Set-Cookie` on cacheable responses. A cached response is shared with every later
   * hit on its key and with concurrent callers coalesced onto one handler call, so a
   * cookie minted inside it would reach callers it was never minted for. The rest of
   * the response is still cached.
   *
   * To mint a per-request cookie (a session id, a CSRF token), serve it from a request
   * that bypasses the cache: only `GET`/`HEAD` are cacheable, so a `POST` (or any route
   * excluded via `shouldBypassCache`) reaches the handler untouched and returns its
   * `Set-Cookie` unchanged.
   *
   * Supersedes `varies: ["cookie"]` — the coarse opt-in, which keys on *and* forwards the
   * entire raw `Cookie` header (one entry per distinct header value). When both are set the
   * allowlist wins in both directions: the key carries the subset hash, and the handler sees
   * the filtered header, never the raw one.
   */
  allowCookies?: string[] | readonly string[];

  /**
   * Whether the `Authorization` / `Proxy-Authorization` request headers may participate
   * in caching. Defaults to `false`.
   *
   * **By default credentials are stripped** before the handler runs (secure default,
   * exactly like a non-allowlisted cookie): they never vary the cache key, and because
   * the handler cannot read them it cannot render per-user content that would then be
   * stored under the shared, anonymous key and replayed to every other caller — and,
   * via the synthesized `Cache-Control`, to shared CDNs as well.
   *
   * When `true`, both header names are folded into {@link varies}: their values vary the
   * cache key, they are advertised in the response `Vary` header, and they stay visible
   * to the handler. Listing either name in {@link varies} yourself has the same effect.
   *
   * ⚠️ Opting in means the response **is cached per credential value**: every caller
   * presenting the same token shares one entry (concurrent requests are coalesced into a
   * single handler call). It is the caller's responsibility to ensure that is correct —
   * one entry per distinct token, so a token that maps to more than one user's view, or
   * a rotating/short-lived token, still needs a user-specific `getKey`. When the response
   * is genuinely per-user and shouldn't be shared, don't opt in: bypass those requests
   * instead (`shouldBypassCache: (event) => event.req.headers.has("authorization")`).
   *
   * Only cacheable requests are affected: a request that bypasses the cache — a `POST`, a
   * ranged request, or one your own `shouldBypassCache` excludes — reaches the handler
   * with its credentials (and its full query) untouched.
   */
  allowAuthorization?: boolean;

  /**
   * Whether to synthesize a `Cache-Control` response header. Defaults to `true`.
   *
   * Set to `false` for **server-only caching**: the response is still stored and
   * served from cache (SWR, `etag`, and `last-modified` all still apply), but no
   * `Cache-Control` header is emitted to clients/CDNs. This decouples internal
   * storage caching from downstream cache advertisement — unlike setting
   * `Cache-Control: no-store`/`private`/`no-cache`/`max-age=0` on the response,
   * all of which also disqualify the entry from storage via the built-in
   * `validate` checks.
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
   * always applies and cannot be bypassed (only `200`, `203`, `301` and `308`
   * responses are storable at all; it also rejects the response-side opt-outs
   * `Cache-Control: no-store`/`private`/`no-cache`/`max-age=0`/`s-maxage=0` and
   * `Vary: *`, missing bodies, and absent
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
   * // Don't cache permanent redirects (301/308), which the built-in checks allow.
   * shouldCache: (res) => res.status < 300,
   * ```
   */
  shouldCache?: (entry: ResponseCacheEntry) => boolean | Promise<boolean>;
}
