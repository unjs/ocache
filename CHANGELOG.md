# Changelog


## v0.2.0

[compare changes](https://github.com/unjs/ocache/compare/v0.1.5...v0.2.0)

### 🚀 Enhancements

- **storage:** Bound memory storage with optional maxSize + LRU eviction ([#38](https://github.com/unjs/ocache/pull/38))
- **cache:** Support dynamic per-entry TTL via `getMaxAge` hook ([#39](https://github.com/unjs/ocache/pull/39))
- Per-call cache status and `x-cache` response header ([#40](https://github.com/unjs/ocache/pull/40))
- **cache:** Support asynchronous validate option ([#44](https://github.com/unjs/ocache/pull/44))
- **cache:** ⚠️  Pass call args to `validate` ([#46](https://github.com/unjs/ocache/pull/46))
- **http:** Support `allowQuery` to filter query params ([#14](https://github.com/unjs/ocache/pull/14), [#29](https://github.com/unjs/ocache/pull/29))
- **http:** Support `shouldCache` to reject responses from caching ([#48](https://github.com/unjs/ocache/pull/48), [#55](https://github.com/unjs/ocache/pull/55))
- **http:** Emit `Vary` response header for `varies` ([#56](https://github.com/unjs/ocache/pull/56))
- **http:** ⚠️  `allowCookies` and disallow cookies from caching by default ([#58](https://github.com/unjs/ocache/pull/58))
- **cache:** Add write-time `serialize` hook ([#59](https://github.com/unjs/ocache/pull/59))
- **http:** Support binary response bodies ([#66](https://github.com/unjs/ocache/pull/66))
- **http:** Add `sendCacheControl` for server-only caching ([#49](https://github.com/unjs/ocache/pull/49), [#67](https://github.com/unjs/ocache/pull/67))
- **http:** Expose `.expire`/`.invalidate`/`.resolveKeys` on cached handlers ([#72](https://github.com/unjs/ocache/pull/72))

### 🩹 Fixes

- **http:** Honor explicit Cache-Control no-store/private ([#42](https://github.com/unjs/ocache/pull/42))
- **cache:** ⚠️  Never serve stale with `staleMaxAge: 0` ([#45](https://github.com/unjs/ocache/pull/45))
- **http:** Keep custom cache keys collision-free ([#60](https://github.com/unjs/ocache/pull/60))
- Leftovers from #58 ([#58](https://github.com/unjs/ocache/issues/58))
- **http:** Respect user-supplied `shouldBypassCache` ([#50](https://github.com/unjs/ocache/pull/50), [#62](https://github.com/unjs/ocache/pull/62))
- **cache:** ⚠️  Use `fn.name` for cache key when `name` option is omitted ([#63](https://github.com/unjs/ocache/pull/63))
- **http:** ⚠️  Strip non-allowlisted Set-Cookie instead of blocking storage ([#61](https://github.com/unjs/ocache/pull/61), [#68](https://github.com/unjs/ocache/pull/68))
- **http:** Strip transport headers from cached responses ([#74](https://github.com/unjs/ocache/pull/74))

### 💅 Refactors

- ⚠️  Disable `swr` by default ([#57](https://github.com/unjs/ocache/pull/57))
- **http:** ⚠️  Build `ResponseCacheEntry` in `serialize`; pass bypassed responses through untouched ([#65](https://github.com/unjs/ocache/pull/65))

### 📖 Documentation

- Add ISR caching section to README ([83f8091](https://github.com/unjs/ocache/commit/83f8091))
- Set up docs website ([#69](https://github.com/unjs/ocache/pull/69))
- Note sendCacheControl/ISR purge caveats ([4ffe207](https://github.com/unjs/ocache/commit/4ffe207))

### 🏡 Chore

- Update deps ([ddd1196](https://github.com/unjs/ocache/commit/ddd1196))
- Update deps ([aa5a4b6](https://github.com/unjs/ocache/commit/aa5a4b6))
- Remove plan.md ([956f513](https://github.com/unjs/ocache/commit/956f513))
- Update docs ([ab46d29](https://github.com/unjs/ocache/commit/ab46d29))

#### ⚠️ Breaking Changes

- **cache:** ⚠️  Pass call args to `validate` ([#46](https://github.com/unjs/ocache/pull/46))
- **http:** ⚠️  `allowCookies` and disallow cookies from caching by default ([#58](https://github.com/unjs/ocache/pull/58))
- **cache:** ⚠️  Never serve stale with `staleMaxAge: 0` ([#45](https://github.com/unjs/ocache/pull/45))
- **cache:** ⚠️  Use `fn.name` for cache key when `name` option is omitted ([#63](https://github.com/unjs/ocache/pull/63))
- **http:** ⚠️  Strip non-allowlisted Set-Cookie instead of blocking storage ([#61](https://github.com/unjs/ocache/pull/61), [#68](https://github.com/unjs/ocache/pull/68))
- ⚠️  Disable `swr` by default ([#57](https://github.com/unjs/ocache/pull/57))
- **http:** ⚠️  Build `ResponseCacheEntry` in `serialize`; pass bypassed responses through untouched ([#65](https://github.com/unjs/ocache/pull/65))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Pi0x <x@pi0.io>
- Raminjafary ([@raminjafary](https://github.com/raminjafary))
- Logosww ([@Logosww](https://github.com/Logosww))

## v0.1.5

[compare changes](https://github.com/unjs/ocache/compare/v0.1.4...v0.1.5)

### 🚀 Enhancements

- **cache:** Add `expireCache` and `.expire()` for SWR-friendly invalidation ([#23](https://github.com/unjs/ocache/pull/23))

### 🩹 Fixes

- **cache:** Handle eviction promise rejections and use waitUntil ([#16](https://github.com/unjs/ocache/pull/16))

### 🏡 Chore

- Update deps ([b9ac4b9](https://github.com/unjs/ocache/commit/b9ac4b9))

### ❤️ Contributors

- Pi0x <x@pi0.io>
- Balázs Németh ([@zsilbi](https://github.com/zsilbi))
- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.4

[compare changes](https://github.com/unjs/ocache/compare/v0.1.3...v0.1.4)

### 🔥 Performance

- **cache:** Skip writing to lower tiers on multi-tier cache hit ([4fe0de7](https://github.com/unjs/ocache/commit/4fe0de7))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.3

[compare changes](https://github.com/unjs/ocache/compare/v0.1.2...v0.1.3)

### 🚀 Enhancements

- Respect `staleMaxAge` ([8915db3](https://github.com/unjs/ocache/commit/8915db3))
- **cache:** Add `resolveCacheKey` and `.resolveKey()` ([#6](https://github.com/unjs/ocache/pull/6))
- **storage:** Nullish `set` deletes entry instead of storing dead weight ([71d5f11](https://github.com/unjs/ocache/commit/71d5f11))
- Multi-tier cache base ([#7](https://github.com/unjs/ocache/pull/7))
- **cache:** Add `invalidateCache()` and `.invalidate()` ([#8](https://github.com/unjs/ocache/pull/8))

### 🩹 Fixes

- Respect zero ttl ([#5](https://github.com/unjs/ocache/pull/5))
- **http:** Merge default options when partial opts are provided ([#2](https://github.com/unjs/ocache/pull/2))
- **cache:** Catch sync storage errors in get/set ([ee1bb02](https://github.com/unjs/ocache/commit/ee1bb02))
- **cache:** Evict stale entry on SWR revalidation failure ([#9](https://github.com/unjs/ocache/pull/9))
- **storage:** Proactively flush expired memory entries ([#10](https://github.com/unjs/ocache/pull/10))

### 🏡 Chore

- Apply automated updates ([4868309](https://github.com/unjs/ocache/commit/4868309))
- Apply automated updates (attempt 2/3) ([05c9f4e](https://github.com/unjs/ocache/commit/05c9f4e))
- Update deps ([94a2b26](https://github.com/unjs/ocache/commit/94a2b26))
- Apply automated updates ([b028820](https://github.com/unjs/ocache/commit/b028820))
- Apply automated updates ([ed51d82](https://github.com/unjs/ocache/commit/ed51d82))
- Apply automated updates ([459bade](https://github.com/unjs/ocache/commit/459bade))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Ori ([@oritwoen](https://github.com/oritwoen))
- Florian Heuberger

## v0.1.2

[compare changes](https://github.com/unjs/ocache/compare/v0.1.1...v0.1.2)

### 🚀 Enhancements

- **http:** Add framework integration hooks to `defineCachedHandler` ([2bfd379](https://github.com/unjs/ocache/commit/2bfd379))

### 🏡 Chore

- Update plan with nitro upstream requests ([7f61e38](https://github.com/unjs/ocache/commit/7f61e38))
- Apply automated updates ([e8febf0](https://github.com/unjs/ocache/commit/e8febf0))
- Apply automated updates (attempt 2/3) ([e061d46](https://github.com/unjs/ocache/commit/e061d46))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.1

[compare changes](https://github.com/unjs/ocache/compare/v0.1.0...v0.1.1)

### 💅 Refactors

- Remove ufo dep ([ec65378](https://github.com/unjs/ocache/commit/ec65378))

### 🏡 Chore

- Apply automated updates ([1ae48ce](https://github.com/unjs/ocache/commit/1ae48ce))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

