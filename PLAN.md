# Bugs & Potential Issues

-

## Upstream Nitro Issues

Issues and PRs from [nitrojs/nitro](https://github.com/nitrojs/nitro) that ocache should address:

### Key takeaways for ocache:

- ~~Cache invalidation is the #1 pain point — users need a first-class API for it~~ ✅ Added `invalidateCache()` and `.invalidate()` method
- SWR logic is buggy — staleMaxAge isn't respected properly, empty/404 responses get stuck
- Expired entries leak memory — they're never cleaned up
- Binary/streaming responses aren't handled well
- validate callback doesn't receive the original function args as documented
- Query param filtering for cache keys is a common request (allowQuery)
- Server-only caching (no Cache-Control headers sent to client) is wanted

### Cache Invalidation (most requested) — ✅ Resolved

- [#2218](https://github.com/nitrojs/nitro/issues/2218) — ✅ No API to invalidate cached function entries → `fn.invalidate()` + `invalidateCache()`
- [#3935](https://github.com/nitrojs/nitro/issues/3935) — ✅ Need easy cache invalidation helper → `.invalidate(...args)` on cached functions
- [#3969](https://github.com/nitrojs/nitro/issues/3969) — ✅ Programmatic cache invalidation at runtime → `invalidateCache()` standalone helper
- [#2738](https://github.com/nitrojs/nitro/issues/2738) — Clearing cache from handlers doesn't work as intended (browser-side caching — out of scope)
- [#2611](https://github.com/nitrojs/nitro/pull/2611) — PR: remove cached value when revalidation errors (separate concern)

### SWR (Stale-While-Revalidate) Bugs — ✅ Fixed in [#9](https://github.com/unjs/ocache/pull/9)

- [#3110](https://github.com/nitrojs/nitro/issues/3110) — ✅ Storage TTL set to `maxAge + staleMaxAge` when SWR enabled
- [#1992](https://github.com/nitrojs/nitro/issues/1992) — ✅ Stale entries evicted on failed bg revalidation (throw or invalid result)
- [#2606](https://github.com/nitrojs/nitro/pull/2606) — ✅ `staleMaxAge` respected at read time (`isFullyExpired` check)
- [#3263](https://github.com/nitrojs/nitro/pull/3263) — ✅ Storage TTL = `maxAge + staleMaxAge`
- [#4060](https://github.com/nitrojs/nitro/pull/4060) — ✅ Stale entry evicted from storage on revalidation failure

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
