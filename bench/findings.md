# Performance findings

What the benchmarks in this directory say about ocache's own cost, and where that cost
could come down. Every number here was measured on this machine (Node v24.19.0); nothing
is estimated. Each finding carries its status:

- **measured** — reproduced with the method below
- **prototyped** — the proposed change was implemented, measured, and reverted
- **observed** — a structural property found while building the harness, not a timing
- **from the load runs** — read off `results/steady.md`, so it is a property of a scenario
  under load rather than a per-call cost

## How these numbers were produced

Per-hit costs are **paired**: one repetition times the handler alone and then the cached
handler back to back, and keeps the difference. Nine repetitions, `global.gc()` before each
side, median of the differences. Absolute figures use the minimum, because scheduler and GC
noise can only add time. `pnpm bench` runs under `--expose-gc` for this reason.

This matters more than it sounds. Two earlier attempts produced numbers that were not just
noisy but **wrong in direction**:

- A single-pass `mitata` run reported a custom `getKey` as the _slowest_ handler variant.
  Paired measurement shows it is the _fastest_ by 9 µs. Finding 1 below is the opposite of
  what the first run said.
- Measuring each side of the comparison in its own loop and taking each side's own minimum
  produced a hit-cost curve that _fell_ as the payload grew, which cannot be true. This is
  fixed in `harness/calibrate.ts`; the fix is why the curve is now flat.
- Allocating thousands of `Response` objects per repetition without GC control made
  `new Headers(8)` measure cheaper than `new Headers(3)`.
- Without a forced collection between the two sides, one side absorbs the other's garbage.
  That produced a **negative** overhead at one payload size — ocache measuring as free.

One artefact survives and is worth knowing about: a single payload size per run can come
out several microseconds low. Running the sizes in reverse order moves it to a different
size, so it follows position in the sequence, not the payload. Treat one low reading in a
size sweep as a transient and re-run before believing it.

If you re-measure anything here, pair it and control GC, or the result will mislead you.

Baseline for all per-hit figures: 8 KiB text body, GET hit, memory storage, no competing
load. Plain `defineCachedHandler` adds **+24 µs** per hit over calling the handler
directly. The cached-function path adds **+4 µs**. The gap between those two is the subject
of most of what follows.

Absolutes drift between sessions: the same plain configuration read +25.8 µs in the later
run that produced findings 3 and 4. Deltas within one run are stable, so compare those, and
never a delta from one run against an absolute from another.

## 1. Default key derivation is ~9 µs, and a third of it is cosmetic

**measured, partly prototyped**

| configuration                           | added per hit |
| --------------------------------------- | ------------: |
| plain (default key derivation)          |      +24.3 µs |
| `getKey: () => "k"`                     |      +15.1 µs |
| `getKey: () => "p/42"` (needs escaping) |      +20.5 µs |

Supplying any custom key skips `resolveKey`, which is worth 9 µs — 38% of the total
overhead. Within it, `key.ts` builds a **second `URL`** purely to produce the readable
prefix in front of the hash:

```ts
escapeKey(decodeURI(new URL(_path, "http://localhost").pathname)).slice(0, 16) || "index";
```

The hash already covers `[authority, path]`, so this parse contributes nothing to key
identity — it only makes stored keys readable. Replacing it with a substring to the first
`?` measured **24.3 → 22.0 µs**, a 2.3 µs (9%) saving, with keys still unique across paths
and hosts.

The catch is that it is a key-format change: percent-encoded paths get a different prefix
(`x20yz` rather than `xyz`), so every existing entry misses once after deploy. Worth doing
alongside another format change, not on its own.

The escaping path costs a further 5.4 µs: a custom key containing any non-word character
fails the `escapeKey(raw) === raw` check in `escapeKeySegment` and pays an extra `hash`.
Callers who supply their own keys should know that `product42` is meaningfully cheaper than
`product:42`.

## 2. Binary bodies pay base64 on every hit, and far more on every store

**measured**

`http/entry.ts` stores a non-UTF-8 body as base64. `deserializeEntry` calls `atob` plus a
byte-by-byte copy on **every read**, and `serializeResponse` runs the encode on every
**write**. Paired against the same handler with a text body of the same size:

