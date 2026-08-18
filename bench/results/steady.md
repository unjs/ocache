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
| **no cache** | 60 | 58 | 52.65 | 92.24 | 134 | 158 | 584 | - | 0/0/0/0 | 13.400 | 36.77 |
| memory | 60 | 58 | 0.15 | 25.57 | 47.44 | 70.92 | 76 | 87.0% | 508/0/76/0 | 3.348 | 2.02 |
| redis-az | 60 | 58 | 1.27 | 26.29 | 49.23 | 72.44 | 76 | 87.0% | 508/0/76/0 | 4.259 | 2.04 |
| redis-az-bytes | 60 | 58 | 1.23 | 26.27 | 49.40 | 72.38 | 76 | 87.0% | 508/0/76/0 | 4.240 | 2.06 |
| kv-edge | 60 | 58 | 8.83 | 35.86 | 63.67 | 75.54 | 76 | 87.0% | 508/0/76/0 | 4.729 | 2.05 |

| config | p99 vs no cache | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 2.83x | 508 | 584 | 0.00 | 76 | 0.0 MiB |
| redis-az | 2.72x | 508 | 584 | 694 | 76 | 3.0 MiB |
| redis-az-bytes | 2.72x | 508 | 584 | 689 | 76 | 3.0 MiB |
| kv-edge | 2.11x | 508 | 584 | 5520 | 76 | 3.0 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> Latency drops to the storage round trip on hits; capacity rises because the 12 ms render is skipped. Hit ratio is set by the Zipf tail, not by the cache. The `redis-az-bytes` row is the text half of the codec pairing: the body leaves the JSON but never was base64, so only the escaping is saved.

### JSON list API `api-list`

8 KiB JSON, 3k query combinations, 40% of requests carry tracking params.

Origin: 25 ms I/O + 2 ms CPU, concurrency 20. 3000 keys, ~8 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 300 | 295 | 31.35 | 53.09 | 82.85 | 112 | 2953 | - | 0/0/0/0 | 2.852 | 6.70 |
| memory | 300 | 295 | 0.10 | 14.33 | 48.16 | 74.23 | 311 | 89.5% | 2641/0/312/0 | 1.520 | 2.89 |
| redis-az | 300 | 295 | 0.89 | 14.83 | 48.49 | 74.81 | 311 | 89.5% | 2641/0/312/0 | 1.942 | 2.87 |
| kv-edge | 300 | 295 | 7.29 | 28.47 | 66.73 | 105 | 313 | 89.4% | 2640/0/313/0 | 2.231 | 2.91 |

| config | p99 vs no cache | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 1.72x | 2642 | 2953 | 0.00 | 313 | 0.0 MiB |
| redis-az | 1.71x | 2642 | 2953 | 2561 | 313 | 2.6 MiB |
| kv-edge | 1.24x | 2640 | 2953 | 25792 | 315 | 2.6 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> A shallow head means a middling hit ratio, so per-request cache overhead is visible. `allowQuery` collapses the tracking-parameter variants that would otherwise dominate the keyspace.

### Personalized dashboard `personalized-dashboard`

15 KiB per-user page, 2k returning users plus 15% first-time sessions, tier cookie keyed.

Origin: 45 ms I/O + 3 ms CPU, concurrency 20. 4000 keys, ~15 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 220 | 214 | 56.13 | 96.98 | 150 | 185 | 2136 | - | 0/0/0/0 | 3.885 | 12.48 |
| memory | 220 | 214 | 0.12 | 44.88 | 97.02 | 135 | 391 | 81.7% | 1745/0/391/0 | 1.943 | 4.07 |
| redis-az | 220 | 214 | 1.16 | 45.50 | 99.97 | 136 | 391 | 81.7% | 1745/0/391/0 | 2.476 | 4.08 |

| config | p99 vs no cache | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 1.54x | 1745 | 2136 | 0.00 | 392 | 0.0 MiB |
| redis-az | 1.50x | 1745 | 2136 | 2145 | 392 | 6.0 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> Session churn caps the hit ratio no matter how long the cache runs. Watch what the misses cost: a slow storage profile pays for a read it does not get to use.

