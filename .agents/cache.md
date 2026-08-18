# `cache.ts` — core caching

This file describes `defineCachedFunction`, `cachedFunction`, and the standalone helpers. The HTTP layer uses all of this behavior. See `.agents/http/key.md` and `.agents/http/response.md`.

## Cache key `name`

`resolveName(opts.name, fn)` → `opts.name || fn.name || anon_<hash(fn)>`. `cache.ts` exports this function. `http/config.ts` uses the same function and passes the wrapped `EventHandler` as `fn`. The two paths must not use different name rules.

- Call `resolveName` on the caller's options **before** you merge defaults. If you merge first, the default `"_"` always wins. This error caused issue #53's fix to miss the HTTP layer. Every handler then used `"_"` as its name. See `.agents/http/key.md` for the resulting collision.
- Anonymous functions use a source hash. This prevents distinct inline functions from sharing one key and repeatedly replacing each other. **Caveat**: a source hash cannot distinguish functions that have the same source but different closed-over variables. Pass an explicit `name` or `getKey` in this case. Do not use per-instance counters, `WeakMap` identity, or randomness. Persistent backends require deterministic keys across process restarts.
- The standalone `resolveCacheKeys`, `invalidateCache`, and `expireCache` helpers cannot see `fn`. Always pass the same `name` that the cached function used.
- Escape the segment with `escapeKeySegment` inside `buildCacheKey`. This location makes every path use the same rule. The rule removes non-word characters. If it changes the input, it adds `.<hash(raw)>`. Previously, `name` was the last raw segment. This was harmless while all handlers used `"_"`. It became unsafe when names came from `fn.name`, which has no controlled alphabet. For example, `named.bind(null)` has the name `bound named`. A handler named `page:HEAD` produced exactly the key used by the HEAD variant of a handler named `page`. The defect affected only names with an escapable character. It affected about one `anon_<hash>` in five because the base64url alphabet includes `-`. `name` is outside the integrity hash. A moved entry therefore causes one cold read. The cache does not find the entry, so it never rejects the entry after finding it.

## Option merging

**Treat an option with the explicit value `undefined` as unset.** Use the exported `definedOptions` function at both defaults merges: in this module and in `http/config.ts` through `resolveHandlerConfig`.

Object spread copies own properties whose value is `undefined`. Therefore, `{ ...defaults(), ...opts }` allowed `{ maxAge: undefined }` to replace the default `maxAge: 1`, while `{}` kept the default. Measurements showed that `{}` resolved once and wrote `{ ttl: 1 }`. `{ maxAge: undefined }` resolved on every call and wrote nothing. Configuration plumbing commonly creates this value. For example, `defineCachedHandler(h, { maxAge: routeConfig.maxAge })` creates it when the route has no rule. The route then stopped caching without an error. This behavior existed before finding 10.6. Before that finding, the same difference cached forever. Every option, including `swr`, `staleMaxAge`, `storage`, `getKey`, and `varies`, had the same problem.

Drop only `undefined`. Keep `null` as a nullish, refused lifetime. Apply the operation to a **copy**. The caller's object is the storage memo slot. `resolveName` and `resolveStorage` read the original object. The operation must be idempotent because the handler path merges twice. This behavior **subsumes** the removed `swr`-without-`maxAge` normalization in `resolveMaxAge`. No defaults merge can now produce a configuration without `maxAge`. Only an explicit value `<= 0` or a `getMaxAge` result can produce a zero lifetime. `{ swr: true, staleMaxAge: 600 }` caches for the default one second, as `{}` always did.

## Lifetimes and the storage TTL

`storageTtl(maxAge, staleMaxAge, swr)` is the only decision point. It returns `{ ttl }`, `undefined` for storage without a TTL, or `false` to prevent storage. `remainingTtl`, which rewrites entries for `expireCache`, derives from the same call. Expiration therefore cannot extend a lifetime, remove a TTL, or add a TTL that the write omitted. Earlier code copied this logic, which let the three paths differ.