|   body | added per hit | added per store |
| -----: | ------------: | --------------: |
|  8 KiB |        +50 µs |         +255 µs |
| 40 KiB |       +102 µs |        +1369 µs |
| 64 KiB |       +192 µs |        +2273 µs |

A text body of the same size costs nothing to deserialize — the stored string is handed
straight to `Response`. So a 64 KiB image hit adds roughly **8x** what an 8 KiB HTML hit
adds, and the whole difference is encoding, not size. Timing `base64ToBytes` on its own
gave 54/110/156 µs for the same three sizes — the same shape, measured a different way.

The write side is worse than the read side by an order of magnitude, and it is one
function. Timed directly at 64 KiB:

| operation                                 | portable path | Node `Buffer` |    ratio |
| ----------------------------------------- | ------------: | ------------: | -------: |
| `bytesToBase64` (`fromCharCode` + `btoa`) |       2212 µs |       11.6 µs | **190x** |
| `base64ToBytes` (`atob` + byte loop)      |        116 µs |       27.2 µs |     4.3x |

`bytesToBase64` spreads 32 768 arguments into `String.fromCharCode` per chunk and
concatenates the pieces; that spread, not `btoa`, is the cost. It dominates every binary
store: 2212 of the 2607 µs a 64 KiB binary miss adds (finding 3).

Three directions worth exploring:

- Let a backend declare that it stores binary natively (`Uint8Array`, `Buffer`, `Blob`) and
  skip the base64 round trip when it does. Memory storage always can; so can Redis.
  The base64 path exists because the format has to survive JSON storage, which is a
  property of the backend, not of the entry. `deserializeEntry` already types `body` as
  `string | Uint8Array`, so the read side is half-built already.
- A `#buffer`-style conditional import, matching what `#crypto` does for the digest, would
  take the Node path for both directions and keep the portable one elsewhere. The encode
  side is where the 190x sits.
- Failing that, replace the spread with a per-byte `String.fromCharCode` accumulation or a
  lookup-table encoder. The spread is the part that scales badly.

Base64 also costs storage, not only CPU: `og-image` writes 0.6 MiB for seven 64 KiB
entries — **≈88 KiB stored per entry**, the 4/3 expansion — which counts against
`maxEntryBytes`, against network egress on a remote backend, and against the etag digest,
which hashes the base64 string rather than the bytes (161 µs versus 122 µs at 64 KiB).

The `og-image` scenario is where this shows up under load.

## 3. The miss path costs 5-14x the hit path, and it scales with payload

**measured**

Every finding above is about hits. A miss buys the read, the origin call, `serializeResponse`,
the etag digest, the store, and the `Response` — and none of it is shared with the hit path.
Paired the same way, with a fresh key per call so every call stores:

|   body | added per miss | added per hit | ratio |
| -----: | -------------: | ------------: | ----: |
|  8 KiB |        +138 µs |      +25.4 µs |  5.4x |
| 40 KiB |        +258 µs |      +28.2 µs |  9.1x |
| 64 KiB |        +334 µs |      +23.7 µs | 14.1x |

Binary makes it far worse: +394 µs, +1627 µs and +2607 µs for the same three sizes, which
is finding 2's encode.

Two consequences, both the opposite of what finding 9 says about hits:

- **The miss path does scale with body size.** The hit path does not, because nothing
  copies the body. Anyone reasoning "ocache is flat in payload size" is reasoning about
  hits only.
- **The etag digest is the largest single component of a text store.** `hash` over a
  64 KiB body measures 122 µs, roughly 37% of that miss's +334 µs. A handler that sets its
  own `etag` skips it entirely — `entry.ts` only digests when the header is absent. That is
  the cheapest advice in this document, and nothing currently documents it.

This is also why per-hit micro-optimisation does not move p99 under load: at a 13% miss
ratio (`ssr-product-page`, 76 of 584), the misses carry the tail. See finding 10.

## 4. Keyed headers cost ~3.3 µs each; keyed cookies cost ~7 µs flat

**measured**

| configuration         | added per hit | delta vs plain |
| --------------------- | ------------: | -------------: |
| plain                 |      +24.3 µs |              — |
| `varies: [3 headers]` |      +34.3 µs |       +10.0 µs |
| `allowQuery: ["a"]`   |      +29.2 µs |        +4.9 µs |

