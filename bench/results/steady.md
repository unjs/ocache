# ocache benchmark

Node v24.19.0 · seed 1 · load `steady` · 605s

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

| config | offered | achieved | rejected | p50 | p90 | p99 | p99.9 | origin calls/req | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 60 | 59 | 0 | 51.89 | 90.43 | 122 | 154 | 1.000 | 0/0/0/0 | 13.410 | 36.90 |
| memory | 60 | 59 | 0 | 0.16 | 4.23 | 42.22 | 63.29 | 0.065 | 547/0/38/0 | 2.543 | 1.98 |
| redis-az | 60 | 59 | 0 | 1.18 | 5.91 | 43.17 | 65.05 | 0.065 | 547/0/38/0 | 3.451 | 1.96 |
| redis-az-bytes | 60 | 59 | 0 | 1.18 | 5.98 | 43.14 | 65.10 | 0.065 | 547/0/38/0 | 3.461 | 1.96 |
| kv-edge | 60 | 59 | 0 | 8.26 | 26.45 | 59.53 | 83.97 | 0.065 | 547/0/38/0 | 3.908 | 2.01 |

| config | offered | p99 vs no cache | raw origin call difference | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|--:|
| memory | 60 | 2.90x | 547 | 585 | 0.00 | 38 | 0.0 MiB |
| redis-az | 60 | 2.84x | 547 | 585 | 668 | 38 | 1.5 MiB |
| redis-az-bytes | 60 | 2.84x | 547 | 585 | 665 | 38 | 1.5 MiB |
| kv-edge | 60 | 2.06x | 547 | 585 | 5483 | 38 | 1.5 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> Latency drops to the storage round trip on hits; capacity rises because the 12 ms render is skipped. Hit ratio is set by the Zipf tail, not by the cache. The `redis-az-bytes` row is the text half of the codec pairing: the body leaves the JSON but never was base64, so only the escaping is saved.

### JSON list API `api-list`

8 KiB JSON, 3k query combinations, 40% of requests carry tracking params.

Origin: 25 ms I/O + 2 ms CPU, concurrency 20. 3000 keys, ~8 KiB payload.

| config | offered | achieved | rejected | p50 | p90 | p99 | p99.9 | origin calls/req | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 300 | 295 | 0 | 31.10 | 53.76 | 83.94 | 112 | 1.000 | 0/0/0/0 | 2.878 | 8.26 |
| memory | 300 | 295 | 0 | 0.10 | 0.85 | 42.62 | 75.13 | 0.070 | 2746/0/206/0 | 1.451 | 2.68 |
| redis-az | 300 | 295 | 0 | 0.85 | 3.00 | 43.42 | 75.45 | 0.070 | 2746/0/206/0 | 1.875 | 2.84 |
| kv-edge | 300 | 295 | 0 | 6.97 | 24.00 | 57.49 | 84.70 | 0.070 | 2746/0/206/0 | 2.157 | 2.72 |

| config | offered | p99 vs no cache | raw origin call difference | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|--:|
| memory | 300 | 1.97x | 2746 | 2952 | 0.00 | 206 | 0.0 MiB |
| redis-az | 300 | 1.93x | 2746 | 2952 | 2571 | 206 | 1.7 MiB |
| kv-edge | 300 | 1.46x | 2746 | 2952 | 25553 | 206 | 1.7 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> A shallow head means a middling hit ratio, so per-request cache overhead is visible. `allowQuery` collapses the tracking-parameter variants that would otherwise dominate the keyspace.

### Personalized dashboard `personalized-dashboard`

15 KiB per-user page, 2k returning users plus 15% first-time sessions, tier cookie keyed.

Origin: 45 ms I/O + 3 ms CPU, concurrency 20. 2000 keys, ~15 KiB payload.

| config | offered | achieved | rejected | p50 | p90 | p99 | p99.9 | origin calls/req | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 220 | 214 | 0 | 56.03 | 96.41 | 151 | 188 | 1.000 | 0/0/0/0 | 3.912 | 12.52 |
| memory | 220 | 214 | 0 | 0.12 | 44.84 | 99.18 | 133 | 0.183 | 1750/0/391/0 | 1.946 | 4.07 |
| redis-az | 220 | 214 | 0 | 1.20 | 45.69 | 99.99 | 134 | 0.183 | 1750/0/391/0 | 2.487 | 4.09 |

| config | offered | p99 vs no cache | raw origin call difference | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|--:|
| memory | 220 | 1.52x | 1750 | 2141 | 0.00 | 391 | 0.0 MiB |
| redis-az | 220 | 1.51x | 1750 | 2141 | 2173 | 391 | 5.9 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> Session churn caps the hit ratio no matter how long the cache runs. Watch what the misses cost: a slow storage profile pays for a read it does not get to use.

