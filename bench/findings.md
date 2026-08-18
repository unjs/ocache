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
  Paired measurement shows it is the _fastest_, by several microseconds. Finding 1 below is
  the opposite of what the first run said.
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

Every `+24 µs` plain figure below predates finding 1's fix, which took roughly 2 µs off it.
The deltas measured **against** plain — findings 4 and 9 — are unaffected, because the fix
is on a path every one of those rows shares.

## 1. Default key derivation is ~2.5 µs, and the cosmetic third of it is now gone

**measured, fixed**

The earlier version of this finding read the plain-versus-custom-key gap at the handler
level and attributed all of it to `resolveKey`. Timing `resolveKey` on its own says
otherwise, and the correction matters because the 9 µs headline was the number anyone would
have acted on:

| configuration                     | `resolveKey` alone | handler, added per hit |
| --------------------------------- | -----------------: | ---------------------: |
| plain, before                     |           +2.55 µs |               +23.4 µs |
| plain, after                      |       **+1.81 µs** |           **+20.1 µs** |
| `getKey: () => "k"`               |            ~0.0 µs |               +15.3 µs |
| `getKey: () => "p/42"` (escaping) |           +0.82 µs |               +18.7 µs |

`resolveKey` alone is paired against event construction at 20 000 iterations; the handler
column is the 4 000-iteration pairing this document opens by describing, run with both
implementations loaded into **one process** so the two rows share a baseline and a heap.

So default key derivation costs **2.5 µs**, not 9, and the escaping path costs **1.2 µs**,
not 5.4. The advice that a custom `product42` is cheaper than `product:42` still holds; the
size of the gap does not. The rest of the 5-7 µs between plain and a one-character custom
key is downstream of derivation — the derived key is 53 characters where `"k"` is one, and
it is rebuilt per call — but each part of that sits at the handler pairing's noise floor.
Do not quote it as key-derivation cost.

**What changed.** `key.ts` built a **second `URL`** purely to produce the readable prefix in
front of the hash:

```ts
escapeKey(decodeURI(new URL(_path, "http://localhost").pathname)).slice(0, 16) || "index";
```

The hash already covers `[authority, path]`, so that parse contributed nothing to key
identity. It now reads `_url.pathname`, which is the same string: `pathname` is already
parsed and cannot hold a raw `?`, and `escapeKey` strips the leading `/` that re-parsing
added to an opaque path. Checked over 193 462 http(s) URLs — percent escapes, dot segments,
backslashes, non-ASCII — with **zero** differing prefixes, so unlike the substring variant
this document previously proposed, **no stored entry moves**. `test/index.test.ts` now pins
the key bytes. `resolveKey` also returns the hashed path directly when no header and no
cookie is keyed, which is the default, instead of joining a one-element array.

Two smaller things were measured and left alone. Dropping `decodeURI` as well saves a
further 0.16 µs and _would_ move every percent-encoded path's prefix — not worth a format
change. The `hash([authority, _path])` itself is 0.94 µs of the remaining 1.81, and it is
identity, not cosmetics.

Handler-level deltas here are order-sensitive by ±2 µs: whichever variant runs second in a
process reads high, which is the positional artefact described above. Both orders were run;
the plain row came out lower after the change in all seven runs, by 1.2-5.8 µs.

## 2. Binary bodies paid base64 on every hit, and far more on every store — now fixed

**measured, fixed**

`http/entry.ts` stores a non-UTF-8 body as base64 so it survives a backend that serializes
entries as JSON. That made a binary entry pay an encode on every **write** and a decode on every
**read**, and the encoder was the expensive half by an order of magnitude: it spread each 32 KiB
chunk into `String.fromCharCode(...)`, and that argument list — not `btoa` — was **2212 of the
2607 µs** a 64 KiB binary miss added.

Both directions now go through `src/base64.ts`, which picks one implementation at module load:
`globalThis.Buffer`, then the TC39 `Uint8Array` base64 methods, then a per-byte `btoa` loop.
Paired against the same handler with a text body of the same size, one process per
implementation and size:

|   body | hit before | hit after | store before | store after |
| -----: | ---------: | --------: | -----------: | ----------: |
|  8 KiB |   +17.1 µs |   +1.3 µs |      +260 µs |      +31 µs |
| 40 KiB |   +63.0 µs |   +5.3 µs |     +1435 µs |     +121 µs |
| 64 KiB |   +94.6 µs |   −5.4 µs |     +2382 µs |     +240 µs |

**A binary hit now costs what a text hit costs.** At 64 KiB it measures _cheaper_, reproducibly
(−5 to −15 µs over four runs), because the text side pays a UTF-8 encode inside `arrayBuffer()`
that the binary side does not. So finding 9's "hit overhead does not scale with payload" no
longer has a binary exception; finding 3's does, and it shrank.

The three implementations, timed directly, minimum of nine GC-controlled repeats:

| operation, 64 KiB | old spread | portable loop | `Buffer` |
| ----------------- | ---------: | ------------: | -------: |
| encode            |    2190 µs |        537 µs |  11.7 µs |
| decode            |     123 µs |        123 µs |    17 µs |

The decode columns are equal because the fallback decoder **is** the old one, unchanged: `atob`
plus a byte copy was never the problem. The encoder was, and one `String.fromCharCode` per byte
is **4x** faster than spreading the same chunk into one call — which is what a runtime with
neither `Buffer` nor the TC39 methods now gets.

What is left, and what it costs:

- **The etag, not the encode, is now the binary store's largest addition.** `serializeResponse`
  digests the base64 string, which is 4/3 the size of the bytes. A handler that sets its own
  `etag` drops ~55 µs of the 64 KiB figure above, because `entry.ts` only digests when the header
  is absent — the same advice finding 3 gives for text.
- **Base64 still costs storage, not only CPU.** `og-image` writes 0.6 MiB for seven 64 KiB
  entries — ≈88 KiB per entry, the 4/3 expansion — which counts against `maxEntryBytes`, against
  network egress on a remote backend, and against the digest above.
- **Letting a backend declare that it stores binary natively** (`Uint8Array`, `Buffer`, `Blob`)
  would remove the round trip rather than speed it up, and `deserializeEntry` already types
  `body` as `string | Uint8Array`. It is worth less than it was before this change, and it is not
  free: `hash` renders a typed array as its element values, so the etag would need a
  bytes-capable digest or the store would simply move its cost from the encoder to `serialize`.

  **Done**, as `StorageInterface.binary` plus `hashBytes` (`.agents/http/response.md`). In
  `bench/micro.ts` at 40 KiB, against the same memory store with the declaration removed: a hit
  is 53.2 µs against 79.1 µs, and a store 246 µs against 301 µs, halving per-store allocation
  (54.6 kb against 107.9 kb). One machine, one mitata run.

`og-image` is where this shows up under load. `results/steady.md` has since been regenerated,
and finding 2b is where the 4/3 expansion it used to carry finally leaves the store.

The earlier version of this finding measured +50/+102/+192 µs per hit and +255/+1369/+2273 µs per
store. The store column reproduces almost exactly; the hit column reads lower here, which is the
between-session absolute drift this document warns about — compare the two columns of one table,
never a column against another run.

## 2b. A byte frame removes base64 from the store itself, not just from the CPU

**measured, shipped**

Finding 2 took base64 off the CPU path and `StorageInterface.binary` took it off the entry —
but only for a backend that returns byte views _as values_. A byte-only store (`fs`, S3/R2,
`getItemRaw`, a Redis `getBuffer`) cannot take a value at all, so an adapter has to serialize
the entry, and the obvious adapter re-introduces exactly what finding 2 removed: JSON the
entry, encode the JSON, base64 the body so it survives the JSON.

`createBlobStorage` is the answer, and `harness/storage.ts` now models it as a `codec: "bytes"`
profile. `redis-az-bytes` is built by spreading `redis-az`, so the pair is provably identical
on the wire and differs in **nothing but the codec** — same seed, same key sequence, same
storage reads and writes (the run confirms 101/7 and 584/76 respectively, identical on both
sides). From `results/steady.md`:

| scenario                        | body          | hit p50 | MiB written |
| ------------------------------- | ------------- | ------: | ----------: |
| `og-image` / `redis-az`         | 64 KiB binary | 1.56 ms |       0.586 |
| `og-image` / `redis-az-bytes`   | 64 KiB binary | 1.38 ms |       0.440 |
| `ssr-product-page` / `redis-az` | 40 KiB text   | 1.27 ms |       3.033 |
| `ssr-product-page` / `-bytes`   | 40 KiB text   | 1.23 ms |       2.996 |

**The storage volume is the result, not the microseconds.** `og-image` writes 25% fewer bytes
— which is the 4/3 base64 expansion, gone — and that is a number no CPU tuning reaches: it is
egress on a remote backend, it is what counts against `maxEntryBytes`, and it is why hit p50
falls 11.5% here at all (the per-KiB wire term shrinks with the payload). Finding 2 called
this expansion out as the part that survived the encoder fix; this is where it goes.

**Text gains little, and that is expected.** A text body was never base64, so the frame only
saves JSON escaping: 1.2% of stored bytes on `ssr-product-page`, and a p50 delta inside noise.
The frame is for byte payloads. Do not read `-bytes` as "faster" — read it as "does not
inflate what it stores".

**A value with no declared payload gains nothing and costs one encode.** `markdown-render` is
in the sweep as the counter-example: a cached _function_ returning a 20 KiB string declares no
`CacheEntry.payload`, so the frame has nothing to lift and simply JSON-encodes the entry and
then encodes that. Measured at 0.90 vs 0.91 ms p50 and 0.737 MiB either way — the extra encode
is below this harness's noise floor at 20 KiB, which is not the same as free, and it grows
with payload. `createBlobStorage` is for a byte-only backend, not a default.

**What this run does not settle.** Earlier ad-hoc pairings of the codec against a _JSON-object_
adapter (one that keeps the entry as a value) disagreed by more than the effect and in both
directions, at 64 KiB text. That comparison is not in the harness and should not be quoted:
an object-shaped backend and a byte-only one are different backends, not two codecs, and the
pairing rule this document opens with does not hold across them.

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

Binary used to make it far worse: +430 µs, +1781 µs and +2753 µs for the same three sizes,
almost all of it finding 2's encode. With that fixed it is +195 µs, +427 µs and +538 µs — still
above text, because the etag digest runs over a string 4/3 the size of the bytes.

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
  (Binary bodies were the exception until finding 2's encode was fixed, and even then it was
  encoding, not size. Misses are the remaining exception, and they scale steeply — finding 3.)
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
network hop. Finding 3 is the exception: it is miss-path cost, which no backend hides. Finding 2
was the other one — 102 µs of base64 decode at 40 KiB was 11% of a `redis-az` hit, pure waste at
any backend — and that is the argument for having fixed it rather than tuning a hit path that a
network hop already dominates.

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

Findings 4, 6 and 9 come from paired measurements of `defineCachedHandler` variants;
finding 1 from those plus a direct pairing of `resolveKey` against event construction, and
an A/B that imports the old and the new `key.ts` into one process — attributing a handler
delta to one function is what the first version of that finding got wrong;
finding 2 from paired hit/store timings — a binary body against a text body of the same
size, one process per implementation and payload so neither arm inherits the other's heap —
plus direct timing of the encode and decode functions, and an A/B against a copy of `src/`
carrying the old codec; finding 3 from the same pairing with a fresh key per call, so
every call stores;
finding 5 from `new Response` with the body held constant; finding 7 from a store against a
1 MB `maxEntryBytes`. Pairing follows `timePair` in `harness/calibrate.ts` — nine repeats,
`globalThis.gc()` between sides, median of the per-repeat deltas — and needs
`node --expose-gc`, which the `pnpm bench` scripts set.

Load-run figures come from `results/steady.md`, regenerated in full for finding 2b — one
run, one seed, every scenario, so rows in it may be compared with each other. The
`personalized-dashboard` row that used to predate the scenario's 15% session churn is part of
that regeneration and is current again.

`pnpm bench:micro` covers the hit path less precisely — it is a single-pass tool, so treat
it as directional and re-measure anything you intend to act on.
