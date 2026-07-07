# ocache

Standalone caching utilities extracted from [nitro](https://github.com/nitrojs/nitro). Zero framework dependencies — works with any runtime that has standard `Request`/`Response`.

## Project Structure

```
src/
├── index.ts        # Public exports (re-exports from all modules)
├── types.ts        # All type definitions (HTTPEvent, CacheEntry, CacheOptions, etc.)
├── cache.ts        # Core: defineCachedFunction, cachedFunction, invalidateCache, resolveCacheKeys
├── http.ts         # HTTP layer: defineCachedHandler (depends on cache.ts)
└── storage.ts      # Storage interface + built-in memory storage
```

## Docs

Never touch contents inside `<!-- automd -->` in README.md. They are auto generated (use `pnpm fmt` to update).

### Core caching (`cache.ts`)

- `defineCachedFunction(fn, opts)` — wraps any function with caching (SWR, TTL, integrity checks, deduplication of in-flight requests)
- `cachedFunction(fn, opts)` — alias for `defineCachedFunction`
- Returned cached function has `.resolveKeys(...args)`, `.invalidate(...args)`, and `.expire(...args)` methods
- `resolveCacheKeys({ options, args })` — standalone helper to resolve storage keys
- `invalidateCache({ options, args })` — standalone helper to remove cached entries across all base prefixes
- `expireCache({ options, args })` — standalone helper to mark entries stale (`CacheEntry.stale`) without removing them: SWR keeps serving stale within the original `staleMaxAge` window while the next access triggers a background refresh
- Uses `StorageInterface` via `useStorage()` for persistence
- Supports `waitUntil` on `event.req` (srvx/Cloudflare ServerRequest pattern) for background cache writes

### HTTP handler caching (`http.ts`)

- `defineCachedHandler<E extends HTTPEvent>(handler, opts)` — wraps an `EventHandler` with response caching (generic over event type)
- Auto-generates cache keys from URL path + variable headers
- Handles `304 Not Modified` via `if-none-match`/`if-modified-since`
- Sets `cache-control`, `etag`, `last-modified` headers
- Filters non-variable headers before calling the handler (for consistent cache keys)
- Cacheable methods default to `GET`, `HEAD`, `QUERY` (override via `methods`); everything else bypasses the cache
- `QUERY` support (RFC 10008 — safe + idempotent, query carried in the request body):
  - Folds the request **body** + `content-type` + `accept` into the cache key (RFC 10008 §2.7 requires the key to incorporate request content) — see `_getBufferedBody` / `_resolveBodyKey`
  - Body stream is buffered once per event (`BODY_BUFFERS` WeakMap) and reused both for the key and to rebuild the request so the handler still receives its content
  - Built-in key normalization: JSON content types are canonicalized via structural hashing; skipped when the request carries `no-transform`. Override with `normalizeQueryKey(input)`
  - Sets `Vary: content-type, accept` on body-method responses; optional `acceptQuery` sets the `Accept-Query` response header (serialized as a Structured Fields list)
  - Conditional QUERY requests reuse the same `if-none-match`/`if-modified-since` 304 path as GET
- Framework integration hooks on `CachedEventHandlerOptions`:
  - `toResponse(value, event)` — convert handler return value to Response (default: plain Response constructor)
  - `createResponse(body, init)` — create the final Response from cached data (default: `new Response()`)
  - `handleCacheHeaders(event, conditions)` — custom 304 conditional check (default: built-in if-none-match/if-modified-since)
  - `normalizeQueryKey(input)` — normalize a body-bearing request's content before it's hashed into the cache key

### Storage (`storage.ts`)

- `StorageInterface` — minimal `get`/`set` with optional TTL
- Setting a nullish value (`null`/`undefined`) via `set` deletes the entry instead of storing dead weight
- `createMemoryStorage()` — in-memory Map-based implementation with TTL expiry
- `useStorage()` / `setStorage()` — global singleton, lazy-inits to memory storage

### Types (`types.ts`)

- `HTTPEvent` — `{ req: Request; url?: URL }` (url falls back to `new URL(req.url)`)
- `EventHandler<E>` — `(event: E) => unknown | Promise<unknown>` (generic, defaults to HTTPEvent)
- `CacheEntry<T>` — stored cache entry with value, expires, mtime, integrity
- `CacheOptions<T>` — maxAge, swr, staleMaxAge, base (string | string[] for multi-tier), getKey, validate, transform, etc.
- `CachedEventHandlerOptions<E>` — extends CacheOptions with headersOnly, varies, methods, acceptQuery, normalizeQueryKey, toResponse, createResponse, handleCacheHeaders
- `CacheConditions` — `{ modifiedTime?, maxAge?, etag? }` passed to handleCacheHeaders hook
- `ResponseCacheEntry` — serialized response (status, statusText, headers, body)

## Dependencies

- `ohash` — hashing for cache keys and integrity

## Dev Commands

- `pnpm vitest run test/` — run tests
- `pnpm exec tsgo --noEmit --skipLibCheck` — typecheck
- `pnpm build` — build with obuild

## Design Decisions

- No h3/srvx/unstorage dependency — fully standalone
- `waitUntil` is typed as optional on `ServerRequest` (`event.req`) — runtime-specific (srvx ServerRequest, Cloudflare), accessed via `event?.req.waitUntil?.(promise)`
- `event.url` is optional — `http.ts` falls back to `new URL(event.req.url)`
- Storage methods are `get`/`set` (not `getItem`/`setItem`)
- `base` supports `string | string[]` — multi-tier: reads try each prefix in order (first hit wins), writes go to all prefixes
- Default cache key group is `"functions"` (cache.ts) / `"handlers"` (http.ts) — no `ocache/` prefix
- Integrity hash excludes `base`, `group`, `name` (storage-location fields) so entries remain valid across different base configurations