### OG image render `og-image`

64 KiB PNG, 180 ms blocking render, 300 slugs, 30% conditional requests.

Origin: 5 ms I/O + 180 ms CPU, concurrency 4. 300 keys, ~64 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 4 | 4 | 413 | 1002 | 1229 | 1350 | 101 | - | 0/0/0/0 | 182.067 | 180 |
| memory | 4 | 4 | 0.22 | 10.95 | 185 | 185 | 7 | 93.1% | 65/0/7/29 | 16.690 | 1.20 |
| redis-az | 4 | 4 | 1.59 | 12.90 | 186 | 186 | 7 | 93.1% | 65/0/7/29 | 18.143 | 1.21 |
| redis-az-bytes | 4 | 4 | 1.36 | 12.65 | 186 | 187 | 7 | 93.1% | 65/0/7/29 | 17.837 | 1.20 |

| config | p99 vs no cache | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 6.63x | 94 | 101 | 0.00 | 7 | 0.0 MiB |
| redis-az | 6.61x | 94 | 101 | 138 | 7 | 0.6 MiB |
| redis-az-bytes | 6.62x | 94 | 101 | 121 | 7 | 0.4 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> The largest capacity win in the set: blocking render CPU disappears on a hit. Watch the share of requests answered with 304, and the two `redis-az` rows: same wire, one storing the body as base64 inside JSON and one storing it as bytes through `createBlobStorage`.

### Rate-limited upstream proxy `upstream-proxy`

4 KiB JSON, 300 ms upstream capped at 10 concurrent calls, 20 keys.

Origin: 300 ms I/O + 1 ms CPU, concurrency 10. 20 keys, ~4 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 25 | 25 | 325 | 552 | 865 | 1046 | 304 | - | 0/0/0/0 | 4.326 | 1.87 |
| memory | 25 | 25 | 0.14 | 0.20 | 0.32 | 1.18 | 20 | 93.4% | 277/27/0/0 | 2.142 | 1.74 |
| redis-az | 25 | 25 | 0.78 | 1.54 | 2.86 | 3.22 | 20 | 93.4% | 277/27/0/0 | 2.908 | 1.67 |
| object-store | 25 | 25 | 28.51 | 60.72 | 102 | 118 | 23 | 92.4% | 275/29/0/0 | 3.691 | 1.90 |

| config | p99 vs no cache | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 2663.64x | 284 | 304 | 0.00 | 20 | 0.0 MiB |
| redis-az | 301.90x | 284 | 304 | 227 | 20 | 0.1 MiB |
| object-store | 8.46x | 281 | 304 | 10243 | 23 | 0.1 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> Baseline capacity is fixed at roughly 33 rps by the cap. Cached should hold the offered rate with about 20 origin calls per maxAge window; the burst profile shows dedup collapsing a cold stampede.

### Markdown render (function) `markdown-render`

25 ms blocking render to 20 KiB HTML, 3k documents.

Origin: 0 ms I/O + 25 ms CPU, concurrency unbounded. 3000 keys, ~20 KiB payload.

| config | offered | achieved | p50 | p90 | p99 | p99.9 | origin calls | offload | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 30 | 30 | 110 | 314 | 596 | 625 | 357 | - | - | 25.736 | 75.83 |
| memory | 30 | 30 | 0.06 | 25.09 | 25.16 | 42.35 | 37 | 89.6% | - | 4.345 | 1.85 |
| redis-local | 30 | 30 | 0.24 | 25.28 | 25.62 | 42.75 | 37 | 89.6% | - | 4.509 | 1.84 |
| redis-az | 30 | 30 | 0.90 | 25.46 | 27.41 | 43.25 | 37 | 89.6% | - | 5.155 | 1.87 |
| redis-az-bytes | 30 | 30 | 0.91 | 25.46 | 27.68 | 43.24 | 37 | 89.6% | - | 5.153 | 1.85 |
| sql | 30 | 30 | 2.79 | 26.37 | 32.17 | 44.35 | 37 | 89.6% | - | 5.768 | 1.95 |
| object-store | 30 | 30 | 35.95 | 68.54 | 113 | 127 | 37 | 89.6% | - | 5.670 | 1.94 |