### OG image render `og-image`

64 KiB PNG, 180 ms blocking render, 300 slugs, 30% conditional requests.

Origin: 5 ms I/O + 180 ms CPU, concurrency 4. 300 keys, ~64 KiB payload.

| config | offered | achieved | rejected | p50 | p90 | p99 | p99.9 | origin calls/req | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 4 | 4 | 0 | 370 | 953 | 1230 | 1350 | 1.000 | 0/0/0/0 | 182.052 | 180 |
| memory | 4 | 4 | 0 | 0.21 | 0.25 | 184 | 184 | 0.020 | 66/0/2/34 | 8.109 | 1.17 |
| redis-az | 4 | 4 | 0 | 1.57 | 2.37 | 185 | 186 | 0.020 | 66/0/2/34 | 8.869 | 1.14 |
| redis-az-bytes | 4 | 4 | 0 | 1.33 | 2.14 | 185 | 185 | 0.020 | 66/0/2/34 | 8.689 | 1.15 |

| config | offered | p99 vs no cache | raw origin call difference | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|--:|
| memory | 4 | 6.68x | 100 | 102 | 0.00 | 2 | 0.0 MiB |
| redis-az | 4 | 6.66x | 100 | 102 | 141 | 2 | 0.2 MiB |
| redis-az-bytes | 4 | 6.66x | 100 | 102 | 123 | 2 | 0.1 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> The largest capacity win in the set: blocking render CPU disappears on a hit. Watch the share of requests answered with 304, and the two `redis-az` rows: same wire, one storing the body as base64 inside JSON and one storing it as bytes through `createBlobStorage`.

### Rate-limited upstream proxy `upstream-proxy`

4 KiB JSON, 300 ms upstream capped at 10 concurrent calls, 20 keys.

Origin: 300 ms I/O + 1 ms CPU, concurrency 10. 20 keys, ~4 KiB payload.

| config | offered | achieved | rejected | p50 | p90 | p99 | p99.9 | origin calls/req | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 25 | 25 | 0 | 322 | 558 | 865 | 1080 | 1.000 | 0/0/0/0 | 4.279 | 1.91 |
| memory | 25 | 25 | 0 | 0.17 | 0.21 | 0.40 | 1.30 | 0.066 | 276/27/0/0 | 2.144 | 1.69 |
| redis-az | 25 | 25 | 0 | 0.78 | 1.55 | 2.70 | 3.18 | 0.066 | 276/27/0/0 | 2.887 | 1.70 |
| object-store | 25 | 25 | 0 | 29.50 | 60.55 | 102 | 118 | 0.073 | 275/28/0/0 | 3.608 | 1.87 |

| config | offered | p99 vs no cache | raw origin call difference | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|--:|
| memory | 25 | 2175.48x | 283 | 303 | 0.00 | 20 | 0.0 MiB |
| redis-az | 25 | 320.65x | 283 | 303 | 225 | 20 | 0.1 MiB |
| object-store | 25 | 8.46x | 281 | 303 | 10246 | 22 | 0.1 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> Baseline capacity is fixed at roughly 33 rps by the cap. Cached should hold the offered rate with about 20 origin calls per maxAge window; the burst profile shows dedup collapsing a cold stampede.

### Markdown render (function) `markdown-render`

25 ms blocking render to 20 KiB HTML, 3k documents.

Origin: 0 ms I/O + 25 ms CPU, concurrency unbounded. 3000 keys, ~20 KiB payload.

| config | offered | achieved | rejected | p50 | p90 | p99 | p99.9 | origin calls/req | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 30 | 30 | 0 | 100 | 315 | 596 | 625 | 1.000 | - | 25.846 | 75.56 |
| memory | 30 | 30 | 0 | 0.06 | 3.69 | 25.14 | 25.24 | 0.073 | - | 3.609 | 1.78 |
| redis-local | 30 | 30 | 0 | 0.25 | 4.30 | 25.50 | 25.96 | 0.073 | - | 3.819 | 1.85 |
| redis-az | 30 | 30 | 0 | 0.87 | 6.02 | 26.26 | 26.45 | 0.073 | - | 4.470 | 1.79 |
| redis-az-bytes | 30 | 30 | 0 | 0.89 | 6.06 | 26.28 | 26.48 | 0.073 | - | 4.465 | 1.84 |
| sql | 30 | 30 | 0 | 2.55 | 13.70 | 29.09 | 29.94 | 0.073 | - | 4.978 | 1.89 |
| object-store | 30 | 30 | 0 | 32.59 | 61.60 | 113 | 119 | 0.073 | - | 5.036 | 1.91 |

