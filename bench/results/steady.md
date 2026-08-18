# ocache benchmark

Node v24.19.0 · seed 1 · load `steady` · 503s

Storage profiles are simulated round trips (lognormal, fitted to p50/p99) plus the
JSON encode/decode a remote client library performs on the caller's thread:

| profile | read p50/p99 | write p50/p99 | models |
|---|--:|--:|---|
| `memory` | 0/0 ms | 0/0 ms | in-process Map (createMemoryStorage) |
| `redis-local` | 0.12/0.5 ms | 0.15/0.6 ms | unix socket or sidecar valkey |
| `redis-az` | 0.6/3 ms | 0.8/4 ms | same-region TCP |
| `sql` | 2/15 ms | 5/30 ms | Postgres or D1 key-value table |
| `kv-edge` | 6/40 ms | 25/120 ms | Cloudflare KV / Deno KV, eventually consistent |
| `object-store` | 30/120 ms | 55/200 ms | S3 / R2 GetObject |

### SSR product page `ssr-product-page`

40 KiB HTML, 2 DB queries + template render, 5k pages, Zipf head.

Origin: 18 ms I/O + 12 ms CPU, concurrency 20. 5000 keys, ~40 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **baseline** (no cache) | 60 | 58 | 52.22 | 92.16 | 134 | 158 | 584 | - | 0/0/0/0 | 13.389 | 36.70 |
| memory | 60 | 58 | 0.15 | 25.52 | 47.49 | 70.88 | 76 | 87.0% | 508/0/76/0 | 3.353 | 2.07 |
| redis-az | 60 | 58 | 1.26 | 26.55 | 49.39 | 72.43 | 76 | 87.0% | 508/0/76/0 | 4.280 | 2.06 |
| kv-edge | 60 | 58 | 8.86 | 35.89 | 63.69 | 75.41 | 76 | 87.0% | 508/0/76/0 | 4.733 | 2.11 |

| config | p99 vs baseline | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 2.83x | 508 | 584 | 0.00 | 76 | 0.0 MiB |
| redis-az | 2.72x | 508 | 584 | 693 | 76 | 3.0 MiB |
| kv-edge | 2.11x | 508 | 584 | 5521 | 76 | 3.0 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> Latency drops to the storage round trip on hits; capacity rises because the 12 ms render is skipped. Hit ratio is set by the Zipf tail, not by the cache.

### JSON list API `api-list`

8 KiB JSON, 3k query combinations, 40% of requests carry tracking params.

Origin: 25 ms I/O + 2 ms CPU, concurrency 20. 3000 keys, ~8 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **baseline** (no cache) | 300 | 295 | 31.31 | 53.06 | 83.13 | 112 | 2953 | - | 0/0/0/0 | 2.850 | 6.28 |
| memory | 300 | 295 | 0.10 | 14.18 | 48.15 | 74.21 | 311 | 89.5% | 2641/0/312/0 | 1.519 | 2.83 |
| redis-az | 300 | 295 | 0.90 | 14.83 | 48.47 | 74.75 | 311 | 89.5% | 2641/0/312/0 | 1.949 | 2.89 |
| kv-edge | 300 | 295 | 7.27 | 28.58 | 66.43 | 105 | 313 | 89.4% | 2640/0/313/0 | 2.237 | 2.91 |

| config | p99 vs baseline | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 1.73x | 2642 | 2953 | 0.00 | 313 | 0.0 MiB |
| redis-az | 1.71x | 2642 | 2953 | 2563 | 313 | 2.6 MiB |
| kv-edge | 1.25x | 2640 | 2953 | 25810 | 315 | 2.6 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> A shallow head means a middling hit ratio, so per-request cache overhead is visible. `allowQuery` collapses the tracking-parameter variants that would otherwise dominate the keyspace.

### Personalized dashboard `personalized-dashboard`

15 KiB per-user page, 2k returning users plus 15% first-time sessions, tier cookie keyed.

Origin: 45 ms I/O + 3 ms CPU, concurrency 20. 4000 keys, ~15 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **baseline** (no cache) | 220 | 214 | 56.43 | 97.33 | 149 | 194 | 2136 | - | 0/0/0/0 | 3.892 | 12.44 |
| memory | 220 | 214 | 0.13 | 44.86 | 96.94 | 135 | 391 | 81.7% | 1745/0/391/0 | 1.946 | 4.05 |
| redis-az | 220 | 214 | 1.18 | 45.53 | 99.96 | 136 | 391 | 81.7% | 1745/0/391/0 | 2.484 | 4.06 |

