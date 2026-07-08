# ocache

<!-- automd:badges color=yellow -->

[![npm version](https://img.shields.io/npm/v/ocache?color=yellow)](https://npmjs.com/package/ocache)
[![npm downloads](https://img.shields.io/npm/dm/ocache?color=yellow)](https://npm.chart.dev/ocache)

<!-- /automd -->

## Usage

### Caching Functions

Wrap any function with `defineCachedFunction` to add caching with TTL, stale-while-revalidate, and request deduplication:

```ts
import { defineCachedFunction } from "ocache";

const cachedFetch = defineCachedFunction(
  async (url: string) => {
    const res = await fetch(url);
    return res.json();
  },
  {
    maxAge: 60, // Cache for 60 seconds
    name: "api-fetch",
  },
);

// First call hits the function, subsequent calls return cached result
const data = await cachedFetch("https://api.example.com/data");
```

#### Options

```ts
const cached = defineCachedFunction(fn, {
  name: "my-fn", // Cache key name (defaults to function name)
  maxAge: 10, // TTL in seconds (default: 1)
  swr: false, // Stale-while-revalidate (default: false — opt in to serve stale)
  staleMaxAge: 60, // Max seconds to serve stale content
  getMaxAge: (entry) => entry.value?.expires_in, // Per-entry TTL from the resolved value
  base: "/cache", // Base prefix for cache keys (string or string[] for multi-tier)
  group: "my-group", // Cache key group (default: "functions")
  getKey: (...args) => "custom-key", // Custom cache key generator
  shouldBypassCache: (...args) => false, // Skip cache entirely when true
  shouldInvalidateCache: (...args) => false, // Force refresh when true
  validate: (entry) => entry.value !== undefined, // Custom validation
  serialize: (entry) => entry.value, // Prepare value for storage (transform restores it on read)
  transform: (entry) => entry.value, // Transform before returning
  onError: (error) => console.error(error), // Error handler
});
```

#### Dynamic TTL

Some cached values carry their own expiry — an OAuth token with `expires_in`, an upstream response with `Cache-Control: max-age`. Use `getMaxAge` to derive the lifetime from the resolved value instead of a fixed constant. It runs after the resolver and returns either a number (seconds, shorthand for `maxAge`) or `{ maxAge?, staleMaxAge? }` to also override the stale window. The resolved values override the static options for that entry and are used for both the freshness check and the storage TTL. Return `undefined` (or omit a field) to fall back to the static option.

```ts
const getToken = defineCachedFunction(
  () => fetchToken(), // resolves { access_token, expires_in }
  {
    // Cache each token for exactly its own lifetime (minus a small safety margin)
    getMaxAge: (entry) => Math.max(1, (entry.value?.expires_in ?? 60) - 5),
  },
);
```

#### Custom Serialization

Some resolver outputs can't be persisted as-is — a `ReadableStream`, a class instance. Use `serialize` to convert the value to a storable form on write, and `transform` to reconstruct the usable value on read. `serialize` runs exactly once per resolution, right after the resolver (and after `getMaxAge`, so that hook still sees the raw value) — shared across concurrent deduplicated calls, so consuming a one-shot source like a stream is safe.

```ts
const getReport = defineCachedFunction(
  () => generateReportStream(), // resolves a one-shot ReadableStream
  {
    // Persist the stream as a string...
    serialize: (entry) => streamToString(entry.value),
    // ...and recreate a fresh stream on every read.
    transform: (entry) => stringToStream(entry.value),
  },
);
```

### Caching HTTP Handlers

Wrap HTTP handlers with `defineCachedHandler` for automatic response caching with `etag`, `last-modified`, and `304 Not Modified` support:

```ts
import { defineCachedHandler } from "ocache";

const handler = defineCachedHandler(
  async (event) => {
    // event.req is a standard Request object
    const url = event.url ?? new URL(event.req.url);
    const data = await getExpensiveData(url.pathname);
    return new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
    });
  },
  {
    maxAge: 300, // Cache for 5 minutes
    swr: true,
    staleMaxAge: 600,
    varies: ["accept-language"], // Vary cache key by these headers (also emitted as `Vary`)
    allowQuery: ["color"], // Vary cache by these query params only
  },
);
```

#### Query Parameters

By default the full query string varies the cache key, so `?color=red` and `?color=red&utm=x` are cached separately and unknown params can bust the cache. Set `allowQuery` to an allowlist of param names so only those affect the key — all other params are ignored. Ignored params are also stripped from the URL the handler receives (like non-`varies` headers), so a handler can never accidentally produce output that depends on a param outside the key. Param order is normalized, and repeated (array) params like `?color=red&color=blue` are matched regardless of order. Passing an empty array (`allowQuery: []`) varies by nothing — every query shares one entry. If you set a custom `getKey`, it controls the key entirely and `allowQuery` no longer affects it, but non-allowlisted params are still stripped from the URL the handler receives:

```ts
const handler = defineCachedHandler(myHandler, {
  maxAge: 300,
  allowQuery: ["color"], // ?color=red&lang=en and ?color=red&lang=de share one entry
});
```

#### Cookies

**By default no cookies participate in caching, in both directions.** This is a secure default: the `Cookie` request header is stripped before the handler runs (so it can never produce cookie-dependent output that gets cached and served to other users), cookies never vary the cache key, and any `Set-Cookie` the handler sets is stripped from the response before it is cached or returned — mirroring how shared caches (CDNs, Varnish) drop `Set-Cookie` on cacheable responses. This prevents a per-request cookie (such as a session id) from ever reaching another user, whether via a later cache hit or a concurrent request coalesced onto the same resolution. The rest of the response is still cached normally. Stored entries carrying a disallowed `Set-Cookie` (e.g. cached before this behavior existed) are likewise rejected on read instead of replayed.

This only applies to cacheable requests (`GET`/`HEAD`). Methods that bypass caching entirely (e.g. `POST`) reach the handler with their request untouched — cookies, headers, query, and body included — and their `Set-Cookie` is passed through.

Set `allowCookies` to an allowlist of cookie names to opt specific cookies back in. Only the listed cookies survive in the `Cookie` header the handler sees, and their name/value pairs vary the cache key — sorted and order-independent, like `allowQuery`, so only the relevant cookie subset is hashed rather than the entire raw `Cookie` header. On the response side, only allowlisted `Set-Cookie`s survive; any others are stripped and the rest of the response is still cached. Cookie names are case-sensitive. `allowCookies` supersedes `varies: ["cookie"]`.

```ts
const handler = defineCachedHandler(myHandler, {
  maxAge: 300,
  allowCookies: ["theme"], // theme=dark and theme=light cache separately; sid is ignored
});
```

Two caveats:

- **Custom `getKey`.** As with `allowQuery`, a custom `getKey` controls the cache key entirely, so allowlisted cookies no longer vary it automatically — if your handler's output depends on a cookie, incorporate it into `getKey` yourself (the handler-visible `Cookie` header is still filtered to the allowlist regardless).
- **Allowlisted cookies are shared — keep them cache-safe.** An allowlisted cookie participates in caching: it varies the key, and its `Set-Cookie` is cached and replayed to every caller that resolves to the same key (concurrent requests are coalesced into one handler call and share its response). It is your responsibility to only allowlist cookies whose value is safe to share across the users that share a cache key — a `theme`/`locale` preference that is _part of_ the key. **Never allowlist a per-user secret such as a session id**: coalescing plus caching would share that one value across users. A handler that _mints_ a per-request cookie (e.g. initializing an anonymous session with a fresh `Set-Cookie`) must give it a user-specific `getKey`/`varies` so each user keys to a distinct entry — otherwise don't cache it. (With no `allowCookies`, such a cookie is simply stripped, so the default never leaks; this caveat applies only once you opt a cookie back in.)

#### Headers-only Mode

Use `headersOnly` to handle conditional requests without caching the full response:

```ts
const handler = defineCachedHandler(myHandler, {
  headersOnly: true,
  maxAge: 60,
});
```

#### Private / non-cacheable responses

`defineCachedHandler` honors an explicit `Cache-Control` on the response:

- If the handler sets `Cache-Control: no-store` or `private`, the response is returned to the caller but never written to the cache — the handler runs on every request.
- If the handler sets any other `Cache-Control`, it is preserved verbatim. The synthesized `s-maxage` / `stale-while-revalidate` / `max-age` directives are only added when the handler didn't set a `Cache-Control` of its own.

> [!NOTE]
> This only governs what is **stored**. Concurrent requests are still coalesced by cache key, so per-user responses must be keyed correctly (e.g. via `varies`) — `no-store` / `private` prevents caching, it does not by itself partition the cache key.

#### Server-only caching (`sendCacheControl`)

Sometimes you want to cache a response **in storage** (to save re-computing it) while telling clients and CDNs _not_ to cache it — for example a personalized page that is cheap to serve from your own cache but must always be revalidated by the browser. Reaching for `Cache-Control: no-store`/`private` doesn't work here: those also disqualify the response from storage caching.

Set `sendCacheControl: false` to decouple the two. The response is still stored and served from cache (SWR, `etag`, and `last-modified` are unaffected), but no `Cache-Control` header is synthesized:

```ts
const handler = defineCachedHandler(myHandler, {
  maxAge: 60,
  swr: true,
  sendCacheControl: false, // stored & served from cache, but no Cache-Control sent downstream
});
```

This only governs ocache's own synthesis — a `Cache-Control` the handler sets explicitly is still preserved and sent.

#### Custom cache eligibility (`shouldCache`)

The built-in response validation already rejects `4xx`/`5xx` statuses, `Cache-Control: no-store`/`private`, empty bodies, and responses missing `etag`/`last-modified`. Use `shouldCache` to add your own rejection rule on top — for example to keep `3xx` redirects out of the cache:

```ts
const handler = defineCachedHandler(myHandler, {
  maxAge: 60,
  // Return false to skip caching this response (it is still returned to the caller).
  shouldCache: (res) => res.status < 300 || res.status >= 400,
});
```

`shouldCache` receives the serialized response entry, may be async, and is **ANDed** with the built-in checks — it can only narrow what gets cached, never force-cache a response the built-ins reject. It gates both storing a fresh response and serving a stored one, and a throwing hook fails closed (treated as non-cacheable) and is reported via `onError`.

#### Streaming responses (`stream`)

By default a cache MISS buffers the entire response body before anything reaches the client — the client waits for the full read _and_ the cache write. Set `stream: true` to hand the body to the client as it is produced: the body is `tee()`'d so one branch streams to the client immediately (time-to-first-byte is no longer blocked on buffering or storage) while the other is drained in the background to build the stored entry. Cache HITs are served from the buffered entry exactly as before.

```ts
const handler = defineCachedHandler(() => new Response(readableStreamFromUpstream()), {
  maxAge: 60,
  stream: true, // stream the MISS to the client, cache a copy in the background
});
```

Useful for proxying or generating large binary/JSON payloads where you don't want to hold the whole body in memory before responding. Things to know about the streamed MISS response (only the very first, uncached one):

- it carries **no body-hash `etag`** — an etag can't be computed without buffering the body first, so it is added only to the stored entry and therefore to subsequent cache HITs (`cache-control`, `last-modified`, `Vary`, and `Set-Cookie` stripping all still apply to the streamed response);
- its cache-status header always reports `MISS`;
- concurrent cold MISSes are **not** streamed in parallel — a `ReadableStream` has a single consumer, so the coalesced peers are served the buffered copy once the background write lands.

Only cacheable (`GET`/`HEAD`) responses with a body are affected; bypassed methods (e.g. `POST`) already stream their live response through untouched.

#### Incremental Static Regeneration (ISR)

you can reproduce a similar ISR behavior with `defineCachedHandler`: serve a cached page instantly, regenerate it in the background after it goes stale, and keep serving the last-good version until the refresh lands:

```ts
const page = defineCachedHandler(
  async (event) => {
    const html = await renderPage(event.url ?? new URL(event.req.url));
    return new Response(html, { headers: { "content-type": "text/html" } });
  },
  {
    swr: true, // serve stale instantly, refresh in the background
    maxAge: 60, // "revalidate" window: fresh for 60s, then refresh on next request
    // no staleMaxAge → stale is served indefinitely until the refresh succeeds
  },
);
```

The two options that make it ISR-like:

- **`swr: true`** turns on stale-while-revalidate: once an entry is older than `maxAge`, the next request gets the stale page immediately while a fresh render runs in the background.
- **Omit `staleMaxAge`.** This is the important part. Leaving it unset means there's no point at which the entry becomes "too old to serve" — the last successful render is served forever until a refresh replaces it, exactly like ISR. (If instead you _set_ `staleMaxAge`, you get a hard cutoff: after `maxAge + staleMaxAge` the entry is dropped and the next request blocks on a fresh render.)

With this config the handler also emits `Cache-Control: s-maxage=60, stale-while-revalidate`, so any shared/CDN cache in front of it revalidates on the same schedule.

**On-demand revalidation** (the equivalent of `revalidatePath` / `revalidateTag`) uses the methods on the returned handler:

```ts
await page.expire(event); // ISR-style: serve the stale page once more, refresh in the background
await page.invalidate(event); // hard purge: next request blocks on a fresh render
```

Prefer `.expire()` for the ISR feel — there's no blocking gap for visitors. Reach for `.invalidate()` only when the next reader must get a guaranteed-fresh render.

**Per-route revalidate windows.** If different pages need different refresh intervals (like Next's per-fetch `revalidate`), use `getMaxAge` to derive the window from the response — for example an `x-revalidate` header your handler sets. `entry.value` is the standard `Response`:

```ts
const page = defineCachedHandler(
  async (event) => {
    const url = event.url ?? new URL(event.req.url);
    const { html, revalidate } = await renderPage(url);
    return new Response(html, {
      headers: { "content-type": "text/html", "x-revalidate": String(revalidate) },
    });
  },
  {
    swr: true,
    getMaxAge: (entry) => Number(entry.value.headers.get("x-revalidate")) || 60,
  },
);
```

> [!NOTE]
> Two things differ from CDN managed ISR. **(1) Background refresh is coalesced per instance**, not globally — across multiple servers/serverless instances the origin can see one refresh per instance. Add a distributed lock in your [custom storage](#custom-storage) if regeneration is expensive. **(2) Entries never auto-expire** with `staleMaxAge` omitted, so storage grows until you `.invalidate()` — or set a large `staleMaxAge` to trade exact ISR semantics for eventual cleanup.

### Cache Invalidation

Cached functions have an `.invalidate()` method that removes cached entries across all base prefixes:

```ts
import { defineCachedFunction } from "ocache";

const getUser = defineCachedFunction(async (id: string) => db.users.find(id), {
  name: "getUser",
  maxAge: 60,
  getKey: (id: string) => id,
});

const user = await getUser("user-123");

// Invalidate a specific entry
await getUser.invalidate("user-123");

// Next call will re-invoke the function
const freshUser = await getUser("user-123");
```

You can also use the standalone `invalidateCache()` when you don't have a reference to the cached function — just pass the same options:

```ts
import { invalidateCache } from "ocache";

await invalidateCache({
  options: { name: "getUser", getKey: (id: string) => id },
  args: ["user-123"],
});
```

For advanced use cases, `.resolveKeys()` returns the raw storage keys:

```ts
const keys = await getUser.resolveKeys("user-123");
// ["/cache:functions:getUser:user-123.json"]
```

### Cache Expiration (SWR refresh)

While `.invalidate()` removes an entry entirely (the next call must wait for a fresh value), `.expire()` only marks it as stale. With SWR enabled, stale values keep being served — still bounded by the originally configured `staleMaxAge` window — and the next access triggers a background refresh:

```ts
// Mark the entry stale: next call serves the stale value and refetches in the background
await getUser.expire("user-123");
```

The standalone `expireCache()` works like `invalidateCache()` — pass the same `maxAge` / `swr` / `staleMaxAge` options you cache with so the remaining storage TTL is preserved:

```ts
import { expireCache } from "ocache";

await expireCache({
  options: { name: "getUser", getKey: (id: string) => id, maxAge: 60, staleMaxAge: 300 },
  args: ["user-123"],
});
```

### Multi-tier Caching

Use an array of `base` prefixes to enable multi-tier caching. On read, each prefix is tried in order and the first hit is used. On write, the entry is written to all prefixes:

```ts
const cachedFetch = defineCachedFunction(
  async (url: string) => {
    const res = await fetch(url);
    return res.json();
  },
  {
    maxAge: 60,
    base: ["/tmp", "/cache"],
  },
);
```

This is useful for layered cache setups (e.g., fast local cache + shared remote cache) where you want reads to prefer the nearest tier while keeping all tiers populated on writes.

### Custom Storage

By default, ocache uses an in-memory `Map`-based storage. You can provide a custom storage implementation:

```ts
import { setStorage } from "ocache";
import type { StorageInterface } from "ocache";

const redisStorage: StorageInterface = {
  get: async (key) => {
    return JSON.parse(await redis.get(key));
  },
  set: async (key, value, opts) => {
    // Setting null/undefined deletes the entry (used for cache invalidation)
    if (value === null || value === undefined) {
      await redis.del(key);
      return;
    }
    await redis.set(key, JSON.stringify(value), opts?.ttl ? { EX: opts.ttl } : undefined);
  },
};

setStorage(redisStorage);
```

The built-in memory storage keeps at most `10 000` entries by default, evicting the least-recently-used entries once the ceiling is exceeded (LRU). Pass `maxSize` to change the ceiling, or `Infinity` to disable it and grow unbounded:

```ts
import { createMemoryStorage, setStorage } from "ocache";

setStorage(createMemoryStorage({ maxSize: 10_000 }));

// Opt out of the ceiling entirely (previous unbounded behavior)
setStorage(createMemoryStorage({ maxSize: Infinity }));
```

## API

<!-- automd:docs4ts -->

### `cachedFunction`

```ts
const cachedFunction = defineCachedFunction;
```

Alias for [`defineCachedFunction`](#definecachedfunction).

---

### `CacheStatus`

```ts
type CacheStatus = "hit" | "stale" | "revalidated" | "miss";
```

How a cached value was served on a given call.

- `"hit"` — a fresh cached value was returned without re-resolving.
- `"stale"` — a stale value was served while a background SWR refresh runs.
- `"revalidated"` — a prior value existed but was expired/invalid, so it was
  re-resolved in the foreground (no stale value served) before returning.
- `"miss"` — the value was resolved fresh on this call (nothing was cached).

---

### `createMemoryStorage`

```ts
function createMemoryStorage(opts: MemoryStorageOptions =
```

Creates an in-memory storage backed by a `Map` with optional TTL support (in seconds) and LRU eviction.

---

### `defineCachedFunction`

```ts
function defineCachedFunction<T, ArgsT extends unknown[] = any[]>(
  fn: (...args: ArgsT) => T | Promise<T>,
  opts: CacheOptions<T, ArgsT> =
```

Wraps a function with caching support including TTL, SWR, integrity checks, and request deduplication.

**Parameters:**

- **`fn`** — The function to cache.
- **`opts`** — Cache configuration options.

**Returns:** — A cached function with a `.resolveKey(...args)` method for cache key resolution.

---

### `defineCachedHandler`

```ts
function defineCachedHandler<E extends HTTPEvent = HTTPEvent>(
  handler: EventHandler<E>,
  opts: CachedEventHandlerOptions<E> =
```

Wraps an HTTP event handler with response caching.

Automatically generates cache keys from the URL path and variable headers,
sets `cache-control`, `etag`, and `last-modified` headers, and handles
`304 Not Modified` responses via conditional request headers.

**Parameters:**

- **`handler`** — The event handler to cache.
- **`opts`** — Cache and HTTP-specific configuration options.

**Returns:** — A new event handler that serves cached responses when available.

---

### `EventHandler`

```ts
type EventHandler<E extends HTTPEvent = HTTPEvent> = (
```

Handler function that receives an [`HTTPEvent`](#httpevent) and returns a response value.

---

### `expireCache`

```ts
async function expireCache<ArgsT extends unknown[] = any[]>(
  input:
```

Expires cached entries for given arguments and cache options across all base prefixes,
without removing them.

Unlike [`invalidateCache`](#invalidatecache) (which removes entries entirely), expired entries keep
serving the stale value with SWR — still bounded by the originally configured
`staleMaxAge` window — while the next access triggers a background refresh.
Without SWR, the next call re-resolves before returning.

Uses the same key derivation as `defineCachedFunction` / `resolveCacheKeys`.
Pass the same `maxAge` / `swr` / `staleMaxAge` options you cache with so the
remaining storage TTL is preserved.

**Parameters:**

- **`input`** — Object with `options` (cache options) and optional `args` (function arguments).

**Example:**

```ts
// Mark a cached entry for background refresh on next access
await expireCache({
  options: { name: "fetchUser", getKey: (id: string) => id, maxAge: 60, staleMaxAge: 300 },
  args: ["user-123"],
});
```

---

### `invalidateCache`

```ts
async function invalidateCache<ArgsT extends unknown[] = any[]>(
  input:
```

Invalidates (removes) cached entries for given arguments and cache options across all base prefixes.

Uses the same key derivation as `defineCachedFunction` / `resolveCacheKeys`.

**Parameters:**

- **`input`** — Object with `options` (cache options) and optional `args` (function arguments).

**Example:**

```ts
// Invalidate a specific cached entry
await invalidateCache({
  options: { name: "fetchUser", getKey: (id: string) => id },
  args: ["user-123"],
});
```

---

### `resolveCacheKeys`

```ts
async function resolveCacheKeys<ArgsT extends unknown[] = any[]>(
  input:
```

Resolves all cache storage keys (one per base prefix) for given arguments and cache options.

Uses the same key derivation as `defineCachedFunction` internally:

- When `opts.getKey` is provided, it is called with `args` to produce the key segment.
- Otherwise, `args` are hashed with `ohash` (same default as `defineCachedFunction`).

Pass the same `getKey`, `name`, `group`, and `base` options you use in
`defineCachedFunction` / `defineCachedHandler` to get the exact storage keys.

**Parameters:**

- **`input`** — Object with `options` (cache options) and optional `args` (function arguments).

**Returns:** — An array of storage key strings (one per base prefix).

**Example:**

```ts
const keys = await resolveCacheKeys({
  options: { name: "fetchUser", getKey: (id: string) => id },
  args: ["user-123"],
});
for (const key of keys) {
  await useStorage().set(key, null); // invalidate all tiers
}
```

---

### `setStorage`

```ts
function setStorage(storage: StorageInterface): void;
```

Sets a custom storage implementation to be used by all cached functions.

---

### `useStorage`

```ts
function useStorage(): StorageInterface;
```

Returns the current storage instance. If none has been set via `setStorage`, lazily initializes an in-memory storage.

<!-- /automd-->

## Development

<details>

<summary>local development</summary>

- Clone this repository
- Install latest LTS version of [Node.js](https://nodejs.org/en/)
- Enable [Corepack](https://github.com/nodejs/corepack) using `corepack enable`
- Install dependencies using `pnpm install`
- Run interactive tests using `pnpm dev`

</details>

## License

Published under the [MIT](https://github.com/unjs/ocache/blob/main/LICENSE) license 💛.