| config | offered | p99 vs no cache | raw origin call difference | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|--:|
| memory | 30 | 23.69x | 330 | 356 | 0.00 | 26 | 0.0 MiB |
| redis-local | 30 | 23.37x | 330 | 356 | 63.37 | 26 | 0.5 MiB |
| redis-az | 30 | 22.69x | 330 | 356 | 328 | 26 | 0.5 MiB |
| redis-az-bytes | 30 | 22.67x | 330 | 356 | 327 | 26 | 0.5 MiB |
| sql | 30 | 20.48x | 330 | 356 | 1066 | 26 | 0.5 MiB |
| object-store | 30 | 5.26x | 330 | 356 | 12178 | 26 | 0.5 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> A cached function has no response header to report a status through, so read `origin calls/req` instead. SWR shows up as a p50 that stays at storage latency while origin calls continue in the background.
>
> Baseline throughput is pinned at 1000/25 = 40 rps. Cached capacity should scale with hit ratio until storage latency becomes the new floor. `redis-az-bytes` is here as the counter-example: this value is a string, not bytes and not a response body, so it declares no payload and the frame has nothing to lift — it should cost more than plain `redis-az`, not less.

### Fan-out aggregation (function) `fanout-aggregate`

3 parallel upstreams, 220 ms slowest, 500 keys, SWR with a long stale window.

Origin: 220 ms I/O + 4 ms CPU, concurrency 30. 500 keys, ~6 KiB payload.

| config | offered | achieved | rejected | p50 | p90 | p99 | p99.9 | origin calls/req | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 90 | 90 | 0 | 6835 | 12074 | 13081 | 13465 | 3.000 | - | 14.759 | 8.12 |
| memory | 90 | 90 | 0 | 0.05 | 5.54 | 480 | 749 | 0.678 | - | 4.504 | 4.94 |
| redis-az | 90 | 90 | 0 | 0.93 | 8.51 | 459 | 645 | 0.684 | - | 5.079 | 4.95 |
| kv-edge | 90 | 90 | 0 | 8.47 | 26.02 | 500 | 712 | 0.689 | - | 5.544 | 4.92 |
| tiered mem+redis-az | 90 | 90 | 0 | 0.05 | 5.90 | 480 | 749 | 0.681 | - | 4.680 | 4.94 |
| tiered mem+kv-edge | 90 | 90 | 0 | 0.05 | 7.13 | 467 | 630 | 0.681 | - | 4.611 | 4.94 |

| config | offered | p99 vs no cache | raw origin call difference | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|--:|
| memory | 90 | 27.24x | 2496 | 1075 | 0.00 | 243 | 0.0 MiB |
| redis-az | 90 | 28.53x | 2490 | 1075 | 1199 | 245 | 1.5 MiB |
| kv-edge | 90 | 26.16x | 2484 | 1075 | 9653 | 247 | 1.5 MiB |
| tiered mem+redis-az | 90 | 27.24x | 2493 | 1135 | 54.12 | 303 | 0.4 MiB |
| tiered mem+kv-edge | 90 | 28.00x | 2493 | 1135 | 458 | 303 | 0.4 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> A cached function has no response header to report a status through, so read `origin calls/req` instead. SWR shows up as a p50 that stays at storage latency while origin calls continue in the background.
>
> Stale serves answer in microseconds, so p50 and p90 should collapse while p99 stays bounded by the origin: a key's first touch has no stale entry and blocks. The tiered run should recover most of a slow backend's read cost while paying write amplification on misses.

### Break-even

Measured hit-path cost, sequential, memory storage, no competing load:

| payload | handler direct | handler cached | ocache adds | function direct | function cached | ocache adds |
|--:|--:|--:|--:|--:|--:|--:|
| 4 KiB | 36.9 us | 56.6 us | **+19.8 us** | 0.1 us | 4.7 us | **+4.6 us** |
| 6 KiB | 36.6 us | 58.1 us | **+21.5 us** | 0.1 us | 4.4 us | **+4.2 us** |
| 8 KiB | 54.7 us | 64.8 us | **+10.1 us** | 0.1 us | 4.0 us | **+3.9 us** |
| 15 KiB | 53.6 us | 82.0 us | **+28.5 us** | 0.0 us | 4.2 us | **+4.2 us** |
| 20 KiB | 57.0 us | 80.3 us | **+23.3 us** | 0.1 us | 6.3 us | **+6.3 us** |
| 40 KiB | 89.6 us | 114.8 us | **+25.2 us** | 0.1 us | 4.1 us | **+4.1 us** |
| 64 KiB | 123.4 us | 146.0 us | **+22.7 us** | 0.1 us | 4.0 us | **+3.9 us** |

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
