# Bugs & Potential Issues

## Bugs

### 1. Shared `_memoryStorage` Map across `createMemoryStorage()` calls

**File:** `src/_storage.ts:10-13`

The `Map` is module-level, so every `createMemoryStorage()` call returns a new interface but shares the same backing store. This means `setStorage(createMemoryStorage())` doesn't actually reset the cache — stale entries from previous usage persist.

### 2. Sync storage errors crash instead of being caught

**File:** `src/cache.ts:48-51`, `src/cache.ts:106-110`

`Promise.resolve(useStorage().get(...)).catch(...)` — if `get()` throws synchronously, the error escapes `Promise.resolve()` in some runtimes. Only rejected promises are caught. Same issue with `set()`.

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
