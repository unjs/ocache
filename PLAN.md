# Bugs & Potential Issues

## Bugs

### ~~1. Shared `_memoryStorage` Map across `createMemoryStorage()` calls~~ (not a bug)

Already correct — `Map` is created inside `createMemoryStorage()`, not at module level.

### ~~2. Sync storage errors crash instead of being caught~~ (fixed)

Replaced `Promise.resolve(syncCall()).catch(...)` with try/catch + await in `cache.ts` for both `get()` and `set()` calls.

## Potential Issues

### 3. `swr: false` + `staleMaxAge >= 0` clears entry but still resolves

**File:** `src/cache.ts:75-81`

When `swr` is false and the entry is expired, `entry.value` is set to `undefined` before resolving. This means concurrent requests during resolution will all re-invoke the resolver (no dedup benefit), since the pending check only guards the initial call.

### 4. `defineCachedHandler` default parameter vs spread

**File:** `src/http.ts:24`

The default `opts = defaultCacheOptions()` only applies when no opts are passed at all. There's no spread with defaults inside the function body (unlike `cache.ts:25`), so passing `{ maxAge: 60 }` without `swr` means `opts.swr` is `undefined` — which is falsy, changing the cache-control header behavior silently.

### 5. ETag/header validation uses string `"undefined"`

**File:** `src/http.ts:68-69`

Checks `=== "undefined"` (the string), which would only happen if someone explicitly set the header to the literal string `"undefined"` — an unlikely but fragile guard.

## Upstream Nitro Issues

Issues and PRs from [nitrojs/nitro](https://github.com/nitrojs/nitro) that ocache should address:

### Key takeaways for ocache:

- Cache invalidation is the #1 pain point — users need a first-class API for it
- SWR logic is buggy — staleMaxAge isn't respected properly, empty/404 responses get stuck
- Expired entries leak memory — they're never cleaned up
- Binary/streaming responses aren't handled well
- validate callback doesn't receive the original function args as documented
- Query param filtering for cache keys is a common request (allowQuery)
- Server-only caching (no Cache-Control headers sent to client) is wanted

### Cache Invalidation (most requested)

- [#2218](https://github.com/nitrojs/nitro/issues/2218) — No API to invalidate cached function entries
- [#3935](https://github.com/nitrojs/nitro/issues/3935) — Need easy cache invalidation helper for `defineCachedFunction`/`defineCachedHandler`
- [#3969](https://github.com/nitrojs/nitro/issues/3969) — Programmatic cache invalidation at runtime
- [#2738](https://github.com/nitrojs/nitro/issues/2738) — Clearing cache from handlers doesn't work as intended
- [#2611](https://github.com/nitrojs/nitro/pull/2611) — PR: remove cached value when revalidation errors

### SWR (Stale-While-Revalidate) Bugs

- [#3110](https://github.com/nitrojs/nitro/issues/3110) — SWR prevents cache expiration (stale entries never expire)
- [#1992](https://github.com/nitrojs/nitro/issues/1992) — SWR cached routes never update if response is empty or 404
- [#2606](https://github.com/nitrojs/nitro/pull/2606) — PR: respect `staleMaxAge` option
- [#3263](https://github.com/nitrojs/nitro/pull/3263) — PR: use `staleMaxAge` to compute cache item TTL
- [#4060](https://github.com/nitrojs/nitro/pull/4060) — PR: fix SWR cache invalidation

### Expired Entries & Memory Leaks

- [#2138](https://github.com/nitrojs/nitro/issues/2138) — Expired cache entries never get flushed

### Binary/Streaming Response Caching

- [#3831](https://github.com/nitrojs/nitro/issues/3831) — `defineCachedEventHandler` serializes Buffer to JSON, breaking binary responses
- [#3580](https://github.com/nitrojs/nitro/pull/3580) — PR: streaming cache responses
- [#2933](https://github.com/nitrojs/nitro/pull/2933) — PR: cache event handler stream response

### Validate / Transform Options

- [#3525](https://github.com/nitrojs/nitro/issues/3525) — `validate` says it receives `...args` but doesn't
- [#3491](https://github.com/nitrojs/nitro/issues/3491) — Can't override `validate` on `defineCachedEventHandler`
- [#3530](https://github.com/nitrojs/nitro/pull/3530) — PR: pass args to validate method

### Cache Key Issues

- [#4078](https://github.com/nitrojs/nitro/pull/4078) / [#4079](https://github.com/nitrojs/nitro/pull/4079) — PR: add `allowQuery` option to filter query params in cache key
- [#1880](https://github.com/nitrojs/nitro/issues/1880) — Vercel preset: query params ignored by cache

### HTTP Handler Bugs

- [#1745](https://github.com/nitrojs/nitro/issues/1745) — `defineCachedEventHandler` + `proxyRequest` hangs indefinitely
- [#3468](https://github.com/nitrojs/nitro/issues/3468) — `defineCachedEventHandler` resets session (causes logout)
- [#3464](https://github.com/nitrojs/nitro/issues/3464) — `getUserSession(event)` returns partial session in cachedEventHandler
- [#3997](https://github.com/nitrojs/nitro/issues/3997) — Allow server-only caching (disable Cache-Control headers)
- [#1695](https://github.com/nitrojs/nitro/issues/1695) — Add custom headers for cached response

### Misc Enhancements

- [#3369](https://github.com/nitrojs/nitro/pull/3369) — PR: custom `serialize` option for CacheOptions
- [#3157](https://github.com/nitrojs/nitro/pull/3157) — PR: use function name for cache key in `defineCachedFunction`
