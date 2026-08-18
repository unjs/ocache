---
icon: lucide:gauge
title: Benchmarks
---

<!-- bench:docs
Template for `docs/11.benchmarks.md`. Prose lives here and is edited by hand; every number
and every figure is substituted by `bench/docs.ts` (`pnpm bench:docs [results.json]`) from a
benchmark results JSON. Nothing measured may be typed into this file.

Placeholders are `{{kind:key}}`, and `grep -o '{{[^}]*}}' bench/docs.md` lists them all:

  {{value:key}}     one measured or derived figure. Ratios carry their `x` and shares their
                    `%`, as the markdown report writes them; everything else is a bare
                    number, so write its unit in the prose here.
  {{table:key}}     a generated table, already padded the way `oxfmt` wants it.
  {{chart:name}}    one named chart, inlined as SVG so it follows the site's theme toggle.
  {{charts:prefix}} every chart whose file name starts with `prefix`, in report order.

An unknown key, or a chart the run did not produce, fails generation rather than reaching
the page. Comments in this form are stripped from the generated page.
-->

# Benchmarks

A cache raises two questions: **how much does it help, and what does it cost?** No single number answers both, so this page reports several. Everything below comes from one run of the benchmark harness in [`bench/`](https://github.com/unjs/ocache/tree/main/bench): Node {{value:node}}, seed {{value:seed}}, load profile `{{value:load}}`, {{value:scenario-count}} scenarios, {{value:config-count}} cached configurations, {{value:measured-requests}} measured requests.

None of the numbers on this page are typed by hand. They are all filled in from the run's JSON when the page is generated, so you can re-run the benchmark on your own hardware and regenerate the page to see your own results.

The whole run in one figure: every workload with ocache against the same workload without it, ranked by how much p99 latency improved, over the medians across all of them. Each row here shows one storage backend — the chart names it — and one offered rate; the rest of this page takes that apart.

{{chart:combined}}

## How the benchmark works

Each scenario models a realistic workload rather than a library feature: a page render, a JSON list, a per-user dashboard, an image render, an upstream API with a rate cap. Every scenario runs **twice — once with ocache in the path and once without** — so the difference between the two rows is exactly what caching changed. The cached side is then repeated across several storage backends. Backend latency is simulated from real-world p50/p99 figures rather than set to zero. This run covers {{value:profile-list}}; each scenario uses the backends that make sense for it, and its chart lists which ones.

A backend name ending in `-bytes` is not a different backend. It is the same simulated wire
as its twin — `redis-az-bytes` and `redis-az` share one latency model exactly — running
through [`createBlobStorage`](/docs/storage#keeping-bodies-as-bytes-on-a-byte-only-driver), which
stores each entry as one byte frame instead of a JSON document. The pair is there so the
codec can be read off the difference between two rows rather than argued about.

A few choices keep the results honest:

- **Requests do not wait for each other.** They arrive on a fixed random schedule (a Poisson process), and latency is measured from when a request _should_ have started, not when the server got around to it. A benchmark that waits for each response before sending the next one hides queueing delay — the thing users actually feel under load.
- **Waiting and computing are modelled separately.** When the origin waits on I/O (a database, an upstream call), caching that away buys **latency**. When the origin computes on the main thread, caching it away buys **capacity** — the server can handle more traffic. Most scenarios include both.
- **Caches are warmed up first.** The hit ratio you see reflects the shape of the traffic, not how short the measurement was — which is what a long-running server actually experiences.
- **Both sides see identical traffic.** Same keys, same arrival times, same simulated latencies. The only difference is whether ocache is in the path.

> [!NOTE]
> Handlers are called directly in process — no network socket, no HTTP parser, no framework — so the absolute request rates are higher than a real deployment reaches. What matters is the comparison between the no-cache and cached rows, not the absolute numbers. The [harness README](https://github.com/unjs/ocache/blob/main/bench/README.md) explains the full method and its known limits.

## How much caching helps

{{table:scenarios}}

Look at the whole range, not just the best row. Across every cached configuration in this run, p99 latency improves between {{value:speedup-min}} and {{value:speedup-max}}, with a median of {{value:speedup-median}}. What sets the extremes is the origin, not the cache: when the origin is the bottleneck — a render that blocks the main thread, or an upstream that only allows so many requests at once — a cache hit removes an entire queue, not just one round trip, and the improvement becomes enormous. That is what happens to `{{value:top-scenario}}` at {{value:top-speedup}}.

The scenario that gains the least is `{{value:worst-scenario}}`, at {{value:worst-speedup}} even on its fastest backend — and yet it still reduces origin invocations by {{value:worst-offload}}. That is the point: **faster responses and less origin work are two separate wins**, and a workload can get one without the other. Hard cases like this one — per-user keys, short-lived sessions, many distinct keys — are included on purpose. A benchmark made only of easy wins would not tell you anything.

**Origin-call reduction** compares foreground and background origin invocations per admitted measured request with the matching no-cache row. It maps to origin work, but is deliberately not described as a request-level cache-hit share: deduplicated misses can share one invocation, while a stale response can launch a background refresh. Here it ranges from {{value:offload-min}} to {{value:offload-max}}, driven by traffic distribution and key cardinality:

{{chart:origin-call-reduction}}

## Latency, scenario by scenario

One chart per scenario: p50 through p99 for every configuration on a log axis, with the main-thread CPU spent per request next to each row. The bold **no cache** row is the workload without ocache; every row below it is the same workload running through one storage backend.

{{charts:latency-}}

## More capacity, not just lower latency

A cache hit skips whatever work the origin would have done on the main thread — and that work is what limits how much traffic one server instance can handle. In the heaviest scenario here, `{{value:cpu-top-scenario}}`, main-thread CPU drops from {{value:cpu-top-baseline}} ms per request to {{value:cpu-top-cached}} ms. When the origin mostly waits on I/O instead, the same hit buys latency but very little capacity — the CPU column in the charts above shows which case you are in.

## What a cache hit costs

Serving from cache is not free: ocache has to hash a key, check the entry is still valid, decode it, and build a `Response`. Measured against in-memory storage with nothing else running, a hit adds {{value:handler-added-min}} to {{value:handler-added-max}} µs for a cached handler and {{value:function-added-min}} to {{value:function-added-max}} µs for a cached function, across payloads from {{value:hit-payload-min}} to {{value:hit-payload-max}}.

{{table:hit-cost}}

{{chart:hit-cost}}

Notice the cost does not grow with payload size — nothing on the hit path copies the body, so the variation between rows is per-call work and measurement noise, not a size effect. The handler path costs several times the function path, and that gap is the price of being a real HTTP cache instead of a simple memo table: deriving a key from the request, validating the entry, merging headers, and building a `Response` on every call.

## When caching is not worth it

A hit is never free, and neither is the storage read that finds it: caching trades a trip to your origin for a trip to your storage backend. Adding the largest measured hit-path overhead ({{value:breakeven-overhead}} ms) to each backend's median read time gives the break-even point — the minimum origin cost a handler needs before caching pays off at all.

{{table:break-even}}

If your handler is faster than its row, it is faster with no cache at all. Two things raise the bar further: a **low hit ratio**, because every miss pays for a storage read that found nothing, and a **remote backend**, which also has to decode the response body on your thread — that part _does_ grow with payload size, and this table does not include it.

> [!TIP]
> The storage profiles are estimates fitted to a published p50/p99 pair, not measurements of your backend. They live in one table in [`bench/harness/storage.ts`](https://github.com/unjs/ocache/blob/main/bench/harness/storage.ts) — measure your own backend and edit it before quoting any of these numbers.

## Reproducing this page

```sh
pnpm bench --json=bench/results/steady.json --md=bench/results/steady.md
pnpm bench:docs bench/results/steady.json
```

The first command runs every scenario and writes the full report, including the tables this page summarizes. The second renders the charts, inlines them, and regenerates this page from the same JSON — the charts are part of the page, not files next to it. (`pnpm bench:chart` writes them out as standalone SVGs if you want them separately.) The prose lives in `bench/docs.md`; the numbers never do.