| config | p99 vs no cache | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 23.67x | 320 | 357 | 0.00 | 37 | 0.0 MiB |
| redis-local | 23.25x | 320 | 357 | 87.66 | 37 | 0.7 MiB |
| redis-az | 21.73x | 320 | 357 | 324 | 37 | 0.7 MiB |
| redis-az-bytes | 21.52x | 320 | 357 | 324 | 37 | 0.7 MiB |
| sql | 18.51x | 320 | 357 | 1097 | 37 | 0.7 MiB |
| object-store | 5.26x | 320 | 357 | 12554 | 37 | 0.7 MiB |

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
| **no cache** | 90 | 90 | 230 | 429 | 681 | 782 | 1074 | - | - | 5.870 | 5.00 |
| memory | 90 | 90 | 0.04 | 1.82 | 325 | 423 | 242 | 77.5% | - | 2.571 | 4.61 |
| redis-az | 90 | 90 | 0.75 | 3.56 | 329 | 424 | 242 | 77.5% | - | 3.286 | 4.68 |
| kv-edge | 90 | 90 | 6.95 | 23.09 | 321 | 427 | 247 | 77.0% | - | 3.914 | 4.60 |
| tiered mem+redis-az | 90 | 90 | 0.04 | 2.13 | 326 | 424 | 242 | 77.5% | - | 2.671 | 4.62 |
| tiered mem+kv-edge | 90 | 90 | 0.04 | 1.73 | 335 | 437 | 242 | 77.5% | - | 2.766 | 4.62 |

| config | p99 vs no cache | origin calls avoided | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|
| memory | 2.09x | 832 | 1074 | 0.00 | 245 | 0.0 MiB |
| redis-az | 2.07x | 832 | 1074 | 861 | 245 | 0.2 MiB |
| kv-edge | 2.12x | 827 | 1074 | 8978 | 250 | 0.2 MiB |
| tiered mem+redis-az | 2.09x | 832 | 1134 | 41.76 | 307 | 0.0 MiB |
| tiered mem+kv-edge | 2.03x | 832 | 1134 | 455 | 307 | 0.0 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> A cached function has no response header to report a status through, so read `offload` instead. SWR shows up as a p50 that stays at storage latency while origin calls continue in the background.
>
> Stale serves answer in microseconds, so p50 and p90 should collapse while p99 stays bounded by the origin: a key's first touch has no stale entry and blocks. The tiered run should recover most of a slow backend's read cost while paying write amplification on misses.

### Break-even

Measured hit-path cost, sequential, memory storage, no competing load:

| payload | handler direct | handler cached | ocache adds | function direct | function cached | ocache adds |
|--:|--:|--:|--:|--:|--:|--:|
| 4 KiB | 31.7 us | 52.6 us | **+20.3 us** | 0.1 us | 3.8 us | **+3.9 us** |
| 6 KiB | 33.1 us | 55.4 us | **+22.4 us** | 0.0 us | 3.7 us | **+3.9 us** |
| 8 KiB | 44.3 us | 56.9 us | **+9.5 us** | 0.1 us | 3.6 us | **+3.9 us** |
| 15 KiB | 51.7 us | 77.9 us | **+26.9 us** | 0.1 us | 3.7 us | **+4.0 us** |
| 20 KiB | 56.3 us | 77.3 us | **+23.3 us** | 0.1 us | 3.4 us | **+3.8 us** |
| 40 KiB | 85.3 us | 109.0 us | **+22.0 us** | 0.1 us | 3.6 us | **+4.0 us** |
| 64 KiB | 116.9 us | 136.6 us | **+23.8 us** | 0.1 us | 3.6 us | **+4.0 us** |

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
