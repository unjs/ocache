# `src/tracing.ts` — the `ocache.handler` and `ocache.function` channels

`tracing: true` publishes each call of a cached handler on `ocache.handler` and each call of a cached function on `ocache.function`, through `node:diagnostics_channel`'s `tracePromise`. The payload is per call and reports how **that** call was served. Frameworks build on it: Nitro's `Server-Timing` `cache` metric subscribes to it the way its `kv` and `db` metrics subscribe to unstorage's and db0's channels.

## Why a per-call payload, not a per-event status

This replaced a proposed `getCacheStatus(event)` export (unjs/ocache#110), which recorded the status in a module-level `WeakMap` keyed by event. Review showed that a registry keyed by event cannot be made correct, because one event is shared by more than one cached call:

- **Nested handlers.** An inner cached handler answers inside the outer one's resolver, on the same event.
- **SWR.** An outer handler that serves `stale` returns before its background refresh runs the handler again **with the caller's event**. The refresh's inner call then overwrote `stale` after the outer call had returned.
- **`maxResolveTime`.** An abandoned resolution keeps running and can reach an inner handler long after its caller rejected.
- **Errors.** A status recorded before `handleCacheHeaders`, `deserializeEntry`, or `createResponse` survived when they threw, and no error exit cleared a status left by an inner or earlier handler, so a 500 page reported `hit`.
- **Two copies of ocache** (pnpm can keep two 0.x versions) do not share a module-level map.

A payload owned by one call avoids all of these by construction: nothing else writes to it, and it settles once. Channels are looked up by name, so two copies of ocache publish to the same channel.

## Opt-in, like unstorage and db0

unstorage (`withTracing(storage)`), db0 (`withTracing(db)`), h3 and srvx (`tracingPlugin()`) all make tracing opt-in. ocache cannot wrap from outside: the status exists only inside the serve path. It therefore takes an option on the definition, `tracing`, which a framework sets through its defaults.

- **Off costs nothing.** No channel is looked up, `transform` stays as it was (undefined without a status header), and `cachedFn`/`cachedHandler` return the inner promise unchanged. `call` and `serve` are the old bodies; the wrapper is a plain function that returns their promise, so an untraced call keeps the exact microtask timing it had. An `async` wrapper would add ticks to every call, and SWR and streaming races in this codebase have turned on two or three.
- **On but unobserved** builds no payload: `hasSubscribers` is checked per call. A runtime whose `TracingChannel` lacks `hasSubscribers` (Bun) publishes every call instead of probing the five sub-channels; that only costs where tracing was asked for.
- **The lookup** is `globalThis.process?.getBuiltinModule?.("node:diagnostics_channel")`, once per definition, inside `try`: runtimes disagree on whether an unsupported builtin returns `undefined` or throws. No channel means no tracer, and the handler behaves exactly as with tracing off.
- **`tracing` is excluded from both `integrityOpts`.** It decides who observes a call, not what is stored, so turning it on must not make entries cold.

## The status of a handler call

`transform` is the only per-call hook that sees `entry.status`, so it hands the serve path `{ value, status }` (`ServedEntry`). It is defined when the status header **or** a tracer needs it, and left undefined otherwise: an unconditional `transform` adds an `await` on every call, which changed which side won the stale `stream` + `swr` race in review.

`serve` sets `trace.status` through `reportStatus(createResponse(...), status, trace)`. The response is built first, so a throwing `createResponse` or `handleCacheHeaders` leaves the status unset and the error reaches the channel's `error` event. Every live path returns without touching it: bypass, `headersOnly`, and the `ResponseTooLargeError` and `NarrowRequestError` fallbacks. Nothing is ever cleared, because nothing but this call ever wrote to its payload.

- A `304` built from an entry reports that entry's status, like the header it echoes.
- A coalesced follower runs its own `get` and `transform`, so it reports what it was served.
- An SWR refresh runs the handler's **resolver**, not `cachedHandler`, so it publishes no outer payload. A nested cached call it makes publishes its own, with the caller's event. A refresh that throws reaches `onError`, not the stale call's payload; when it keeps the stale entry (a transient failure, see `.agents/cache.md`), the next call reports `stale` again.

### Streamed fills

`transform` has not run when a streamed response goes out, and its later result is discarded, so `streamBody` hands its status over in `StreamedResponse.status`, the value it stamps in the header. That value is the resolution's own `ctx.status`, which `serialize` receives, so a nested cached call on the same event cannot change it (see `.agents/http/stream.md`).

An over-limit streamed leader has already been sent its headers, `X-Cache: MISS` included, when `streamBody` finds the body too large, and its payload has already settled. It keeps the `miss`: the payload describes the response that went out, and rewriting a settled payload would reach subscribers that have already read it. The storage failure reaches `onError` through the fill. A buffered over-limit response and a streamed follower are served live and report `undefined`. A hit-ratio built on the channel therefore counts an uncacheable streamed route as a permanent miss; the guide says so.

## The status of a function call

`call` sets `trace.status = entry.status` after `transform`, so a throwing `transform` leaves it unset. `shouldBypassCache` reports `undefined`.

A cached handler is built on `cachedFunction`, so its `_opts` sets `tracing: undefined`: the handler publishes each call once, on `ocache.handler`. A cached function the handler's code calls is a separate call and publishes on `ocache.function`.

## The payload holds live objects

`HandlerTraceContext.event`, `FunctionTraceContext.args`, and the `result` the channel adds are live values, as in h3's `h3.request` payload. They are not structured-cloneable. workerd V8-serializes every published message whenever a tail consumer is attached, so on Cloudflare a traced call logs a publish failure there. Publishing a serializable projection instead would lose what a subscriber needs to correlate the call (the event), so the payload follows h3.
