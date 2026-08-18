# ocache benchmark

Node v24.19.0 · seed 1 · load `steady` · 572s

Storage profiles are simulated round trips (lognormal, fitted to p50/p99) plus the
JSON encode/decode a remote client library performs on the caller's thread:

| profile | read p50/p99 | write p50/p99 | models |
|---|--:|--:|---|
| `memory` | 0/0 ms | 0/0 ms | in-process Map (createMemoryStorage) |
| `redis-local` | 0.12/0.5 ms | 0.15/0.6 ms | unix socket or sidecar valkey |
| `redis-az` | 0.6/3 ms | 0.8/4 ms | same-region TCP |
| `redis-az-bytes` | 0.6/3 ms | 0.8/4 ms | same-region TCP, one blob per entry (createBlobStorage) |
| `sql` | 2/15 ms | 5/30 ms | Postgres or D1 key-value table |
| `kv-edge` | 6/40 ms | 25/120 ms | Cloudflare KV / Deno KV, eventually consistent |
| `object-store` | 30/120 ms | 55/200 ms | S3 / R2 GetObject |
| `object-store-bytes` | 30/120 ms | 55/200 ms | S3 / R2 GetObject, one blob per entry (createBlobStorage) |

### SSR product page `ssr-product-page`

40 KiB HTML, 2 DB queries + template render, 5k pages, Zipf head.

Origin: 18 ms I/O + 12 ms CPU, concurrency 20. 5000 keys, ~40 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 60 | 58 | 52.85 | 93.19 | 137 | 154 | 584 | - | 0/0/0/0 | 13.416 | 36.83 |
| memory | 60 | 58 | 0.16 | 25.62 | 47.46 | 70.82 | 76 | 87.0% | 508/0/76/0 | 3.348 | 2.06 |
| redis-az | 60 | 58 | 1.27 | 26.44 | 49.33 | 72.37 | 76 | 87.0% | 508/0/76/0 | 4.254 | 2.08 |
| redis-az-bytes | 60 | 58 | 1.23 | 26.15 | 49.54 | 72.28 | 76 | 87.0% | 508/0/76/0 | 4.253 | 2.09 |
| kv-edge | 60 | 58 | 8.94 | 38.21 | 68.71 | 75.74 | 76 | 87.0% | 508/0/76/0 | 4.672 | 3.84 |

| config | p99 vs no cache | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 2.89x | 508 | 584 | 0.00 | 76 | 0.0 MiB |
| redis-az | 2.78x | 508 | 584 | 693 | 76 | 3.0 MiB |
| redis-az-bytes | 2.77x | 508 | 584 | 691 | 76 | 3.0 MiB |
| kv-edge | 1.99x | 508 | 584 | 5562 | 76 | 3.0 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> Latency drops to the storage round trip on hits; capacity rises because the 12 ms render is skipped. Hit ratio is set by the Zipf tail, not by the cache. The `redis-az-bytes` row is the text half of the codec pairing: the body leaves the JSON but never was base64, so only the escaping is saved.

### JSON list API `api-list`

8 KiB JSON, 3k query combinations, 40% of requests carry tracking params.

Origin: 25 ms I/O + 2 ms CPU, concurrency 20. 3000 keys, ~8 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 300 | 295 | 31.31 | 53.19 | 83.00 | 112 | 2953 | - | 0/0/0/0 | 2.860 | 6.61 |
| memory | 300 | 295 | 0.10 | 14.22 | 48.44 | 74.28 | 311 | 89.5% | 2641/0/312/0 | 1.522 | 2.91 |
| redis-az | 300 | 295 | 0.90 | 14.85 | 48.50 | 74.77 | 311 | 89.5% | 2641/0/312/0 | 1.944 | 2.87 |
| kv-edge | 300 | 295 | 7.27 | 28.44 | 66.46 | 105 | 313 | 89.4% | 2640/0/313/0 | 2.237 | 2.88 |

| config | p99 vs no cache | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 1.71x | 2642 | 2953 | 0.00 | 313 | 0.0 MiB |
| redis-az | 1.71x | 2642 | 2953 | 2559 | 313 | 2.6 MiB |
| kv-edge | 1.25x | 2640 | 2953 | 25796 | 315 | 2.6 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> A shallow head means a middling hit ratio, so per-request cache overhead is visible. `allowQuery` collapses the tracking-parameter variants that would otherwise dominate the keyspace.

### Personalized dashboard `personalized-dashboard`

15 KiB per-user page, 2k returning users plus 15% first-time sessions, tier cookie keyed.

Origin: 45 ms I/O + 3 ms CPU, concurrency 20. 4000 keys, ~15 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 220 | 214 | 56.12 | 96.53 | 149 | 188 | 2136 | - | 0/0/0/0 | 3.886 | 12.41 |
| memory | 220 | 214 | 0.12 | 44.81 | 96.97 | 135 | 391 | 81.7% | 1745/0/391/0 | 1.947 | 4.06 |
| redis-az | 220 | 214 | 1.17 | 45.49 | 100 | 136 | 391 | 81.7% | 1745/0/391/0 | 2.483 | 4.04 |

