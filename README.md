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

Cached handler with resource-level cache management methods.

Each method covers GET and HEAD variants in every base prefix.

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

Result of one cache call.

- `"hit"`: returned a fresh stored value.
- `"stale"`: returned stale data and started background revalidation.
- `"revalidated"`: replaced an old value before returning.
- `"miss"`: resolved a value when none existed.

---

### `createMemoryStorage`

```ts
function createMemoryStorage(opts: MemoryStorageOptions =
```

Creates Map-based memory storage with TTLs in seconds and LRU eviction.

---

### `defineCachedFunction`

```ts
function defineCachedFunction<T, ArgsT extends unknown[] = any[]>(
  fn: (...args: ArgsT) => T | Promise<T>,
  opts: CacheOptions<T, ArgsT> =
```

Wraps a function with caching, SWR, integrity checks, and request deduplication.

**Parameters:**

- **`fn`** — Function to cache.
- **`opts`** — Cache options.

**Returns:** — The cached function and its cache management methods.

---

### `defineCachedHandler`

```ts
function defineCachedHandler<E extends HTTPEvent = HTTPEvent>(
  handler: EventHandler<E>,
  opts: CachedEventHandlerOptions<E> =
```

Wraps an HTTP handler with response caching and conditional response support.

Only GET and HEAD requests without Range are cacheable.
Only 200, 203, 301, and 308 responses are stored.
Response Cache-Control and Vary headers can prevent storage.

**Parameters:**

- **`handler`** — Handler to cache.
- **`opts`** — Cache and HTTP options.

**Returns:** — A cached handler with resource-level cache management methods.

---

### `EventHandler`

```ts
type EventHandler<E extends HTTPEvent = HTTPEvent> = (
```

Handler that receives an HTTP event.

---

### `expireCache`

```ts
async function expireCache<ArgsT extends unknown[] = any[]>(
  input:
```

Marks matching entries as stale without removing them.

SWR may serve the stale value within its original stale window.
Without SWR, the next call revalidates before returning.
Pass the original lifetime options to preserve the remaining storage TTL.
This function throws when `options.storage` is unset.

**Parameters:**

- **`input`** — Cache options and function arguments.

**Example:**

```ts
await expireCache({
  options: { name: "fetchUser", getKey: (id: string) => id, maxAge: 60, swr: true, storage },
  args: ["user-123"],
});
```

---

### `fencePending`

```ts
function fencePending(cachedFn: object, key: string): void;
```

Stops in-flight resolutions for `key` from writing after a purge. Internal.

---

### `invalidateCache`

```ts
async function invalidateCache<ArgsT extends unknown[] = any[]>(
  input:
```

Removes matching entries from all base prefixes.

Pass the original options object or the same explicit storage backend.
This function throws when `options.storage` is unset because no global store exists.
Prefer the cached function's `.invalidate()` method when available.

**Parameters:**

- **`input`** — Cache options and function arguments.

**Example:**

```ts
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

Returns one storage key per base prefix.

Pass the same `getKey`, `name`, `group`, and `base` options as the cached function.
This helper computes keys without accessing storage.

**Parameters:**

- **`input`** — Cache options and function arguments.

**Returns:** — Storage keys in base-prefix order.

**Example:**

```ts
const keys = await resolveCacheKeys({
  options: { name: "fetchUser", getKey: (id: string) => id },
  args: ["user-123"],
});
```

---

### `StorageOption`

```ts
type StorageOption = StorageInterface | (() => StorageInterface);
```

A storage instance or a late-bound storage factory.

The cache calls a factory once, on the first cache operation.

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
