# ocache

Standalone caching utilities extracted from [nitro](https://github.com/nitrojs/nitro). Zero framework dependencies — works with any runtime that has standard `Request`/`Response`.

## Project Structure

```
src/
├── index.ts        # Public exports (re-exports from all modules)
├── types.ts        # All type definitions (HTTPEvent, CacheEntry, CacheOptions, etc.)
├── cache.ts        # Core: defineCachedFunction, cachedFunction
├── http.ts         # HTTP layer: defineCachedHandler (depends on cache.ts)
└── storage.ts      # Storage interface + built-in memory storage
```

## Architecture

### Core caching (`cache.ts`)

- `defineCachedFunction(fn, opts)` — wraps any function with caching (SWR, TTL, integrity checks, deduplication of in-flight requests)
- `cachedFunction(fn, opts)` — alias for `defineCachedFunction`
- Uses `StorageInterface` via `useStorage()` for persistence
- Supports `waitUntil` on `event.req` (srvx/Cloudflare ServerRequest pattern) for background cache writes

### HTTP handler caching (`http.ts`)

- `defineCachedHandler(handler, opts)` — wraps an `EventHandler` with response caching
- Auto-generates cache keys from URL path + variable headers
- Handles `304 Not Modified` via `if-none-match`/`if-modified-since`
- Sets `cache-control`, `etag`, `last-modified` headers
- Filters non-variable headers before calling the handler (for consistent cache keys)

### Storage (`storage.ts`)

- `StorageInterface` — minimal `get`/`set` with optional TTL
- `createMemoryStorage()` — in-memory Map-based implementation with TTL expiry
- `useStorage()` / `setStorage()` — global singleton, lazy-inits to memory storage

### Types (`types.ts`)

- `HTTPEvent` — `{ req: Request; url?: URL }` (url falls back to `new URL(req.url)`)
- `EventHandler` — `(event: HTTPEvent) => unknown | Promise<unknown>`
- `CacheEntry<T>` — stored cache entry with value, expires, mtime, integrity
- `CacheOptions<T>` — maxAge, swr, staleMaxAge, getKey, validate, transform, etc.
- `CachedEventHandlerOptions` — extends CacheOptions with headersOnly, varies
- `ResponseCacheEntry` — serialized response (status, statusText, headers, body)

## Dependencies

- `ohash` — hashing for cache keys and integrity
- `ufo` — URL parsing (used in `http.ts` only)

## Dev Commands

- `pnpm vitest run test/` — run tests
- `pnpm exec tsgo --noEmit --skipLibCheck` — typecheck
- `pnpm build` — build with obuild

## Design Decisions

- No h3/srvx/unstorage dependency — fully standalone
- `waitUntil` accessed via `(event.req as any).waitUntil` — runtime-specific (srvx ServerRequest, Cloudflare), not typed on `Request`
- `event.url` is optional — `http.ts` falls back to `new URL(event.req.url)`
- Storage methods are `get`/`set` (not `getItem`/`setItem`)
