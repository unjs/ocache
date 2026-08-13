# ocache

<!-- automd:badges color=yellow -->

[![npm version](https://img.shields.io/npm/v/ocache?color=yellow)](https://npmjs.com/package/ocache)
[![npm downloads](https://img.shields.io/npm/dm/ocache?color=yellow)](https://npm.chart.dev/ocache)

<!-- /automd -->

Composable caching primitives with TTL, stale-while-revalidate, and HTTP response caching. Zero framework dependencies — works with any runtime that has standard `Request`/`Response`.

> [!TIP]
> 📖 Head to the [documentation](https://ocache.unjs.io/guide) to learn more.

## Features

- 🗃️ **[Function caching](https://ocache.unjs.io/guide/functions)** — wrap any function with TTL, stale-while-revalidate, and request deduplication.
- 🌐 **[HTTP response caching](https://ocache.unjs.io/guide/handler)** — automatic `etag`, `last-modified`, and `304 Not Modified` support.
- 🔑 **[Smart cache keys](https://ocache.unjs.io/guide/query-params)** — derived from arguments or request URL, with per-header and per-query variance.
- 🔌 **[Pluggable storage](https://ocache.unjs.io/guide/storage)** — bring your own backend via a minimal `get`/`set` interface.
- ♻️ **[Invalidation & expiration](https://ocache.unjs.io/guide/invalidation)** — remove or mark entries stale on demand, with SWR background refresh.

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

> [!NOTE]
> Learn more in the [Caching Functions](https://ocache.unjs.io/guide/functions) guide, and see [Invalidation & Expiration](https://ocache.unjs.io/guide/invalidation) and [Storage](https://ocache.unjs.io/guide/storage).

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

> [!NOTE]
> Learn more in the [Caching HTTP Handlers](https://ocache.unjs.io/guide/handler) guide, and see [Query Parameters](https://ocache.unjs.io/guide/query-params), [Cookies](https://ocache.unjs.io/guide/cookies), [Cache-Control & Eligibility](https://ocache.unjs.io/guide/cache-control), and [Incremental Static Regeneration](https://ocache.unjs.io/guide/isr).

## API

<!-- automd:docs4ts -->

### `CachedEventHandler`

```ts
type CachedEventHandler<E extends HTTPEvent = HTTPEvent> = EventHandler<E> &
```

Cached event handler returned by `defineCachedHandler`.

An [`EventHandler`](#eventhandler) augmented with on-demand revalidation methods. Each accepts the
[`HTTPEvent`](#httpevent) directly and derives the exact storage keys the handler caches under,
so no manual key reconstruction is needed.

They target the resource rather than one method variant of it: `GET` and `HEAD` responses
are cached under separate keys, but all of a resource's variants are covered whichever
method the passed event carries.

---

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

Wraps an HTTP event handler with response caching: keys by request origin, path, varied
headers and method, synthesizes `cache-control`/`etag`/`last-modified`, and answers `304`.

Only `GET`/`HEAD` without a `Range` header is cacheable (everything else passes through
untouched), only `200`/`203`/`301`/`308` is stored, and a response opting itself out
(`no-store`, `private`, `no-cache`, zero shared lifetime, `Vary: *`) is served but never
stored — nor is one whose own `Vary` names a header outside `varies`, which a single entry
cannot honor. `must-revalidate` is not an opt-out — stored, served fresh, never served stale.
A body over `maxBodySize` (5 MB by default) is streamed through to the caller uncached,
rather than buffered whole.

**Parameters:**

- **`handler`** — The event handler to cache.
- **`opts`** — Cache and HTTP-specific configuration options.

**Returns:** — A cached event handler, also exposing `.resolveKeys(event)`, `.invalidate(event)`
and `.expire(event)` — keyed exactly as it caches, covering every method variant.

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

Targets `options.storage` with the same rule as [`invalidateCache`](#invalidatecache): **throws** if
`storage` is unset, since there is no global store to fall back on.

**Parameters:**

- **`input`** — Object with `options` (cache options) and optional `args` (function arguments).

**Example:**

```ts
// Mark a cached entry for background refresh on next access
await expireCache({
  options: { name: "fetchUser", getKey: (id: string) => id, maxAge: 60, staleMaxAge: 300, storage },
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

Targets `options.storage` — pass the same backend (or, better, the very same options
object you cached with, whose resolved storage is memoized on it) the entries were
written to. **Throws** if `storage` is unset: there is no global store to fall back on,
so the call could only purge a fresh empty one while the stale entry kept being served.
A mismatched `name`/`getKey` still purges nothing silently. When the cached function is
at hand, prefer its own `.invalidate(...args)`.

**Parameters:**

- **`input`** — Object with `options` (cache options) and optional `args` (function arguments).

**Example:**

```ts
// Invalidate a specific cached entry
await invalidateCache({
  options: { name: "fetchUser", getKey: (id: string) => id, storage },
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
const storage = createMemoryStorage();
const fn = cachedFunction(fetchUser, { name: "fetchUser", getKey: (id: string) => id, storage });

const keys = await resolveCacheKeys({
  options: { name: "fetchUser", getKey: (id: string) => id },
  args: ["user-123"],
});
for (const key of keys) {
  await storage.set(key, null); // invalidate all tiers
}
```

---

### `StorageOption`

```ts
type StorageOption = StorageInterface | (() => StorageInterface);
```

Where a cached function/handler persists its entries: a ready [`StorageInterface`](#storageinterface),
or a factory returning one.

The factory form exists for **late binding** — handlers are typically defined at module
load while the real backend (Redis, KV, ...) only exists once the server has started.
It is called on the first actual cache read/write, never at definition time, and at
most once per cached function/handler.

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