Rule: **never write an entry that has neither an expiry nor a storage TTL** (finding 10.6). Distinguish these two cases:

- `{ swr: true, maxAge: 60 }` **has** an expiry in `entry.expires` but has no TTL. Storage retains it after it becomes stale. This retention provides ISR. The cache serves the last good value while a background refresh replaces it. If refresh fails, the cache continues to serve the last success. Next's `revalidate` marks a page as eligible for regeneration and does not delete it. Vercel limits ISR by capacity, not by a timer. `x-cache` mirrors `x-nextjs-cache` values HIT, STALE, and MISS. This case is **allowed**. Finding 14.3 proposed a default TTL of `maxAge`. That proposal was **rejected**. Such a TTL would delete the entry as soon as it became stale. It would turn SWR into foreground revalidation and make `docs/1.guide/9.isr.md` impossible. Backend **capacity** limits this case. Since finding 14.1, the built-in backend has a capacity limit. See `.agents/storage.md`.
- `{ maxAge: 0 }`, including a `getMaxAge` value clamped to zero, has no usable fresh period and no reclaim rule. Storage would create a permanent HIT. The cache **refuses** this case and evicts any previous entry for the key. This also removes entries written by older ocache versions. A nullish `maxAge` is also refused. Both defaults merges supply `maxAge: 1`, and explicit `undefined` no longer removes it. Therefore, the nullish case is reachable only through standalone `expireCache`, which does not merge defaults.

## Freshness vs. validity

`expired` mixes two kinds of condition, and only one of them may serve a stale value.

- **Freshness**: `entry.stale === true` (from `expire`), an elapsed `maxAge`, `readMaxAge === 0`, and `shouldInvalidateCache`. The stored value is this function's own output and is merely unwanted. SWR serves it while a background refresh runs.
- **Validity**: an `integrity` mismatch and a failing `validate`. The stored value does not belong to this function at all. It must never reach a caller. These force foreground revalidation, so the status is `revalidated`, never `stale`.

`validate` was already excluded from the stale branch. `integrity` was not. Two functions that shared `storage`, `name`, and key but hashed differently reproduced the defect: the second function's first call returned the first function's value, and the background refresh corrected only later calls. This is cross-handler disclosure wherever storage-key namespaces collide, and it also serves a pre-deploy value after the function source or options change. Both serve decisions — the `status` expression and the SWR early return — read one captured `isMatched`. Do not read `entry.integrity` at the second site: the background `resolveEntry` reassigns that field, so the check would race.

## Hooks

- `getMaxAge(entry)` sets a dynamic per-entry TTL after the resolver runs. It returns seconds as shorthand for `maxAge`, or `{ maxAge?, staleMaxAge? }`. The cache stores the result on the entry. It controls read freshness, storage TTL, and the `Cache-Control` value that `defineCachedHandler` creates (finding 10.2). It runs before `serialize`, so `entry.value` is still live. Do not consume a one-use body. `serialize` reads that body exactly once. `http/index.ts` always installs a wrapper. A handler entry therefore always has both fields. `undefined` means "no override," not "hook not called." This distinction makes the finding 10.2 advertisement correct.
- `serialize(entry, { args })` is the write-side counterpart to `transform`, which deserializes on read. Use it for resolver values that a backend cannot persist directly, such as a raw `ReadableStream` or a class instance. It runs **exactly once per resolution**. Deduplicated callers share that result, so it may safely consume a one-use source. If it throws, the call fails and the cache evicts the entry, as it does for a rejected resolver. The shared in-flight promise includes both hooks, so neither hook runs twice.

## Dedup registry