| config | p99 vs baseline | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 1.53x | 1745 | 2136 | 0.00 | 392 | 0.0 MiB |
| redis-az | 1.49x | 1745 | 2136 | 2133 | 392 | 6.0 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> Session churn caps the hit ratio no matter how long the cache runs. Watch what the misses cost: a slow storage profile pays for a read it does not get to use.

### OG image render `og-image`

64 KiB PNG, 180 ms blocking render, 300 slugs, 30% conditional requests.

Origin: 5 ms I/O + 180 ms CPU, concurrency 4. 300 keys, ~64 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **baseline** (no cache) | 4 | 4 | 413 | 1001 | 1229 | 1349 | 101 | - | 0/0/0/0 | 182.137 | 180 |
| memory | 4 | 4 | 0.40 | 14.01 | 188 | 189 | 7 | 93.1% | 65/0/7/29 | 17.981 | 1.12 |
| redis-az | 4 | 4 | 1.74 | 15.74 | 188 | 189 | 7 | 93.1% | 65/0/7/29 | 18.330 | 1.25 |

| config | p99 vs baseline | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 6.54x | 94 | 101 | 0.00 | 7 | 0.0 MiB |
| redis-az | 6.52x | 94 | 101 | 141 | 7 | 0.6 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> The largest capacity win in the set: blocking render CPU disappears on a hit. Watch the base64 write cost and the share of requests answered with 304.

### Rate-limited upstream proxy `upstream-proxy`

4 KiB JSON, 300 ms upstream capped at 10 concurrent calls, 20 keys.

Origin: 300 ms I/O + 1 ms CPU, concurrency 10. 20 keys, ~4 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **baseline** (no cache) | 25 | 25 | 325 | 552 | 865 | 1046 | 304 | - | 0/0/0/0 | 4.349 | 1.85 |
| memory | 25 | 25 | 0.22 | 0.29 | 0.48 | 0.94 | 20 | 93.4% | 277/27/0/0 | 2.284 | 1.76 |
| redis-az | 25 | 25 | 0.85 | 1.63 | 2.74 | 3.20 | 20 | 93.4% | 277/27/0/0 | 2.974 | 1.71 |
| object-store | 25 | 25 | 28.72 | 60.94 | 102 | 118 | 23 | 92.4% | 275/29/0/0 | 3.894 | 1.88 |

| config | p99 vs baseline | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 1784.11x | 284 | 304 | 0.00 | 20 | 0.0 MiB |
| redis-az | 316.12x | 284 | 304 | 227 | 20 | 0.1 MiB |
| object-store | 8.46x | 281 | 304 | 10278 | 23 | 0.1 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> Baseline capacity is fixed at roughly 33 rps by the cap. Cached should hold the offered rate with about 20 origin calls per maxAge window; the burst profile shows dedup collapsing a cold stampede.

### Markdown render (function) `markdown-render`

25 ms blocking render to 20 KiB HTML, 3k documents.

Origin: 0 ms I/O + 25 ms CPU, concurrency unbounded. 3000 keys, ~20 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **baseline** (no cache) | 30 | 30 | 110 | 314 | 596 | 625 | 357 | - | - | 25.552 | 75.63 |
| memory | 30 | 30 | 0.07 | 25.13 | 25.21 | 42.42 | 37 | 89.6% | - | 4.336 | 1.84 |
| redis-local | 30 | 30 | 0.26 | 25.31 | 25.61 | 42.88 | 37 | 89.6% | - | 4.511 | 1.82 |
| redis-az | 30 | 30 | 0.91 | 25.44 | 27.45 | 43.24 | 37 | 89.6% | - | 5.202 | 1.88 |
| sql | 30 | 30 | 2.81 | 26.43 | 32.16 | 44.33 | 37 | 89.6% | - | 5.765 | 1.94 |
| object-store | 30 | 30 | 35.99 | 68.54 | 113 | 127 | 37 | 89.6% | - | 5.721 | 1.93 |