`resolveKey` does a `headers.get` and a **separate `hash(value)` per declared header**. The
per-header hash is what costs; each is an independent SHA-256 over a short string. Hashing
the joined name/value list once would cut this to a single digest, at the price of a key
format change. The hash is paid per **declared** header whether or not the request carries
it: an absent header hashes `null` rather than being skipped.

`allowQuery` costs 4.9 µs because `filterSearch` builds a `URLSearchParams`, iterates it,
and re-serializes on every request. Its cost tracks the query string, not the allowlist: a
single-parameter URL re-measured at +1.3 µs against its own control.

`allowCookies` was unmeasured until now, and it is the more expensive option — it is also
the one every per-user handler needs:

| configuration             | delta vs plain |
| ------------------------- | -------------: |
| `allowCookies: [1 name]`  |        +6.9 µs |
| `allowCookies: [3 names]` |        +7.1 µs |

Flat in the number of cookies, because `filterCookie` parses the header once and the result
gets **one** `hash` regardless of how many names are allowed. So the shape to avoid is many
declared `varies` headers, not many allowed cookies. Both are dwarfed by a miss (finding 3).

## 5. Response header count, not body size, drives construction cost

**measured**

With the body held at one byte, `new Response(body, init)` costs about **1.7 µs per
header** (3 headers +7.6 µs, 5 headers +10.5 µs, 8 headers +16.1 µs over `{status}` alone).

ocache adds up to four headers a handler did not send — `etag`, `cache-control`, `vary`,
and the cache-status header. That is real, but see finding 9 before optimizing it.

## 6. The HTTP layer costs 6-8x the function layer

**measured**

+24.3 µs per handler hit against +3.0 µs per cached-function hit, for the same stored
payload. The difference is entirely `http/`: key derivation, `validateEntry`, the header
spread in `transform`, `deserializeEntry`, and `Response` construction.

Nothing here is obviously wasted — it is the cost of being an HTTP cache rather than a
memo table. It is worth stating plainly because it sets the scale: findings 1, 2, 4 and 5
together account for roughly half of it.

## 7. The derived body ceiling costs text responses a quarter of the backend

**observed, verified**

`resolveMaxBodySize` divides the backend's `maxEntryBytes` by `BODY_CHARGE_FACTOR` (8/3):
4/3 for base64 expansion and 2 for the storage estimate's charge of two bytes per UTF-16
code unit. Text never pays the base64 half, so its true worst case is 2, not 8/3.

With `maxEntryBytes` at 1 000 000, a 380 000-byte text body is refused:

```
ResponseTooLargeError: Response body exceeds the 375000 byte cache limit.
```

Stored, it would have charged 760 000 of the 1 000 000 available. The real ceiling for text
is 500 000 bytes, so **25% of the usable range is unreachable**, and each request for such a
response repeats the buffer-and-refuse work rather than caching once.

The base64 branch is known immediately after `decodeUtf8`, so the tighter factor is only
needed for the bodies that turn out to be binary. Buffering to `maxEntryBytes / 2` and
letting `set` refuse the binary case it already refuses would recover the range. The
invariant in `AGENTS.md` — one declaration bounds both buffering and storage — still holds;
what changes is that the bound stops assuming every body is binary.

## 8. `waitUntil` is unreachable for cached functions

**observed, plus the load runs**

`cache.ts` registers background revalidation through `event?.req.waitUntil?.(...)`, and
`event` is only set when `args[0]` is an HTTP-event shape. A plain `defineCachedFunction`
using SWR therefore leaves its revalidation as an unowned floating promise: no host can
await it, and a serverless runtime may freeze the process before it lands.

This is not only a bookkeeping problem. In `results/steady.md`, `fanout-aggregate` — the
scenario built to show SWR — has the **lowest offload in the suite** (77.5%) and a p99 of
325 ms against a 220 ms origin, when its own `expect` string says stale serves should push
p99 _below_ origin latency. `og-image` reports `stale=0` despite the option being set, so
its misses block for the full 180 ms render and pin p99 at 188 ms. Whatever the cause,
SWR is the least substantiated claim in the benchmark set, and it is where the harness has
to drain background work by other means.

An explicit `waitUntil` option on `CacheOptions` would close the function-path half of it.

## 9. Things that look like wins and are not

**measured**

