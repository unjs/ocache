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
  swr: true, // Stale-while-revalidate (default: true)
  staleMaxAge: 60, // Max seconds to serve stale content
  base: "/cache", // Base prefix for cache keys (string or string[] for multi-tier)
  group: "my-group", // Cache key group (default: "functions")
  getKey: (...args) => "custom-key", // Custom cache key generator
  shouldBypassCache: (...args) => false, // Skip cache entirely when true
  shouldInvalidateCache: (...args) => false, // Force refresh when true
  validate: (entry) => entry.value !== undefined, // Custom validation
  transform: (entry) => entry.value, // Transform before returning
  onError: (error) => console.error(error), // Error handler
  onCacheEvent: (event) => {}, // Lifecycle hook: hit/miss/stale/set/evict
});
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
    varies: ["accept-language"], // Vary cache by these headers
  },
);
```

#### Headers-only Mode

Use `headersOnly` to handle conditional requests without caching the full response:

```ts
const handler = defineCachedHandler(myHandler, {
  headersOnly: true,
  maxAge: 60,
});
```

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

### Cache Events

Pass an `onCacheEvent` hook to observe the cache lifecycle — hits, misses, stale serves, writes, and evictions. Use it for metrics, audit logging, cascading invalidations, or debugging. The hook is a superset of an "update/eviction" callback: filter for `set`/`evict` to react to changes, and read `oldValue`/`newValue`/`reason` to compare before/after.

```ts
const getUser = defineCachedFunction(fetchUser, {
  maxAge: 60,
  staleMaxAge: 300,
  onCacheEvent(event) {
    switch (event.type) {
      case "hit": // fresh value served
      case "miss": // nothing cached, resolver ran
      case "stale": // stale value served, refreshing in background
        break;
      case "set": // written to storage
        // event.oldValue, event.newValue
        // event.reason: "initial" | "maxAge" | "stale" | "invalid" | "manual"
        break;
      case "evict": // removed from storage
        // event.oldValue
        // event.reason: "error" | "invalid" | "manual"
        break;
    }
  },
});
```

Every event carries a `key` (the resolved cache key) and a `name` — the cached function's `name`, or the request route for HTTP handlers. The hook fires synchronously for the served value and again from background SWR refreshes. Errors thrown inside it are routed to `onError` and never affect caching; it also has no effect on integrity, so adding or removing it never invalidates existing entries.

Event types are also exported as `CacheEventType` constants, so you can avoid string literals — `event.type === CacheEventType.Hit` (values are plain strings, so `=== "hit"` still works):

```ts
import { CacheEventType } from "ocache";

onCacheEvent(event) {
  if (event.type === CacheEventType.Evict) {
    /* ... */
  }
}
```

`onCacheEvent` works the same on `defineCachedHandler`, where `name` is the request route. A minimal dev logger:

```ts
const handler = defineCachedHandler(render, {
  maxAge: 2,
  swr: true,
  onCacheEvent(event) {
    if (event.type === "set" && event.reason === "initial") {
      console.log(`Added cache entry for '${event.name}', swr enabled`);
    } else {
      console.log(`Cache ${event.type} for '${event.name}'`);
    }
  },
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

## API

<!-- automd:docs4ts -->

### `_integrityOpts`

```ts
function _integrityOpts<O extends CacheOptions>(
  opts: O,
): Omit<O, "base" | "group" | "name" | "onCacheEvent">;
```

Strips storage-location and observability fields from opts so integrity only reflects the cached computation.

---

### `cachedFunction`

```ts
const cachedFunction = defineCachedFunction;
```

Alias for [`defineCachedFunction`](#definecachedfunction).

---

### `CacheEvent`

```ts
type CacheEvent<T = any> =
  |
```

A cache lifecycle event passed to the {@link CacheOptions.onCacheEvent} hook.

A discriminated union on `type` ([`CacheEventType`](#cacheeventtype)):

- `hit` — a fresh cached value was served.
- `miss` — nothing servable was cached; the resolver ran to populate it.
- `stale` — a stale value was served while a background refresh runs (SWR).
- `set` — a value was (re)written to storage (carries `oldValue`/`newValue`/`reason`).
- `evict` — an entry was removed from storage (carries `oldValue`/`reason`).

`key` is the resolved logical cache key; `name` is a human-readable label
(the cached function's `name`, or the request route for HTTP handlers). For HTTP
handlers `name` is the raw route including the query string, so sanitize it before
logging if URLs may carry secrets.

---

### `CacheEventType`

```ts
const CacheEventType =
```

Cache lifecycle event types (the `type` discriminant of [`CacheEvent`](#cacheevent)).

Importable named constants so consumers can avoid string literals:
`if (event.type === CacheEventType.Hit)`. The values are plain strings, so
`event.type === "hit"` keeps working too.

---

### `CacheEventType`

```ts
type CacheEventType = (typeof CacheEventType)[keyof typeof CacheEventType];
```

Union of [`CacheEventType`](#cacheeventtype) values (`"hit" | "miss" | "stale" | "set" | "evict"`).

---

### `CacheEvictReason`

```ts
type CacheEvictReason = "error" | "invalid" | "manual";
```

Reason a cache entry was removed, passed on `evict` [`CacheEvent`](#cacheevent)s.

- `error` — the resolver threw, so the stale entry was dropped.
- `invalid` — revalidation produced a value that failed `validate()`.
- `manual` — removed via `invalidateCache` / `.invalidate()`.

---

### `CacheSetReason`

```ts
type CacheSetReason = "initial" | "maxAge" | "stale" | "invalid" | "manual";
```

Reason a cache entry was (re)written, passed on `set` [`CacheEvent`](#cacheevent)s.

- `initial` — first population (no previous value).
- `maxAge` — the previous value's TTL (`maxAge`) had elapsed.
- `stale` — the entry had been marked stale (e.g. by `expireCache`).
- `invalid` — integrity changed or `validate()` rejected the previous value.
- `manual` — re-resolved because `shouldInvalidateCache` returned `true`.

---

### `createMemoryStorage`

```ts
function createMemoryStorage(): StorageInterface;
```

Creates an in-memory storage backed by a `Map` with optional TTL support (in seconds).

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
