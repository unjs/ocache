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