`pending` must be a **`Map`, never a plain object**. Keys are controlled by callers through documented code such as `getKey: (id) => id`. A plain object inherits from `Object.prototype`. Therefore, `pending["constructor"]`, `pending["toString"]`, and `pending["__proto__"]` can be truthy when no work is in progress. Earlier code treated such a call as a follower. It awaited the inherited member, which was not a thenable and resolved to itself. It did not call the resolver and cached `undefined`. `defineCachedFunction` failed silently. `defineCachedHandler` produced a permanent `TypeError` because `transform` read `undefined.headers`. A custom `getKey` was required to trigger this error. This was unsafe prototype-chain reading, not prototype pollution.

## Resolution deadline

**`maxResolveTime` uses seconds and defaults to `30`.** It limits one shared in-flight resolution. The limit covers the resolver and the `getMaxAge` and `serialize` hooks in the same `pending` promise through `withDeadline`. `Infinity`, `0`, and negative values disable the limit. This matches `createMemoryStorage` normalization. Hooks must be included because `serialize` can drain a body that never ends. A limit around only `resolver()` would miss the measured failure.

A resolution that never settled was the only leak in the `pending` lifecycle. Cleanup already covered success, rejection, and throws from `getMaxAge`, `serialize`, or `validate`. One stalled upstream kept its slot forever. Every later request for the key followed work that could never finish. The key remained unusable until process restart. Finding 03, part 2 measured both `req1` and `req2` as unsettled after 10 s.

- **Reject waiters** with `TimeoutError`, which is the name used by `AbortSignal.timeout()`. Do not only remove the `pending` entry. A caller waiting for work that cannot finish remains open until an external system ends it. A serverless runtime may provide no such system. The weaker behavior also fails the finding's regression test because the second request is already a follower when the deadline expires. Rejection also prevents a late resolver from writing. The storage write occurs after the awaited deadline wrapper. A stale result therefore cannot overwrite a key that a new leader has resolved.
- The operation is not **cancelled** because there is no `AbortSignal` to pass to `fn`. The resolver continues to run. `withDeadline` keeps rejection handlers attached, so a late rejection does not become unhandled. The timer uses `unref()` and is cleared on **every** settle path. Use `.then(f, f)`, not `.finally`, because `.finally` would create a rejected promise with no listener.
- Treat a timeout as a failed resolution in every way, including storage eviction. "The resolution failed" must have one meaning in this file. Different timeout behavior would decide only one part of the open 19.3 question about eviction after failure. Use existing error behavior. Throw foreground errors to the caller. Report background refresh errors through `onError`. Both paths use the same deadline.
- Use **seconds, not milliseconds**, and keep the `max*` name. All other time values here use seconds: `maxAge`, `staleMaxAge`, the `getMaxAge` result, and storage `ttl`. If `maxResolveTime: 30` meant 30 ms, the setting could appear valid while no practical resolver survived. Documentation cannot correct that silent failure. The name `resolverTimeout` was rejected because `timeout` commonly uses milliseconds in `setTimeout`, `AbortSignal.timeout()`, ofetch, undici, and axios. `max*` also identifies the correct scope: the full shared resolution and its hooks. Fractions such as `0.5` allow sub-second limits. Apply `× 1000` at `setTimeout`. The `TimeoutError` message reports the configured seconds. `maxResolveTimeSeconds` remains rejected because it would be the only option with a unit suffix and would imply that other units are unclear.
- Do **not** put this value in `defaultCacheOptions()` or `defaultHandlerOptions()`. If the default became an own key on `opts`, it would change integrity and make every existing entry cold. An explicit setting causes one integrity change. Keep the option in `integrityOpts` because it is not a storage-location field. `http/index.ts` spreads caller options into `_opts`, so the setting already reaches `defineCachedHandler`.

This limit has two effects. First, an upstream that would finish at 31 s now fails at 30 s. Raise or disable the setting if needed. Second, the extra promise between resolution and the leader's write changes synchronous SWR refresh timing. A synchronous resolver no longer updates `entry.value` before the serve path returns. SWR now serves the stale value for both synchronous and asynchronous resolvers. The earlier synchronous behavior depended on microtask timing; asynchronous resolvers never finished in time. `test/index.test.ts` asserts the new behavior. Storage `get` and `set` remain outside the shared promise. A stalled backend is a separate problem.

