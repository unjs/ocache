# ocache benchmarks

Two layers, because "how much does ocache help" and "what does ocache cost" are different
questions and one number cannot answer both.

```sh
pnpm bench                              # all scenarios, steady load
pnpm bench ssr-product-page             # one scenario
pnpm bench --load=ramp                  # capacity: highest rate each config sustains
pnpm bench --load=burst                 # cold-cache stampede
pnpm bench --profiles=memory,sql        # override the storage sweep
pnpm bench --md=bench.md --json=bench.json   # default: bench/results/<load>.{md,json}
pnpm bench --md=-                       # print the report instead of writing it
pnpm bench --list

pnpm bench:micro                        # per-call cost of a hit (mitata)
pnpm bench:chart bench/results/steady.json --out=bench/charts
pnpm bench:chart bench/results/steady.json --no-landing   # skip the site's summary SVG
pnpm bench:docs bench/results/steady.json
```

Each run writes `bench/results/<load>.json` and `bench/results/<load>.md`, which is where
the chart and docs stages read from; `--json`/`--md` send them elsewhere.

`bench:chart` is a second stage over a JSON run: it re-renders the SVG charts without
re-running the benchmark. Each chart is one file that carries both palettes and follows the
reader's colour scheme — the OS `prefers-color-scheme` when it is rendered as an image, a
`data-theme` or `dark` ancestor when it is inlined into a page.

One of them, `combined`, is the whole run in a single compact figure: one row per scenario
comparing that workload with ocache against the same workload without it, ranked by the
improvement, over four median headline numbers — latency, origin-call reduction, CPU, and
what a hit costs. It is the figure for a page that has room for exactly one, so this stage also writes
it to `docs/.docs/public/bench.svg`, which the site's landing page links. `--landing=<file>`
sends that copy somewhere else and `--no-landing` skips it. Linked as an image rather than
inlined, that copy follows the reader's OS colour scheme, not the site's own toggle.

`bench:docs` is a third stage over the same JSON: it renders the charts through
`bench:chart` into a scratch directory and fills the placeholders in `docs.md` to write the
site's `docs/11.benchmarks.md`, which is its only output. Each chart is inlined into the
page, so it follows the site's own theme toggle rather than the reader's OS, and nothing is
copied into the site's assets. Prose belongs in `docs.md`; every number on the page comes
from the JSON, so re-run both stages after a new measurement rather than editing the
generated page. It defaults to `results/steady.json`.

`findings.md` records what these benchmarks say about ocache's own cost and where it could
come down. Read its method section before acting on any number in it.

## What the two layers measure

`bench/micro.ts` runs the hit path with an instant origin and an in-process Map, so every
number is ocache's own work: key hashing, `validate`, `transform`, `deserializeEntry`, and
the `Response` it builds per call. It is the answer to "what does a hit charge".

`bench/index.ts` drives seven scenarios under load, each run twice — once with ocache in
the path and once without — and sweeps storage backends. It is the answer to "what does a
hit buy".

## Method

**Open-loop arrivals.** Requests arrive as a Poisson process at a fixed offered rate and do
not wait for earlier requests. A closed-loop driver would throttle itself when the origin
saturates and report a flattering tail; this one lets the backlog build, which is what a
real server does.

**Latency is measured from the intended arrival time**, not from dispatch. Anything else
hides queueing delay behind the driver's own backlog — the coordinated-omission error.

**I/O and CPU are modelled separately.** `ioMs` awaits and yields the loop, so an origin
with spare concurrency serves it in parallel and caching it buys latency only. `cpuMs`
blocks the main thread, so caching it buys capacity. Every scenario declares both, plus a
`concurrency` limit standing for a connection pool, a worker pool, or an upstream quota.

**Storage latency is simulated, not stubbed out.** `harness/storage.ts` fits a lognormal to
each backend's p50/p99, adds a per-KiB payload term, and charges the caller for the encode
and decode that a remote client library performs on their thread. A cache hit is never
free: it trades an origin round trip for a storage round trip, and a profile whose read
latency approaches the origin cost turns caching into a loss.

**A profile carries a codec as well as a latency.** Most profiles JSON-encode the whole
entry, which is what almost every driver does. A `codec: "bytes"` profile instead fronts a
byte-only store — `fs`, S3/R2, `getItemRaw`, a Redis `getBuffer` — with `createBlobStorage`,
which moves the entry's declared payload as itself and JSON-encodes only the metadata around
it. Such a profile exists **only** to be compared against its JSON twin: `redis-az-bytes` is
built by spreading `redis-az`, so the pair is provably identical on the wire and differs in
nothing but the codec. Add a new one the same way, never by retyping the latency fields.

