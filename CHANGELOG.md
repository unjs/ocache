# Changelog


## v0.3.0

[compare changes](https://github.com/unjs/ocache/compare/v0.2.0...v0.3.0)

### 🚀 Enhancements

- **storage:** ⚠️  Only per-instance storage ([ce8e0e6](https://github.com/unjs/ocache/commit/ce8e0e6))
- **storage:** ⚠️  Bound memory storage by bytes, not just entry count ([#90](https://github.com/unjs/ocache/pull/90))
- **cache:** ⚠️  `maxResolveTime` defaulting  to 30sec ([#85](https://github.com/unjs/ocache/pull/85))
- Standalone hash ([5f97883](https://github.com/unjs/ocache/commit/5f97883))
- **cache:** Abort abandoned resolutions on timeout ([e3a7dfd](https://github.com/unjs/ocache/commit/e3a7dfd))
- **http:** Limit the body size that may be buffered ([b4e1034](https://github.com/unjs/ocache/commit/b4e1034))
- **storage:** Support native binary storage ([df3a009](https://github.com/unjs/ocache/commit/df3a009))
- **cache:** Support binary values in cached functions ([5ef98f3](https://github.com/unjs/ocache/commit/5ef98f3))
- **storage:** `createBlobStorage` frame codec ([5a73e3c](https://github.com/unjs/ocache/commit/5a73e3c))
- **storage:** Reserve blob frame compression flags ([bc49c15](https://github.com/unjs/ocache/commit/bc49c15))
- **cache:** WaitUntil option for background work ([ce0fbae](https://github.com/unjs/ocache/commit/ce0fbae))
- **http:** ⚠️  Make allowQuery opt-in ([2b0f7e8](https://github.com/unjs/ocache/commit/2b0f7e8))
- **storage:** Add `composeStorage` for layered backends ([0bd1b01](https://github.com/unjs/ocache/commit/0bd1b01))
- **http:** Add opt-in stream to serve a fill while it buffers ([548ad7a](https://github.com/unjs/ocache/commit/548ad7a))

### 🔥 Performance

- Speed-up hashing ([ad2a22e](https://github.com/unjs/ocache/commit/ad2a22e))
- **http:** Derive the key prefix without a second URL parse ([23e53fb](https://github.com/unjs/ocache/commit/23e53fb))
- **http:** Encode binary bodies with the runtime's own base64 ([9f22264](https://github.com/unjs/ocache/commit/9f22264))

### 🩹 Fixes

- **http:** Strip credentials by default, forward varies headers ([61f09db](https://github.com/unjs/ocache/commit/61f09db))
- **http:** ⚠️  Key HEAD entries separately from GET ([5160adc](https://github.com/unjs/ocache/commit/5160adc))
- **http:** ⚠️  Never cache or return Set-Cookie on cacheable routes ([e3975c5](https://github.com/unjs/ocache/commit/e3975c5))
- **http:** ⚠️  Advertise Vary: Cookie when allowCookies is set ([2710f10](https://github.com/unjs/ocache/commit/2710f10))
- **http:** Never store or replay null-body statuses (204/205/304) ([d975131](https://github.com/unjs/ocache/commit/d975131))
- **cache:** Use a Map for in-flight dedup so prototype-named keys resolv ([529fbda](https://github.com/unjs/ocache/commit/529fbda))
- **http:** Carry bound waitUntil onto the narrowed request ([daac727](https://github.com/unjs/ocache/commit/daac727))
- **http:** ⚠️  Forward the raw Cookie header when varies includes "cookie" ([47731fb](https://github.com/unjs/ocache/commit/47731fb))
- **http:** ⚠️  Resolve handler name before merging defaults ([bdf8c84](https://github.com/unjs/ocache/commit/bdf8c84))
- **http:** ⚠️  Include the request authority in the cache key ([fb0efaa](https://github.com/unjs/ocache/commit/fb0efaa))
- **http:** ⚠️  Gate storage and cache-control on a cacheable-status allowlist ([14f8019](https://github.com/unjs/ocache/commit/14f8019))
- **http:** ⚠️  Honor no-cache, zero lifetimes and Vary:* as storage opt-outs ([c3501ea](https://github.com/unjs/ocache/commit/c3501ea))
- **http:** ⚠️  Fail closed on a handler-declared Vary we don't key on ([660bee6](https://github.com/unjs/ocache/commit/660bee6))
- **http:** Respect shouldBypassCache when narrowing requests ([12f09f0](https://github.com/unjs/ocache/commit/12f09f0))
- **cache:** Never store an entry with neither an expiry nor a TTL ([183f36a](https://github.com/unjs/ocache/commit/183f36a))
- **http:** ⚠️  Advertise the lifetimes ocache actually enforces ([#86](https://github.com/unjs/ocache/pull/86))
- **cache:** ⚠️  Escape the name segment of the storage key ([#88](https://github.com/unjs/ocache/pull/88))
- **http:** Copy response headers before serializing ([ec43253](https://github.com/unjs/ocache/commit/ec43253))
- **http:** ⚠️  Narrow request headers by allowlist ([#91](https://github.com/unjs/ocache/pull/91))
- **hash:** Length-prefix text in serialize to prevent key collisions ([a20beb4](https://github.com/unjs/ocache/commit/a20beb4))
- **hash:** Treat a null constructor as a plain object ([d11521f](https://github.com/unjs/ocache/commit/d11521f))
- **http:** Never cache a request that could not be narrowed ([2035d6d](https://github.com/unjs/ocache/commit/2035d6d))
- **hash:** Render built-ins by value and length-prefix type tags ([00b399e](https://github.com/unjs/ocache/commit/00b399e))
- **hash:** Collapse a line break in function source to a space ([623d714](https://github.com/unjs/ocache/commit/623d714))
- **http:** Narrow Host to the keyed URL authority ([b8d95f3](https://github.com/unjs/ocache/commit/b8d95f3))
- **hash:** Cap traversal depth instead of overflowing the stack ([0abcfd1](https://github.com/unjs/ocache/commit/0abcfd1))
- **storage:** Close two byte-ceiling bypasses ([bdf47ad](https://github.com/unjs/ocache/commit/bdf47ad))
- **http:** Give If-None-Match precedence over If-Modified-Since ([6014259](https://github.com/unjs/ocache/commit/6014259))
- **cache:** Fence in-flight resolutions against a concurrent purge ([0cb0de7](https://github.com/unjs/ocache/commit/0cb0de7))
- **cache:** Stop discarding falsy transform results ([9ef94f6](https://github.com/unjs/ocache/commit/9ef94f6))
- **http:** Decide headersOnly 304s from the handler's own validators ([ff31b27](https://github.com/unjs/ocache/commit/ff31b27))
- **http:** Domain-separate binary and text etags ([71aa086](https://github.com/unjs/ocache/commit/71aa086))
- **http:** Stop synthesizing last-modified ([d4eea12](https://github.com/unjs/ocache/commit/d4eea12))
- **cache:** Require matching integrity to serve stale ([74cdcad](https://github.com/unjs/ocache/commit/74cdcad))
- **cache:** Order a purge after an in-flight write ([9f1bc84](https://github.com/unjs/ocache/commit/9f1bc84))
- **http:** Remove unkeyed header exemptions ([acf56ab](https://github.com/unjs/ocache/commit/acf56ab))
- **cache:** Escape the group cache key segment ([1747b51](https://github.com/unjs/ocache/commit/1747b51))
- **http:** Echo validators and cache policy on 304 ([07931fc](https://github.com/unjs/ocache/commit/07931fc))
- **http:** ⚠️  Refuse handler values the default `toResponse` cannot convert ([981ac27](https://github.com/unjs/ocache/commit/981ac27))

### 💅 Refactors

- Split http ([58b78d0](https://github.com/unjs/ocache/commit/58b78d0))
- **http:** Drop the per-request WeakMaps from handler config ([080635b](https://github.com/unjs/ocache/commit/080635b))
- Allocate fences on first usage ([c6e7492](https://github.com/unjs/ocache/commit/c6e7492))
- Move errors to one place ([204bf69](https://github.com/unjs/ocache/commit/204bf69))

### 📖 Documentation

- Add caution ([c1ba6e2](https://github.com/unjs/ocache/commit/c1ba6e2))
- Fix three false claims in the cache-control guide ([#89](https://github.com/unjs/ocache/pull/89))
- Cleanup ([770b7f3](https://github.com/unjs/ocache/commit/770b7f3))
- Update links ([af1f0e3](https://github.com/unjs/ocache/commit/af1f0e3))
- Rewrite ([14af2a1](https://github.com/unjs/ocache/commit/14af2a1))
- Migration guide ([ae031ad](https://github.com/unjs/ocache/commit/ae031ad))
- Add integrations ([6824172](https://github.com/unjs/ocache/commit/6824172))
- Update landing and integrations ([e967a94](https://github.com/unjs/ocache/commit/e967a94))

### 🏡 Chore

- Update deps ([dcd5177](https://github.com/unjs/ocache/commit/dcd5177))
- Update undocs ([90d3105](https://github.com/unjs/ocache/commit/90d3105))
- Update undocs ([424e8a8](https://github.com/unjs/ocache/commit/424e8a8))
- Fix docs publish action ([ffaedf1](https://github.com/unjs/ocache/commit/ffaedf1))
- Bundle test script ([19175c2](https://github.com/unjs/ocache/commit/19175c2))
- Update agents.md ([dbaeab3](https://github.com/unjs/ocache/commit/dbaeab3))
- Compact comments ([8cb1f0a](https://github.com/unjs/ocache/commit/8cb1f0a))
- Update agent docs ([3e5a58a](https://github.com/unjs/ocache/commit/3e5a58a))
- Apply automated updates ([7b83837](https://github.com/unjs/ocache/commit/7b83837))
- Update docs ([f5b1bc4](https://github.com/unjs/ocache/commit/f5b1bc4))
- Update deps ([995cc14](https://github.com/unjs/ocache/commit/995cc14))
- Apply automated updates ([2cd08cb](https://github.com/unjs/ocache/commit/2cd08cb))
- Apply automated updates ([fb46cc4](https://github.com/unjs/ocache/commit/fb46cc4))
- Add basic logoc ([9830433](https://github.com/unjs/ocache/commit/9830433))
- Add bench suite ([021f9c8](https://github.com/unjs/ocache/commit/021f9c8))
- Add docs refs ([efa97a8](https://github.com/unjs/ocache/commit/efa97a8))
- Remove docs workflow ([d13069e](https://github.com/unjs/ocache/commit/d13069e))
- Responsive benchs page ([43f6f36](https://github.com/unjs/ocache/commit/43f6f36))
- Apply automated updates ([0031ddf](https://github.com/unjs/ocache/commit/0031ddf))
- Apply automated updates ([2b60b74](https://github.com/unjs/ocache/commit/2b60b74))
- Use pm-install ([54bb967](https://github.com/unjs/ocache/commit/54bb967))
- Update benchs ([130d4b8](https://github.com/unjs/ocache/commit/130d4b8))

#### ⚠️ Breaking Changes

- **storage:** ⚠️  Only per-instance storage ([ce8e0e6](https://github.com/unjs/ocache/commit/ce8e0e6))
- **storage:** ⚠️  Bound memory storage by bytes, not just entry count ([#90](https://github.com/unjs/ocache/pull/90))
- **cache:** ⚠️  `maxResolveTime` defaulting  to 30sec ([#85](https://github.com/unjs/ocache/pull/85))
- **http:** ⚠️  Make allowQuery opt-in ([2b0f7e8](https://github.com/unjs/ocache/commit/2b0f7e8))
- **http:** ⚠️  Key HEAD entries separately from GET ([5160adc](https://github.com/unjs/ocache/commit/5160adc))
- **http:** ⚠️  Never cache or return Set-Cookie on cacheable routes ([e3975c5](https://github.com/unjs/ocache/commit/e3975c5))
- **http:** ⚠️  Advertise Vary: Cookie when allowCookies is set ([2710f10](https://github.com/unjs/ocache/commit/2710f10))
- **http:** ⚠️  Forward the raw Cookie header when varies includes "cookie" ([47731fb](https://github.com/unjs/ocache/commit/47731fb))
- **http:** ⚠️  Resolve handler name before merging defaults ([bdf8c84](https://github.com/unjs/ocache/commit/bdf8c84))
- **http:** ⚠️  Include the request authority in the cache key ([fb0efaa](https://github.com/unjs/ocache/commit/fb0efaa))
- **http:** ⚠️  Gate storage and cache-control on a cacheable-status allowlist ([14f8019](https://github.com/unjs/ocache/commit/14f8019))
- **http:** ⚠️  Honor no-cache, zero lifetimes and Vary:* as storage opt-outs ([c3501ea](https://github.com/unjs/ocache/commit/c3501ea))
- **http:** ⚠️  Fail closed on a handler-declared Vary we don't key on ([660bee6](https://github.com/unjs/ocache/commit/660bee6))
- **http:** ⚠️  Advertise the lifetimes ocache actually enforces ([#86](https://github.com/unjs/ocache/pull/86))
- **cache:** ⚠️  Escape the name segment of the storage key ([#88](https://github.com/unjs/ocache/pull/88))
- **http:** ⚠️  Narrow request headers by allowlist ([#91](https://github.com/unjs/ocache/pull/91))
- **http:** ⚠️  Refuse handler values the default `toResponse` cannot convert ([981ac27](https://github.com/unjs/ocache/commit/981ac27))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Pi0x <x@pi0.io>

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