| config | p99 vs baseline | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 23.64x | 320 | 357 | 0.00 | 37 | 0.0 MiB |
| redis-local | 23.26x | 320 | 357 | 86.98 | 37 | 0.7 MiB |
| redis-az | 21.70x | 320 | 357 | 324 | 37 | 0.7 MiB |
| sql | 18.52x | 320 | 357 | 1097 | 37 | 0.7 MiB |
| object-store | 5.26x | 320 | 357 | 12553 | 37 | 0.7 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> A cached function has no response header to report a status through, so read `offload` instead. SWR shows up as a p50 that stays at storage latency while origin calls continue in the background.
>
> Baseline throughput is pinned at 1000/25 = 40 rps. Cached capacity should scale with hit ratio until storage latency becomes the new floor.

### Fan-out aggregation (function) `fanout-aggregate`

3 parallel upstreams, 220 ms slowest, 500 keys, SWR with a long stale window.

Origin: 220 ms I/O + 4 ms CPU, concurrency 30. 500 keys, ~6 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **baseline** (no cache) | 90 | 90 | 230 | 429 | 681 | 782 | 1074 | - | - | 5.873 | 5.01 |
| memory | 90 | 90 | 0.04 | 1.84 | 325 | 423 | 242 | 77.5% | - | 2.655 | 4.60 |
| redis-az | 90 | 90 | 0.77 | 3.58 | 329 | 424 | 242 | 77.5% | - | 3.356 | 4.62 |
| kv-edge | 90 | 90 | 6.86 | 22.46 | 360 | 527 | 245 | 77.2% | - | 4.001 | 4.62 |
| tiered mem+redis-az | 90 | 90 | 0.04 | 2.10 | 326 | 424 | 242 | 77.5% | - | 2.734 | 4.55 |
| tiered mem+kv-edge | 90 | 90 | 0.04 | 1.75 | 335 | 437 | 242 | 77.5% | - | 2.769 | 4.64 |

| config | p99 vs baseline | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 2.09x | 832 | 1074 | 0.00 | 245 | 0.0 MiB |
| redis-az | 2.07x | 832 | 1074 | 864 | 245 | 0.2 MiB |
| kv-edge | 1.89x | 829 | 1074 | 8830 | 248 | 0.2 MiB |
| tiered mem+redis-az | 2.09x | 832 | 1134 | 41.76 | 306 | 0.0 MiB |
| tiered mem+kv-edge | 2.03x | 832 | 1134 | 455 | 307 | 0.0 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> A cached function has no response header to report a status through, so read `offload` instead. SWR shows up as a p50 that stays at storage latency while origin calls continue in the background.
>
> Stale serves should push p99 below the origin's own latency. The tiered run should recover most of a slow backend's read cost while paying write amplification on misses.

### Break-even

Measured hit-path cost, sequential, memory storage, no competing load:

| payload | handler direct | handler cached | ocache adds | function direct | function cached | ocache adds |
|--:|--:|--:|--:|--:|--:|--:|
| 4 KiB | 15.1 us | 30.9 us | **+22.3 us** | 0.1 us | 3.1 us | **+3.6 us** |
| 6 KiB | 16.8 us | 32.9 us | **+16.5 us** | 0.0 us | 3.0 us | **+3.0 us** |
| 8 KiB | 17.8 us | 33.9 us | **+17.0 us** | 0.0 us | 3.0 us | **+3.0 us** |
| 15 KiB | 23.5 us | 39.1 us | **+15.0 us** | 0.0 us | 3.1 us | **+3.1 us** |
| 20 KiB | 38.0 us | 50.5 us | **+29.4 us** | 0.0 us | 2.9 us | **+3.0 us** |
| 40 KiB | 63.8 us | 82.7 us | **+24.9 us** | 0.0 us | 2.9 us | **+3.0 us** |
| 64 KiB | 94.4 us | 120.3 us | **+25.4 us** | 0.1 us | 2.8 us | **+3.0 us** |

Adding each backend's median read gives the origin cost a handler must exceed:

| backend | read p50 | read p99 | a handler pays off above |
|---|--:|--:|--:|
| `memory` | 0 ms | 0 ms | 0.03 ms |
| `redis-local` | 0.12 ms | 0.5 ms | 0.15 ms |
| `redis-az` | 0.6 ms | 3 ms | 0.63 ms |
| `sql` | 2 ms | 15 ms | 2.03 ms |
| `kv-edge` | 6 ms | 40 ms | 6.03 ms |
| `object-store` | 30 ms | 120 ms | 30.03 ms |

> Uses the largest measured overhead. A handler cheaper than its row is faster without a cache. This is the library's own cost only: a remote backend also decodes the body, which does scale with payload.
