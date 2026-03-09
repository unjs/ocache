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
  group: "my-group", // Cache key group (default: "ocache/functions")
  getKey: (...args) => "custom-key", // Custom cache key generator
  shouldBypassCache: (...args) => false, // Skip cache entirely when true
  shouldInvalidateCache: (...args) => false, // Force refresh when true
  validate: (entry) => entry.value !== undefined, // Custom validation
  transform: (entry) => entry.value, // Transform before returning
  onError: (error) => console.error(error), // Error handler
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

// Use with any server that provides Request/Response
// e.g., Bun, Deno, Cloudflare Workers, srvx, etc.
```

#### Headers-only Mode

Use `headersOnly` to handle conditional requests without caching the full response:

```ts
const handler = defineCachedHandler(myHandler, {
  headersOnly: true,
  maxAge: 60,
});
```

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
    await redis.set(key, JSON.stringify(value), opts?.ttl ? { EX: opts.ttl } : undefined);
  },
};

setStorage(redisStorage);
```

## API

<!-- automd:docs4ts -->

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

**Returns:** — A new async function that returns cached results when available.

---

### `cachedFunction`

```ts
const cachedFunction = defineCachedFunction;
```

Alias for [`defineCachedFunction`](#definecachedfunction).

---

### `defineCachedHandler`

```ts
function defineCachedHandler<E extends HTTPEvent = HTTPEvent>(
  handler: EventHandler<E>,
  opts: CachedEventHandlerOptions<E> = defaultCacheOptions() as CachedEventHandlerOptions<E>,
): EventHandler<E>;
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

### `createMemoryStorage`

```ts
function createMemoryStorage(): StorageInterface;
```

Creates an in-memory storage backed by a `Map` with optional TTL support (in seconds).

---

### `useStorage`

```ts
function useStorage(): StorageInterface;
```

Returns the current storage instance. If none has been set via `setStorage`, lazily initializes an in-memory storage.

---

### `setStorage`

```ts
function setStorage(storage: StorageInterface): void;
```

Sets a custom storage implementation to be used by all cached functions.

---

### `ServerRequest`

```ts
interface ServerRequest extends Request
```

Extended `Request` interface with optional `waitUntil` for background tasks.

Compatible with srvx `ServerRequest`.

---

### `HTTPEvent`

```ts
interface HTTPEvent
```

Minimal HTTP event object containing a request and an optional pre-parsed URL.

---

### `EventHandler`

```ts
type EventHandler<E extends HTTPEvent = HTTPEvent> = (
```

Handler function that receives an [`HTTPEvent`](#httpevent) and returns a response value.

---

### `CacheEntry`

```ts
interface CacheEntry<T = any>
```

Stored cache entry wrapping a cached value with metadata.

---

### `CacheOptions`

```ts
interface CacheOptions<T = any, ArgsT extends unknown[] = any[]>
```

Options for configuring cached functions created by `defineCachedFunction`.

---

### `ResponseCacheEntry`

```ts
interface ResponseCacheEntry
```

Serialized HTTP response stored in the cache by `defineCachedHandler`.

---

### `CacheConditions`

```ts
interface CacheConditions
```

Conditional cache header options passed to the `handleCacheHeaders` hook.

---

### `CachedEventHandlerOptions`

```ts
interface CachedEventHandlerOptions<
  E extends HTTPEvent = HTTPEvent,
> extends Omit<
  CacheOptions<ResponseCacheEntry, [E]>,
  "transform" | "validate"
>
```

Options for configuring cached HTTP handlers created by `defineCachedHandler`.

Extends [`CacheOptions`](#cacheoptions) (without `transform` and `validate`, which are set internally).

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
