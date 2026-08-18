# Streaming the fill — `http/stream.ts`

`stream: true` serves the body of a fill to the request that is waiting for it, chunk by chunk,
while the same chunks are buffered into the entry that will be stored. It is opt-in and off by
default.

Without it the request that fills an entry waits for the handler's **complete** body: `serialize`
has to buffer the body before anything can be stored, so time to first byte for a MISS is the
origin's last byte. For a token stream or a streaming SSR render, that is the whole response.

## The split

Nothing about storage changes. `streamBody` produces the same `ResponseCacheEntry` the buffered
arm produces, from the same chunks, through the same `buildEntry`. Storage, `payload:
"value.body"`, `validate`, the blob codec, and every read path are untouched — an entry written by
a streamed fill is byte-identical to one written by a buffered fill. That is also why `stream` is
excluded from `integrityOpts`: turning it on must not make existing entries cold.

What changes is only **when the caller is handed a body**:

- `http/index.ts` calls `openStreamChannel(event)` **before** `cachedFn(event)`, then races the
  channel against the resolution. The channel wins → serve the live body and let the fill finish
  behind the response. The resolution wins → the old path, unchanged.
- `entry.ts` `serialize` takes the listener and publishes `{ body, init }` the moment it has the
  headers, before its first read.

The channel is a `WeakMap` keyed by `HTTPEvent`, which is the `resolveSignal` pattern in
`cache.ts` and exists for the same reason: `cache.ts` invokes `fn(...args)` with only the caller's
arguments, so neither direction can be a parameter. Keys are per-request events, so nothing has to
be cleaned up for memory; `closeStreamChannel` exists for a different reason, below.

## Only a foreground resolution may stream

`serialize` runs for a background SWR refresh too, and that refresh is registered against the
**stale caller's** event — the same event whose serve path has a channel open. Publishing into it
would hand a stale hit the refresh's stream instead of the stored value it is owed.

Deciding this by racing is not enough. The two paths differ by two or three microtasks, so which
one wins is a property of how many `await`s a handler happens to have. `cache.ts` therefore
records the decision where it is already made: `resolveStatuses` is written in `resolveEntry`,
next to `resolveSignals` and from the same `if (!current)` leader branch, using the `status` that
was computed **before** the resolver started and that already "must match the serve decision
below". Anything but `"stale"` means this caller is waiting on this resolution. `resolveStatus`
returns that status, so `entry.ts` gets the gate and the `x-cache` value from one lookup —
`transform` never runs for a streamed caller, so the status header is stamped in `streamBody`.

Followers never register, so they never stream: they cannot read the leader's one-use stream, and
they wait for the complete entry exactly as they do today. Serving a follower from the same fill
needs a fan-out buffer keyed by cache key rather than by event, and it is **tracked, open** — the
chunk array `streamBody` already keeps is the buffer such a design would replay from.

## What a streamed response gives up

- **No synthesized `etag`.** It digests the body, which does not exist yet. Trailers are not a
  substitute; hosts drop them. A handler's own `etag` is kept, because `buildHeaders` only
  synthesizes when the header is absent. Every later request is served from the stored entry,
  which has one.
- **No `304`.** The serve path returns before `handleCacheHeaders` — there is no validator to
  compare against yet. A conditional request against a filling entry gets the full body.
- **A failure part-way through can only be a truncated body.** The status line and headers are
  already sent. `streamBody` calls `sink.error()` and never `close()` on a failed read, so the
  consumer's stream errors and the chunked framing terminates incompletely rather than looking
  like a complete representation. Nothing partial is ever stored: the entry is built only after a
  clean end of stream, and a thrown `serialize` evicts, as any failed resolution does.

Everything that is decidable from headers alone still happens before the response goes out, which
is what keeps the "storage decision and advertisement use the same predicates" invariant true:
`isCacheableStatus`, `hasVaryWildcard`, and `hasUnkeyedVary` all read headers, so a response that
`validate` will refuse is never advertised as cacheable even though it was already sent.

## Backpressure and cancellation belong to the fill

`createStreamSink` has no `pull`: the fill drives the stream and the consumer does not throttle
it. A consumer that cancels does **not** cancel the read — the entry is still being written, and
"the cache fills even if the client leaves" is the point. This is the caller-signal rule from
`.agents/cache.md` in another place: one resolution serves more than its first caller, so no
single caller may end it.

Peak retention is unchanged by streaming, because the sink and the buffer enqueue the **same**
chunk objects. `maxBodySize` still bounds it.

## Over-limit is simpler here, not harder

The buffered arm throws `ResponseTooLargeError` carrying a passthrough response built from the
prefix plus the unread reader, and `claim(event)` hands it to exactly one caller. A streamed fill
needs none of that: its caller already has every chunk. `streamBody` keeps pushing to completion,
drops the buffer, and throws the error with **no response**, so `claim` returns `undefined` and
the constructor schedules no release timer. The caller is already served; `http/index.ts` reports
the error through `onError` and stores nothing. `ResponseTooLargeError`'s `response` parameter is
optional for this case only.

## The fill outlives the response

`http/index.ts` registers the resolution promise with `waitUntil` after it returns the streamed
response, so a serverless host stays alive for the rest of the read and the write — the response
returning is no longer evidence that the entry was written. It also absorbs that promise's
rejection into `onError`: the caller cannot be told twice, and a mid-stream failure already
reached it as a truncated body.

`closeStreamChannel` runs in a `finally` on every non-streamed path. It is not about memory (the
key is the request's own event) — it is there so a `serialize` that publishes _after_ the serve
path stopped listening finds no listener and buffers instead. A published stream nothing reads
would queue the whole body in its controller, which is the retention `maxBodySize` exists to bound.

## `maxResolveTime` becomes load-bearing

The deadline wraps the resolver **and** `serialize`, so it bounds the whole read. A body that
takes longer than the default 30 s to produce now aborts a caller that is being served correctly,
and the abort reaches it as a truncation. This is the same limit that keeps a never-ending stream
from holding a key forever, so it stays — a streaming route raises it deliberately. The user guide
says so next to the option.