**`waitUntil` is wired and drained.** Background revalidations count as origin calls and as
CPU. Without that, SWR looks free. A handler scenario carries the hook on the request
(`makeEvent`); a function scenario has no request, so it passes `ctx.waitUntil` as the
`waitUntil` cache option instead. Either way the promise lands in the driver's background
queue rather than in the loop's own settling.

**Prewarm.** A working set of thousands of keys never fills inside a short measured window,
so each run first issues `3 × keyspace` requests with the origin and storage set to
instant. That establishes the cache state a steady-state server already holds; the reported
hit ratio then reflects the traffic distribution rather than the run length. Baseline runs
prewarm too, so both modes see the same key sequence. The timed warmup is a separate
open-loop pass that drains completely before measured counters reset. `--prewarm=0` measures
a cold cache; `--load=burst` never prewarms.

**GC control.** `pnpm bench` runs under `--expose-gc` so the hit-path calibration can
collect between the two sides of each paired measurement. Without it one side absorbs the
other's garbage, which has produced a negative overhead figure. Running `node
bench/index.ts` directly still works; the calibration is simply noisier.

**Seeds.** Every configuration draws the same key sequence, the same arrival times, and the
same latency samples. A baseline row and a cached row differ only in whether ocache is in
the path.

## Scenarios

| id                       | kind     | stands for                                                                     |
| ------------------------ | -------- | ------------------------------------------------------------------------------ |
| `ssr-product-page`       | handler  | ISR: 40 KiB HTML, 18 ms I/O + 12 ms render, 5k pages, Zipf head                |
| `api-list`               | handler  | Wide keyspace: 3k query combinations, tracking params filtered by `allowQuery` |
| `personalized-dashboard` | handler  | Where caching mostly cannot help: per-user keys, cookie allowlist              |
| `og-image`               | handler  | 180 ms blocking render, binary body (base64 path), 30% conditional requests    |
| `upstream-proxy`         | handler  | Dedup: 300 ms upstream hard-capped at 10 concurrent calls                      |
| `markdown-render`        | function | Pure blocking CPU; the cleanest capacity and break-even measurement            |
| `fanout-aggregate`       | function | SWR tail latency, plus the multi-tier `base` comparison                        |

`personalized-dashboard` and `api-list` are deliberately unflattering. A benchmark made
only of favourable cases is not a measurement.

## Reading the output

- `origin calls/req` — foreground and background origin invocations divided by admitted
  measured requests. Its reduction from the no-cache value maps to origin work;
  deduplication and SWR mean it is not a request-level cache-hit share.
- `p99 vs no cache` — the headline ratio. Under `--load=ramp` the honest capacity figure is
  `sustained rps` instead: the highest offered rate held within the p99 budget.
- `cpu/req` — main-thread milliseconds per request, which converts directly to cost per
  request.
- `blocked on reads` — wall time, so it includes event-loop queueing behind the scenario's
  own CPU, not only backend latency.
- `rejected` and `⚠` on `achieved` — measured arrivals rejected at the in-flight ceiling.
  Percentiles cover admitted requests only, so read them together with the rejected count.
- A cached **function** has no response header to report a status through, so its status
  column is blank; read `origin calls/req`. SWR shows up as a p50 that stays at storage latency
  while origin calls continue in the background.

## Known limits

- Handlers are driven in-process. There is no socket, no HTTP parser, and no server
  framework, so absolute rates are higher than a deployed service would reach. The
  baseline-to-cached comparison is the point; the absolute rate is not.
- Storage profiles are estimates. They are one table in `harness/storage.ts`; measure your
  own backend and edit it before quoting the numbers.
- A codec pairing measures the codec, not the backend. `redis-az` and `redis-az-bytes` share
  one latency model, so their delta is CPU and payload size — it is not evidence about how
  any particular Redis client behaves.
- The clock pump competes with the workload for the event loop, so `cpu/req` includes some
  harness overhead. It is the same in both modes, so the comparison holds.
- A configuration offered more than it can serve reports percentiles that grow with
  `durationMs`, because an open-loop backlog that never clears is still counted when the
  window closes. `⚠` does not catch it — that flag is the in-flight ceiling only. A
  scenario's origin limits are per call, so check them against the calls a request makes,
  and confirm a suspect row by re-running it at two window lengths.
- Multi-tier `base` prefixes live on one `StorageInterface`, so a memory-over-remote tier
  needs the prefix router in `harness/storage.ts`. ocache ships no such router.