## Purge helpers

The returned function provides `.resolveKeys(...args)`, `.invalidate(...args)`, and `.expire(...args)`. Standalone forms are `resolveCacheKeys`, `invalidateCache`, and `expireCache({ options, args })`. `expire` marks entries stale without removing them. SWR can serve stale data within the original `staleMaxAge` window while the next access refreshes it in the background.

- Standalone helpers are generic over `args` and do not understand HTTP methods. For a `defineCachedHandler` key, they affect only the method variant implied by `args`. Use the handler's `.invalidate(event)` or `.expire(event)` methods. See `.agents/http/key.md`.
- These helpers can reach a store only when they receive the **same options object**, where the resolved storage is memoized, or an explicit `storage`. If storage is unset, `requireStorage` makes them **throw**. Do not let them purge a new empty store while the original store keeps serving stale data. A different `name` or `getKey` still does nothing without an error. `resolveCacheKeys` only derives keys and is not affected.

### In-flight fence

A purge must also beat work that started **before** it. `pending` holds one token per key, `{ promise, fenced? }`. `.invalidate()` and `.expire()` set `fenced` on the current token and drop it from `pending` before they touch storage.

Without the fence, a resolver that started before the purge wrote its pre-purge value back to the key after `invalidateCache` had already removed it. The cache then served pre-purge data for a full `maxAge`. The default `maxResolveTime` makes that window up to 30 s wide. `expire` had the same defect: the late write cleared `stale`.

- A fenced leader still returns its value **to its own caller**. It writes nothing, and it does not evict after a failed resolution, because the purge already removed the entry and a newer resolution may own the key.
- Dropping the token from `pending` matters as much as the flag. Otherwise a call that arrives after the purge becomes a follower of the doomed resolution and receives the pre-purge value.
- The leader keeps its slot until the write decision instead of releasing it before `await validate(...)`, and it reads `fenced` **after** that await. `releasePending` checks token identity, so no leader can remove a newer leader's slot. This narrows the unfenced window to the storage call itself. No fence can order a purge against a `set` that is already in flight.
- Existing followers keep the value they are already waiting for. Their call started before the purge, so this matches a request that returned one tick earlier.
- A fenced resolution is **discarded, not stored as stale**. `expire` therefore costs one extra resolution. Storing a pre-purge value under a fresh lifetime is the failure this fence exists to prevent.
- The fence is **per instance**. It lives in a `WeakMap` keyed by the cached function so it stays off the public `CachedFunction` type. `http/index.ts` reaches it through the internal `fencePending(cachedFn, key)` for every method variant; see `.agents/http/key.md`. The standalone helpers cannot fence, because they receive options, not the instance. This is one more reason to prefer the instance methods.
- `.invalidate()` and `.expire()` resolve the key once and hand the helper a fixed `getKey`, exactly as the handler variants do. A custom `getKey` must not run twice per purge.

## Storage resolution

`opts.storage` accepts a `StorageInterface` or a factory. The default is a fresh `createMemoryStorage()` **for each cached function or handler**, never a global instance. See `.agents/storage.md`. `resolveStorage(_optsRef, opts)` resolves storage lazily on the first read or write. Do not resolve it at definition time because factories support late binding. Memoize the result in both the caller's options and the internal clone. A factory must run at most once. Instance methods and standalone helpers must reach the same store.

## `waitUntil`

`event.req` may provide `waitUntil`, as srvx and Cloudflare `ServerRequest` do. Four sites call it as `event?.req.waitUntil?.(p)`: cache write, SWR background refresh, and both evictions. All four read it after `http/request.ts` replaces the request with a narrowed `Request`. The replacement must copy `waitUntil` and bind it to the original request. See `.agents/http/request.md`.