| config | p99 vs no cache | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 1.54x | 1745 | 2136 | 0.00 | 392 | 0.0 MiB |
| redis-az | 1.49x | 1745 | 2136 | 2119 | 392 | 6.0 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> Session churn caps the hit ratio no matter how long the cache runs. Watch what the misses cost: a slow storage profile pays for a read it does not get to use.

### OG image render `og-image`

64 KiB PNG, 180 ms blocking render, 300 slugs, 30% conditional requests.

Origin: 5 ms I/O + 180 ms CPU, concurrency 4. 300 keys, ~64 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 4 | 4 | 413 | 1002 | 1229 | 1350 | 101 | - | 0/0/0/0 | 182.088 | 180 |
| memory | 4 | 4 | 0.23 | 11.36 | 185 | 185 | 7 | 93.1% | 65/0/7/29 | 16.648 | 1.19 |
| redis-az | 4 | 4 | 1.56 | 13.30 | 186 | 186 | 7 | 93.1% | 65/0/7/29 | 17.779 | 1.20 |
| redis-az-bytes | 4 | 4 | 1.38 | 13.38 | 186 | 186 | 7 | 93.1% | 65/0/7/29 | 17.682 | 1.20 |

| config | p99 vs no cache | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 6.65x | 94 | 101 | 0.00 | 7 | 0.0 MiB |
| redis-az | 6.62x | 94 | 101 | 137 | 7 | 0.6 MiB |
| redis-az-bytes | 6.62x | 94 | 101 | 122 | 7 | 0.4 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> The largest capacity win in the set: blocking render CPU disappears on a hit. Watch the share of requests answered with 304, and the two `redis-az` rows: same wire, one storing the body as base64 inside JSON and one storing it as bytes through `createBlobStorage`.

### Rate-limited upstream proxy `upstream-proxy`

4 KiB JSON, 300 ms upstream capped at 10 concurrent calls, 20 keys.

Origin: 300 ms I/O + 1 ms CPU, concurrency 10. 20 keys, ~4 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 25 | 25 | 325 | 552 | 865 | 1046 | 304 | - | 0/0/0/0 | 4.343 | 1.91 |
| memory | 25 | 25 | 0.17 | 0.22 | 0.39 | 1.30 | 20 | 93.4% | 277/27/0/0 | 2.141 | 1.69 |
| redis-az | 25 | 25 | 0.80 | 1.59 | 2.78 | 3.21 | 20 | 93.4% | 277/27/0/0 | 2.953 | 1.71 |
| object-store | 25 | 25 | 28.50 | 60.71 | 102 | 118 | 23 | 92.4% | 275/29/0/0 | 3.672 | 1.88 |

| config | p99 vs no cache | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 2219.46x | 284 | 304 | 0.00 | 20 | 0.0 MiB |
| redis-az | 310.78x | 284 | 304 | 228 | 20 | 0.1 MiB |
| object-store | 8.46x | 281 | 304 | 10244 | 23 | 0.1 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> Baseline capacity is fixed at roughly 33 rps by the cap. Cached should hold the offered rate with about 20 origin calls per maxAge window; the burst profile shows dedup collapsing a cold stampede.

### Markdown render (function) `markdown-render`

25 ms blocking render to 20 KiB HTML, 3k documents.

Origin: 0 ms I/O + 25 ms CPU, concurrency unbounded. 3000 keys, ~20 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 30 | 30 | 110 | 314 | 596 | 625 | 357 | - | - | 25.732 | 75.89 |
| memory | 30 | 30 | 0.07 | 25.10 | 25.20 | 42.55 | 37 | 89.6% | - | 4.326 | 1.81 |
| redis-local | 30 | 30 | 0.26 | 25.31 | 25.71 | 43.53 | 37 | 89.6% | - | 4.542 | 1.86 |
| redis-az | 30 | 30 | 0.90 | 25.49 | 27.42 | 43.21 | 37 | 89.6% | - | 5.208 | 1.87 |
| redis-az-bytes | 30 | 30 | 0.91 | 25.49 | 27.47 | 43.23 | 37 | 89.6% | - | 5.173 | 1.82 |
| sql | 30 | 30 | 2.80 | 26.38 | 32.17 | 44.34 | 37 | 89.6% | - | 5.783 | 1.92 |
| object-store | 30 | 30 | 35.97 | 68.55 | 113 | 127 | 37 | 89.6% | - | 5.676 | 1.96 |

