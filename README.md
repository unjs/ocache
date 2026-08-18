# ocache

<!-- automd:badges color=yellow -->

[![npm version](https://img.shields.io/npm/v/ocache?color=yellow)](https://npmjs.com/package/ocache)
[![npm downloads](https://img.shields.io/npm/dm/ocache?color=yellow)](https://npm.chart.dev/ocache)

<!-- /automd -->

Composable caching primitives with TTL, stale-while-revalidate, and HTTP response caching. Zero framework dependencies — works with any runtime that has standard `Request`/`Response`.

> [!TIP]
> 📖 Head to the [documentation](https://ocache.unjs.io/guide) to learn more.

## Features

- 🗃️ **[Function caching](https://ocache.unjs.io/functions)** — wrap any function with TTL, stale-while-revalidate, and request deduplication.
- 🌐 **[HTTP response caching](https://ocache.unjs.io/handler)** — automatic `etag` and `304 Not Modified` support.
- 🔑 **[Smart cache keys](https://ocache.unjs.io/query-params)** — derived from arguments or request URL, with per-header and per-query variance.
- 🔌 **[Pluggable storage](https://ocache.unjs.io/storage)** — bring your own backend via a minimal `get`/`set` interface.
- ♻️ **[Invalidation & expiration](https://ocache.unjs.io/invalidation)** — remove or mark entries stale on demand, with SWR background refresh.

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
> Learn more in the [Caching Functions](https://ocache.unjs.io/functions) guide, and see [Invalidation & Expiration](https://ocache.unjs.io/invalidation) and [Storage](https://ocache.unjs.io/storage).

### Caching HTTP Handlers

Wrap HTTP handlers with `defineCachedHandler` for automatic response caching with `etag` and `304 Not Modified` support:

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
    allowQuery: ["color"], // Opt in: only these query params vary the cache (default: none)
  },
);
```

> [!NOTE]
> Learn more in the [Caching HTTP Handlers](https://ocache.unjs.io/handler) guide, and see [Query Parameters](https://ocache.unjs.io/query-params), [Cookies](https://ocache.unjs.io/cookies), [Cache-Control & Eligibility](https://ocache.unjs.io/cache-control), and [Incremental Static Regeneration](https://ocache.unjs.io/isr).

## API

<!-- automd:docs4ts -->

### `BlobValue`

```ts
type BlobValue = ArrayBufferView | ArrayBufferLike;
```

What a byte backend may return: a view, or the buffer behind one.

---

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

### `composeStorage`

```ts
function composeStorage(
  layers: ReadonlyArray<StorageInterface | StorageLayer>,
  opts: ComposeStorageOptions =
```

Combines several backends into one tiered [`StorageInterface`](#storageinterface).

Reads try each layer in order and stop at the first hit, promoting it into every earlier
layer. Writes and deletes reach every layer. A layer that throws is skipped rather than
failing the operation, so a shared remote layer can be down while a local one still serves.

This is a backend, not a cache option: the cache above it sees one store with one
declaration, so nothing in the key, the entry, or the purge path changes.

**Example:**

```ts
const storage = composeStorage([
  { storage: createMemoryStorage({ maxBytes: 64 * 1024 * 1024 }), ttl: 60 },
  createBlobStorage(redis),
]);
```

---

### `createBlobStorage`

```ts
function createBlobStorage(backend: BlobBackend): StorageInterface;
```

Adapts a byte-only backend into a [`StorageInterface`](#storageinterface), storing each entry as one frame.

The entry's metadata travels as JSON and its payload travels as itself, appended after it.
That keeps a response body — text or binary — out of the JSON document: text pays no
escaping in either direction, and bytes pay no base64 and no 4/3 expansion in the backend.

The payload is the one named by {@link CacheEntry.payload}, which the producer of the entry
declares — `http/entry.ts` for a response body, `cache.ts` for a byte value. Nothing here
infers a payload from a value's shape.

This declares `binary`, because the frame carries the declared payload as bytes. Every
other member of the entry is JSON, exactly as it would be on a serializing backend: a byte
view hidden somewhere ocache did not put one does not survive, on this backend or on any
other JSON-shaped one.

A frame written by a different version is read as a miss, so a format change costs one
revalidation rather than a mangled entry.

**Example:**

```ts
const storage = createBlobStorage({
  get: (key) => unstorage.getItemRaw(key),
  set: (key, value, opts) =>
    value === null ? unstorage.removeItem(key) : unstorage.setItemRaw(key, value, opts),
});
```

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

### `resolveSignal`

```ts
function resolveSignal(event: HTTPEvent): AbortSignal | undefined;
```

The deadline signal of the resolution this event leads, if it leads one.

---

### `resolveStatus`

```ts
function resolveStatus(event: HTTPEvent): CacheStatus | undefined;
```

The status of the foreground resolution this event leads, if it leads one.

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