- **`cacheStatusHeader: false` saves nothing.** +25.1 µs against +24.3 µs for plain, well
  inside noise. Not because the header is free: with no status header `http/index.ts` leaves
  `transform` undefined and the hit skips the entry clone and both header spreads entirely.
  That whole clone is worth less than a microsecond at this header count. Do not recommend
  disabling it for performance, and do not assume `transform` is what costs.
- **Hit overhead does not scale with payload.** 23-27 µs across 4 KiB to 64 KiB, measured
  in both ascending and descending order, because nothing on the hit path copies the body —
  V8 shares the string. The absolute cost of each side does rise with payload (direct
  33 µs → 105 µs), but it rises equally on both, so it cancels. Optimizing for large
  responses on the assumption that ocache costs more for them is optimizing the wrong axis.
  (Binary bodies are the exception, and that is encoding, not size — finding 2. Misses are
  the other exception, and they scale steeply — finding 3.)
- **Multi-tier `base` prefixes are not a second backend.** They are key prefixes on one
  `StorageInterface`, so memory-in-front-of-Redis needs a routing wrapper the library does
  not ship. The harness has one in `harness/storage.ts`, and the load runs show what it is
  worth: on `fanout-aggregate` over `kv-edge`, adding a memory tier moves p50 from 7.07 ms
  to 0.05 ms and time blocked on reads from 9015 ms to 454 ms, for 6% more reads and 23%
  more writes. That is the largest single improvement measured anywhere in this directory,
  and users cannot reach it with what the package exports.

## 10. Context: when any of this matters

**measured, from the load runs**

Per-hit CPU is only the whole story on memory storage. Median hit latency for
`markdown-render` at 89.6% offload, by backend (`results/steady.md`):

| backend        |  hit p50 | 24 µs as a share |
| -------------- | -------: | ---------------: |
| `memory`       |  0.07 ms |             ~34% |
| `redis-local`  |  0.26 ms |              ~9% |
| `redis-az`     |  0.92 ms |              ~3% |
| `sql`          |  2.80 ms |              ~1% |
| `object-store` | 35.98 ms |           ~0.07% |

So findings 1, 4 and 5 pay off for in-process caching and are close to irrelevant behind a
network hop. Findings 2 and 3 are the exceptions: they are miss-path and encode costs, and
102 µs of base64 decode at 40 KiB is still 11% of a `redis-az` hit — pure waste at any
backend.

**The tail belongs to the miss path.** `ssr-product-page` on memory improves p50 by 311x
(52.85 → 0.17 ms) and p99 by only 2.88x (137 → 47.5 ms). p90 is where the 13% miss
population starts. No amount of hit-path µs moves that number; finding 3 is the one that
could. On a slow backend the effect swallows the benefit outright — `api-list` on `kv-edge`
is 1.23x at p99 and 105 ms against 112 ms at p99.9, which is nothing.

The corollary is the more useful one for users: **ocache's own cost is not what decides
whether caching helps.** The break-even table in the generated report is set by the
backend's median read, and a handler cheaper than that read is faster with no cache at all.

That table is also produced by `bench:micro`, which is single-pass. Its per-payload row for
an 8 KiB handler reads +19.3 µs against the +24.3 µs measured here, and its curve is
non-monotonic in payload size — exactly the failure this document opens by describing.
Treat the report's break-even numbers as directional until they are regenerated from the
paired harness.

## Reproducing

Findings 1, 4, 6 and 9 come from paired measurements of `defineCachedHandler` variants;
finding 2 from paired hit/store timings plus direct timing of the encode and decode
functions; finding 3 from the same pairing with a fresh key per call, so every call stores;
finding 5 from `new Response` with the body held constant; finding 7 from a store against a
1 MB `maxEntryBytes`. Pairing follows `timePair` in `harness/calibrate.ts` — nine repeats,
`globalThis.gc()` between sides, median of the per-repeat deltas — and needs
`node --expose-gc`, which the `pnpm bench` scripts set.

Load-run figures come from `results/steady.md`. One row there is stale: the
`personalized-dashboard` summary and note predate the scenario's 15% session churn, so its
96.3% offload describes an older model. Do not cite that row until the report is
regenerated.

`pnpm bench:micro` covers the hit path less precisely — it is a single-pass tool, so treat
it as directional and re-measure anything you intend to act on.