| config | p99 vs no cache | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 23.64x | 320 | 357 | 0.00 | 37 | 0.0 MiB |
| redis-local | 23.17x | 320 | 357 | 87.74 | 37 | 0.7 MiB |
| redis-az | 21.73x | 320 | 357 | 323 | 37 | 0.7 MiB |
| redis-az-bytes | 21.69x | 320 | 357 | 324 | 37 | 0.7 MiB |
| sql | 18.52x | 320 | 357 | 1098 | 37 | 0.7 MiB |
| object-store | 5.26x | 320 | 357 | 12553 | 37 | 0.7 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> A cached function has no response header to report a status through, so read `offload` instead. SWR shows up as a p50 that stays at storage latency while origin calls continue in the background.
>
> Baseline throughput is pinned at 1000/25 = 40 rps. Cached capacity should scale with hit ratio until storage latency becomes the new floor. `redis-az-bytes` is here as the counter-example: this value is a string, not bytes and not a response body, so it declares no payload and the frame has nothing to lift — it should cost more than plain `redis-az`, not less.

### Fan-out aggregation (function) `fanout-aggregate`

3 parallel upstreams, 220 ms slowest, 500 keys, SWR with a long stale window.

Origin: 220 ms I/O + 4 ms CPU, concurrency 30. 500 keys, ~6 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 90 | 90 | 230 | 429 | 681 | 782 | 1074 | - | - | 5.873 | 4.99 |
| memory | 90 | 90 | 0.04 | 1.84 | 325 | 423 | 242 | 77.5% | - | 2.658 | 4.60 |
| redis-az | 90 | 90 | 0.76 | 3.62 | 329 | 424 | 242 | 77.5% | - | 3.356 | 4.71 |
| kv-edge | 90 | 90 | 6.98 | 23.03 | 321 | 427 | 247 | 77.0% | - | 3.967 | 4.60 |
| tiered mem+redis-az | 90 | 90 | 0.04 | 2.14 | 326 | 424 | 242 | 77.5% | - | 2.751 | 4.63 |
| tiered mem+kv-edge | 90 | 90 | 0.04 | 1.83 | 335 | 437 | 242 | 77.5% | - | 2.751 | 4.66 |

| config | p99 vs no cache | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 2.09x | 832 | 1074 | 0.00 | 245 | 0.0 MiB |
| redis-az | 2.07x | 832 | 1074 | 863 | 245 | 0.2 MiB |
| kv-edge | 2.12x | 827 | 1074 | 8985 | 250 | 0.2 MiB |
| tiered mem+redis-az | 2.09x | 832 | 1134 | 41.77 | 306 | 0.0 MiB |
| tiered mem+kv-edge | 2.03x | 832 | 1134 | 454 | 307 | 0.0 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> A cached function has no response header to report a status through, so read `offload` instead. SWR shows up as a p50 that stays at storage latency while origin calls continue in the background.
>
> Stale serves should push p99 below the origin's own latency. The tiered run should recover most of a slow backend's read cost while paying write amplification on misses.

### Break-even

Measured hit-path cost, sequential, memory storage, no competing load:

| payload | handler direct | handler cached | ocache adds | function direct | function cached | ocache adds |
|--:|--:|--:|--:|--:|--:|--:|
| 4 KiB | 33.9 us | 53.4 us | **+21.2 us** | 0.1 us | 3.8 us | **+4.6 us** |
| 6 KiB | 33.5 us | 55.2 us | **+23.4 us** | 0.1 us | 3.9 us | **+4.2 us** |
| 8 KiB | 45.7 us | 58.3 us | **+12.4 us** | 0.1 us | 3.9 us | **+4.1 us** |
| 15 KiB | 51.2 us | 76.5 us | **+30.0 us** | 0.1 us | 4.2 us | **+4.4 us** |
| 20 KiB | 54.4 us | 74.7 us | **+23.7 us** | 0.1 us | 4.0 us | **+4.4 us** |
| 40 KiB | 84.2 us | 105.5 us | **+23.5 us** | 0.1 us | 4.0 us | **+4.5 us** |
| 64 KiB | 116.0 us | 138.7 us | **+23.9 us** | 0.1 us | 3.7 us | **+4.0 us** |

Adding each backend's median read gives the origin cost a handler must exceed:

| backend | read p50 | read p99 | a handler pays off above |
|---|--:|--:|--:|
| `memory` | 0 ms | 0 ms | 0.03 ms |
| `redis-local` | 0.12 ms | 0.5 ms | 0.15 ms |
| `redis-az` | 0.6 ms | 3 ms | 0.63 ms |
| `redis-az-bytes` | 0.6 ms | 3 ms | 0.63 ms |
| `sql` | 2 ms | 15 ms | 2.03 ms |
| `kv-edge` | 6 ms | 40 ms | 6.03 ms |
| `object-store` | 30 ms | 120 ms | 30.03 ms |
| `object-store-bytes` | 30 ms | 120 ms | 30.03 ms |

> Uses the largest measured overhead. A handler cheaper than its row is faster without a cache. This is the library's own cost only: a remote backend also decodes the body, which does scale with payload.
