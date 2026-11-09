# `tracing.ts` — diagnostics channels

Two `TracingChannel`s, named like `unstorage.<op>`, `db0.query`, and `h3.request`. On by default, `tracing: false` opts a cache out. User guide: `docs/docs/13.tracing.md`.

## Two channels

- `ocache.get` spans one cached call, lookup to serve. `ocache.resolve` spans one run of the resolution (function + `getMaxAge` + `serialize`), leader only. One channel could not show dedup (N waiters looked like N runs), could not separate lookup latency from origin latency, and left a stale refresh with no event at all.
- `ocache.resolve` wraps the resolution, not `withDeadline`: a timeout rejects the waiters' `ocache.get`, while the run's own event ends when the run does. It ends before the storage write.
- Started inside `get`, so it inherits the `ocache.get` store: a foreground run nests, a background one is a child that outlives its parent.
- `result` is set by `tracePromise` from what the traced function resolves, so the resolution resolves a `CacheEntry` (`value`, `mtime`, `maxAge`, `staleMaxAge`) rather than an internal shape. The stored entry takes that same `mtime`, so every waiter's `ocache.get` and the next hit report one write time.

## Zero cost when unobserved

- `trace` returns `call()` itself unless something subscribes, and builds the context through a factory only then. An unobserved call keeps the exact microtask timing of `tracing: false`, which the SWR paths depend on (see `.agents/cache.md`, `maxResolveTime`). The full suite passes with both channels subscribed.
- `cachedFn` checks `observed(GET_CHANNEL)` first and calls `call` directly when nothing listens. Only an observed call takes the extra `traced` hop, which runs `shouldBypassCache` before the event starts and tells `call` it already did, so the hook still runs once.
- That is why the option can default to on: unobserved it costs one subscriber check per call. It exists to keep a cache's keys and values (`result`) away from in-process subscribers.
- The builtin is read through `globalThis.process?.getBuiltinModule`, in a `try`, once. A runtime without it, or one that throws for an unknown builtin, disables tracing. Never import `node:diagnostics_channel`: the neutral bundle must not name a node builtin.
- Bun has no aggregate `TracingChannel#hasSubscribers`, so the check falls back to the sub-channels, as `db0` does.
- The context interfaces are local shapes, so the published declarations need no `@types/node`.

## Context

- `name`, `group`, and `event` exist at `start`; `key` after `getKey`; `status` as soon as the read decides it, before the resolution runs, so a failed miss still reports `"miss"`.
- `maxAge` and `mtime` describe the served value: the stored entry for `"hit"`/`"stale"`, set with `status`; the resolution's entry for `"miss"`/`"revalidated"`, set once it settles. Never one of each.
- Bypassed calls publish nothing, on functions and handlers alike: a handler answers them before its inner cached function runs, so a function-only `"bypass"` status was a value handlers could never send.
- `type` comes from a `WeakSet` of handler inner functions, filled by `defineCachedHandler`, like `fences`. A handler's `result` is the stored `ResponseCacheEntry`, since the `Response` is built after the span ends; `type` is what tells subscribers so, because `group` is user-set and `event` also appears on plain functions called with an event.
- Arguments are not published, since they are not what the cache stores. `result` is unavoidable with `tracePromise`; `tracing: false` is the opt-out for sensitive values.
- `tracing` is excluded from integrity in both `integrityOpts`, so toggling it keeps existing entries warm.
