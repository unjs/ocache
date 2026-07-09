# ocache

Composable caching primitives. works with any runtime that has standard `Request`/`Response`.

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
- Cache key `name` resolves as `opts.name || fn.name || \`anon_<hash(fn)>\``. Resolved once and written back into `opts`so the internal read/write path and the`resolveKeys`/`invalidate`/`expire` helpers all agree. Named/`fn.name`functions get a stable, human-readable name; anonymous functions fall back to a source hash so distinct inline fns don't collide (they would otherwise share one key and thrash). Caveat: a source hash can't tell apart same-source fns that differ only by closed-over variables — pass an explicit`name`(or`getKey`) for those. When reconstructing keys via the standalone `resolveCacheKeys`/`invalidateCache`/`expireCache`helpers (which can't see`fn`), always pass the same `name` you cached with
- `getMaxAge(entry)` option — dynamic per-entry TTL: runs after the resolver, returns a number (seconds, shorthand for `maxAge`) or `{ maxAge?, staleMaxAge? }` that override the static options for that entry. Resolved values are persisted on the entry (`CacheEntry.maxAge` / `CacheEntry.staleMaxAge`) and drive both the read freshness check and the storage TTL. Absent field / `undefined` → falls back to static options. Flows through to `defineCachedHandler`, where it runs before the internal `serialize` hook so `entry.value` is the live `Response` (inspect its headers/status; don't consume its body — `serialize` reads it exactly once)
- `serialize(entry, { args })` option — write-side counterpart of `transform`: runs once right after the resolver (and after `getMaxAge`, so that hook still sees the raw value) and returns the value to persist. `transform` deserializes it back on read. Use for resolver outputs a storage backend can't persist as-is (raw `ReadableStream`, class instances). It runs **exactly once per resolution** — shared across concurrent, deduplicated calls (every caller observes the serialized value), so consuming a one-shot source like a stream is safe. A throwing `serialize` fails the call and evicts, like a rejected resolver. Both `getMaxAge` and `serialize` are folded into the shared in-flight (`pending`) promise so they never run more than once
- `cachedFunction(fn, opts)` — alias for `defineCachedFunction`
- Returned cached function has `.resolveKeys(...args)`, `.invalidate(...args)`, and `.expire(...args)` methods
- `resolveCacheKeys({ options, args })` — standalone helper to resolve storage keys
- `invalidateCache({ options, args })` — standalone helper to remove cached entries across all base prefixes
- `expireCache({ options, args })` — standalone helper to mark entries stale (`CacheEntry.stale`) without removing them: SWR keeps serving stale within the original `staleMaxAge` window while the next access triggers a background refresh
- Uses `StorageInterface` via `useStorage()` for persistence
- Supports `waitUntil` on `event.req` (srvx/Cloudflare ServerRequest pattern) for background cache writes

### HTTP handler caching (`http.ts`)

- `defineCachedHandler<E extends HTTPEvent>(handler, opts)` — wraps an `EventHandler` with response caching (generic over event type)
- Split along the `serialize` seam (built on `cache.ts`'s `cachedFunction<Response>`): the **resolver** narrows the request and returns the handler's live `Response`; the internal **`serialize`** hook consumes the body (`res.arrayBuffer()`), synthesizes `etag`/`last-modified`/`cache-control`/`Vary`, strips non-allowlisted `Set-Cookie`s, and builds the stored `ResponseCacheEntry`; **`transform`** reconstructs the servable shape and injects the cache-status header on read. `serialize`/`validate`/`transform` are `Omit`ted from the user-facing `CachedEventHandlerOptions` so internal use doesn't collide
- Binary responses: `serialize` reads the body as bytes and decides by **byte validity, not content-type** — a valid-UTF-8 body (fatal `TextDecoder` with `ignoreBOM`, lossless roundtrip) is stored verbatim as a string (unchanged text behavior, stable text etags); anything else (images, protobuf/MVT tiles, arbitrary binary) is base64-encoded and flagged `base64: true` on the `ResponseCacheEntry`. Base64 (not a raw `Uint8Array`) so binary bodies survive JSON-serializing storage backends. On read, a `base64` entry is decoded back to a `Uint8Array` before `createResponse`, so the exact bytes replay untouched. `createResponse` therefore receives `string | Uint8Array | null` (widened from `string | null`)
- Auto-generates cache keys from URL path + variable headers
- Handles `304 Not Modified` via `if-none-match`/`if-modified-since`
- Sets `cache-control`, `etag`, `last-modified` headers — but never clobbers an explicit `cache-control` set by the handler (SWR/`s-maxage`/`max-age` directives are only synthesized when the handler didn't set one)
- `sendCacheControl: false` opts out of `cache-control` synthesis entirely (**server-only caching**, issue #49 / nitro#3997): the entry is still stored and served from cache (SWR/`etag`/`last-modified` unaffected), but no `Cache-Control` is advertised to clients/CDNs — without the `no-store`/`private` tricks that would also disqualify the entry from storage via `validate`. Only governs ocache's own synthesis (checked in the internal `serialize` hook); a `cache-control` the handler set explicitly is left untouched and still sent
- Emits a `Vary` response header from `opts.varies` (the same header names used for the cache key), merging with any `Vary` the handler already set (case-insensitive dedup, wildcard `*` left untouched) so downstream caches store per-variant
- Honors explicit `Cache-Control: no-store` / `private` on the response — those are never cached (rejected in `validate`), though still returned to the caller. This only governs storage: concurrent requests are still coalesced by cache key, so per-user responses must be keyed correctly (e.g. via `varies`)
- Cookies: **by default no cookies participate in caching** (secure default), in **both** directions. The `Cookie` request header is stripped before the handler runs and never varies the key; on the response side, any `Set-Cookie` outside the allowlist is **stripped in `serialize` before storage** (using `res.headers.getSetCookie()` so each cookie is inspected individually — the collapsed serialized headers would only show the last) so it can never reach a caller other than the one it was minted for. This closes issue #61: concurrent same-key requests are coalesced onto one resolution, so previously the leader's per-request `Set-Cookie` (e.g. a session id) was replayed to every deduplicated peer — a cross-user session leak. Stripping happens uniformly for that single shared resolution, so no peer (nor a future cache hit) sees it. The rest of the response is cached normally (mirrors how CDNs / Varnish drop `Set-Cookie` on cacheable responses). This is a **breaking behavior change**: a `Set-Cookie` is no longer returned to its direct caller by default — handlers that mint per-request cookies must either allowlist them or serve from a non-GET/HEAD (bypassed) route. On runtimes without `getSetCookie` individual cookies can't be enumerated, so **all** `Set-Cookie`s are stripped (fail safe). `validate` still rejects stored entries whose serialized headers carry a disallowed `set-cookie` — defense-in-depth for pre-existing/foreign entries written before the strip existed. `allowCookies: string[]` opts specific cookie names back in: only those survive in the handler-visible `Cookie` header and vary the key (sorted, order-independent — `_filterCookie`), and only those survive as `Set-Cookie` on the response (others are stripped, the rest still cached). Supersedes `varies: ["cookie"]`
- Transport headers (`content-encoding`, `content-length`, `transfer-encoding`) are stripped in `serialize` before storage (`_transportHeaders`): the body is stored fully decoded and re-buffered, so replaying an upstream `content-encoding: gzip` against a decompressed body (or a stale `content-length`/wire `transfer-encoding`) would desync the headers from the served body and yield malformed responses (nitro#2109). The runtime recomputes `content-length` from the served body on read
- Filters non-variable headers before calling the handler (for consistent cache keys)
- Request narrowing (variable-header filtering, cookie stripping, query narrowing) only applies to cacheable calls: non-GET/HEAD requests bypass the cache (`_shouldBypassCache`, composed with any caller `shouldBypassCache`) and reach the handler with their request untouched — including the body, which the rewritten `Request` would otherwise drop
- Bypassed responses pass through untouched: because `serialize` lives outside the resolver, a bypassed call (`cachedFunction` returns the resolver output raw — no `serialize`/`transform`) yields the handler's live `Response`, which the outer wrapper detects (`value instanceof Response`) and returns as-is. No body buffering (streaming/binary bodies survive), no synthesized cache headers, and no bogus `304` for a non-cacheable method — a **breaking behavior change** vs. the old always-serialize path (`fix(http)!`)
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
- `CacheOptions<T>` — maxAge, swr, staleMaxAge, getMaxAge (dynamic per-entry TTL hook), serialize (write-time hook, mirrors `transform`), base (string | string[] for multi-tier), getKey, validate, transform, etc.
- `CachedEventHandlerOptions<E>` — extends CacheOptions with headersOnly, varies, toResponse, createResponse, handleCacheHeaders
- `CacheConditions` — `{ modifiedTime?, maxAge?, etag? }` passed to handleCacheHeaders hook
- `ResponseCacheEntry` — serialized response (status, statusText, headers, body; optional `base64` flag when `body` is base64-encoded binary)

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
