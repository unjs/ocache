# Changelog


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

