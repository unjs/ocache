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
- `getMaxAge(entry)` option — dynamic per-entry TTL: runs after the resolver, returns a number (seconds, shorthand for `maxAge`) or `{ maxAge?, staleMaxAge? }` that override the static options for that entry. Resolved values are persisted on the entry (`CacheEntry.maxAge` / `CacheEntry.staleMaxAge`) and drive both the read freshness check and the storage TTL. Absent field / `undefined` → falls back to static options. Flows through to `defineCachedHandler` (entry value is the `ResponseCacheEntry`)
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
- Sets `cache-control`, `etag`, `last-modified` headers — but never clobbers an explicit `cache-control` set by the handler (SWR/`s-maxage`/`max-age` directives are only synthesized when the handler didn't set one)
- Honors explicit `Cache-Control: no-store` / `private` on the response — those are never cached (rejected in `validate`), though still returned to the caller. This only governs storage: concurrent requests are still coalesced by cache key, so per-user responses must be keyed correctly (e.g. via `varies`)
- `honorCacheControl` option (opt-in, default off) — honor the freshness directives on the handler (upstream) response's `Cache-Control` (`s-maxage` preferred over `max-age` → `maxAge`, `stale-while-revalidate` → `staleMaxAge`) when deriving the per-entry TTL. An upstream directive wins for its field (no clamping — it can shorten or extend); absent fields fall back to the user's `getMaxAge`, then the static `maxAge`/`staleMaxAge`. Per RFC 9111 §5.2.2.10, `s-maxage` implies `proxy-revalidate`: without an explicit `stale-while-revalidate`, `staleMaxAge` is forced to `0` (once stale — immediately for `s-maxage=0` — revalidation is blocking, never served stale). Only a handler-set `Cache-Control` counts as upstream: the resolver parses it _before_ the synthesized header is added and stashes it in a per-handler `WeakMap` keyed by response value, so the header synthesized from static options is never parsed back. `no-cache` is honored by never caching the response (rejected in `validate`, like `no-store`) — the handler runs on every request. `no-store` / `private` handling is independent (always honored)
- Filters non-variable headers before calling the handler (for consistent cache keys)
- Framework integration hooks on `CachedEventHandlerOptions`:
  - `toResponse(value, event)` — convert handler return value to Response (default: plain Response constructor)
  - `createResponse(body, init)` — create the final Response from cached data (default: `new Response()`)
  - `handleCacheHeaders(event, conditions)` — custom 304 conditional check (default: built-in if-none-match/if-modified-since)

### Storage (`storage.ts`)

- `StorageInterface` — minimal `get`/`set` with optional TTL
- Setting a nullish value (`null`/`undefined`) via `set` deletes the entry instead of storing dead weight
- `createMemoryStorage()` — in-memory Map-based implementation with TTL expiry
- `useStorage()` / `setStorage()` — global singleton, lazy-inits to memory storage

### Types (`types.ts`)

- `HTTPEvent` — `{ req: Request; url?: URL }` (url falls back to `new URL(req.url)`)
- `EventHandler<E>` — `(event: E) => unknown | Promise<unknown>` (generic, defaults to HTTPEvent)
- `CacheEntry<T>` — stored cache entry with value, expires, mtime, integrity
- `CacheOptions<T>` — maxAge, swr, staleMaxAge, getMaxAge (dynamic per-entry TTL hook), base (string | string[] for multi-tier), getKey, validate, transform, etc.
- `CachedEventHandlerOptions<E>` — extends CacheOptions with headersOnly, varies, honorCacheControl, toResponse, createResponse, handleCacheHeaders
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
