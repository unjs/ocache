# ocache benchmark

Node v24.19.0 · seed 1 · load `steady` · 587s

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
| **no cache** | 60 | 59 | 0 | 49.97 | 90.04 | 120 | 148 | 1.000 | 0/0/0/0 | 13.432 | 36.86 |
| memory | 60 | 59 | 0 | 0.17 | 4.19 | 42.27 | 63.27 | 0.065 | 547/0/38/0 | 2.531 | 1.92 |
| redis-az | 60 | 59 | 0 | 1.20 | 5.95 | 43.16 | 65.02 | 0.065 | 547/0/38/0 | 3.490 | 1.96 |
| redis-az-bytes | 60 | 59 | 0 | 1.19 | 5.93 | 43.21 | 65.35 | 0.065 | 547/0/38/0 | 3.474 | 1.96 |
| kv-edge | 60 | 59 | 0 | 8.22 | 26.46 | 59.58 | 84.00 | 0.065 | 547/0/38/0 | 3.901 | 1.99 |

| config | offered | p99 vs no cache | raw origin call difference | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|--:|
| memory | 60 | 2.84x | 547 | 585 | 0.00 | 38 | 0.0 MiB |
| redis-az | 60 | 2.78x | 547 | 585 | 668 | 38 | 1.5 MiB |
| redis-az-bytes | 60 | 2.78x | 547 | 585 | 665 | 38 | 1.5 MiB |
| kv-edge | 60 | 2.02x | 547 | 585 | 5491 | 38 | 1.5 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> Latency drops to the storage round trip on hits; capacity rises because the 12 ms render is skipped. Hit ratio is set by the Zipf tail, not by the cache. The `redis-az-bytes` row is the text half of the codec pairing: the body leaves the JSON but never was base64, so only the escaping is saved.

### JSON list API `api-list`

8 KiB JSON, 3k query combinations, 40% of requests carry tracking params.

Origin: 25 ms I/O + 2 ms CPU, concurrency 20. 3000 keys, ~8 KiB payload.

| config | offered | achieved | rejected | p50 | p90 | p99 | p99.9 | origin calls/req | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 300 | 295 | 0 | 31.10 | 53.74 | 84.42 | 112 | 1.000 | 0/0/0/0 | 2.879 | 6.44 |
| memory | 300 | 295 | 0 | 0.10 | 0.77 | 42.66 | 75.16 | 0.070 | 2746/0/206/0 | 1.450 | 2.73 |
| redis-az | 300 | 295 | 0 | 0.86 | 2.98 | 43.44 | 75.47 | 0.070 | 2746/0/206/0 | 1.883 | 2.82 |
| kv-edge | 300 | 295 | 0 | 6.98 | 23.99 | 57.44 | 84.75 | 0.070 | 2746/0/206/0 | 2.162 | 2.71 |

| config | offered | p99 vs no cache | raw origin call difference | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|--:|
| memory | 300 | 1.98x | 2746 | 2952 | 0.00 | 206 | 0.0 MiB |
| redis-az | 300 | 1.94x | 2746 | 2952 | 2565 | 206 | 1.7 MiB |
| kv-edge | 300 | 1.47x | 2746 | 2952 | 25561 | 206 | 1.7 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> A shallow head means a middling hit ratio, so per-request cache overhead is visible. `allowQuery` collapses the tracking-parameter variants that would otherwise dominate the keyspace.

### Personalized dashboard `personalized-dashboard`

15 KiB per-user page, 2k returning users plus 15% first-time sessions, tier cookie keyed.

Origin: 45 ms I/O + 3 ms CPU, concurrency 20. 2000 keys, ~15 KiB payload.

| config | offered | achieved | rejected | p50 | p90 | p99 | p99.9 | origin calls/req | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 220 | 214 | 0 | 55.65 | 95.52 | 150 | 186 | 1.000 | 0/0/0/0 | 3.917 | 12.55 |
| memory | 220 | 214 | 0 | 0.13 | 44.85 | 99.25 | 133 | 0.183 | 1750/0/391/0 | 1.957 | 4.11 |
| redis-az | 220 | 214 | 0 | 1.22 | 45.86 | 100 | 134 | 0.183 | 1750/0/391/0 | 2.502 | 4.16 |

| config | offered | p99 vs no cache | raw origin call difference | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|--:|
| memory | 220 | 1.51x | 1750 | 2141 | 0.00 | 391 | 0.0 MiB |
| redis-az | 220 | 1.50x | 1750 | 2141 | 2162 | 391 | 5.9 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> Session churn caps the hit ratio no matter how long the cache runs. Watch what the misses cost: a slow storage profile pays for a read it does not get to use.

### OG image render `og-image`

64 KiB PNG, 180 ms blocking render, 300 slugs, 30% conditional requests.

Origin: 5 ms I/O + 180 ms CPU, concurrency 4. 300 keys, ~64 KiB payload.

| config | offered | achieved | rejected | p50 | p90 | p99 | p99.9 | origin calls/req | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 4 | 4 | 0 | 370 | 953 | 1229 | 1350 | 1.000 | 0/0/0/0 | 182.089 | 180 |
| memory | 4 | 4 | 0 | 0.22 | 0.27 | 184 | 184 | 0.020 | 66/0/2/34 | 8.058 | 1.20 |
| redis-az | 4 | 4 | 0 | 1.56 | 2.35 | 185 | 185 | 0.020 | 66/0/2/34 | 8.989 | 1.14 |
| redis-az-bytes | 4 | 4 | 0 | 1.33 | 2.14 | 185 | 185 | 0.020 | 66/0/2/34 | 8.797 | 1.18 |

| config | offered | p99 vs no cache | raw origin call difference | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|--:|
| memory | 4 | 6.68x | 100 | 102 | 0.00 | 2 | 0.0 MiB |
| redis-az | 4 | 6.65x | 100 | 102 | 141 | 2 | 0.2 MiB |
| redis-az-bytes | 4 | 6.66x | 100 | 102 | 125 | 2 | 0.1 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> The largest capacity win in the set: blocking render CPU disappears on a hit. Watch the share of requests answered with 304, and the two `redis-az` rows: same wire, one storing the body as base64 inside JSON and one storing it as bytes through `createBlobStorage`.

### Rate-limited upstream proxy `upstream-proxy`

4 KiB JSON, 300 ms upstream capped at 10 concurrent calls, 20 keys.

Origin: 300 ms I/O + 1 ms CPU, concurrency 10. 20 keys, ~4 KiB payload.

| config | offered | achieved | rejected | p50 | p90 | p99 | p99.9 | origin calls/req | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 25 | 25 | 0 | 323 | 558 | 865 | 1080 | 1.000 | 0/0/0/0 | 4.464 | 2.06 |
| memory | 25 | 25 | 0 | 0.19 | 0.25 | 0.33 | 0.52 | 0.066 | 276/27/0/0 | 2.153 | 1.72 |
| redis-az | 25 | 25 | 0 | 0.81 | 1.58 | 2.79 | 3.18 | 0.066 | 276/27/0/0 | 2.900 | 1.71 |
| object-store | 25 | 25 | 0 | 29.52 | 60.50 | 102 | 118 | 0.073 | 275/28/0/0 | 3.637 | 1.89 |

| config | offered | p99 vs no cache | raw origin call difference | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|--:|
| memory | 25 | 2589.70x | 283 | 303 | 0.00 | 20 | 0.0 MiB |
| redis-az | 25 | 310.43x | 283 | 303 | 226 | 20 | 0.1 MiB |
| object-store | 25 | 8.46x | 281 | 303 | 10248 | 22 | 0.1 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> Baseline capacity is fixed at roughly 33 rps by the cap. Cached should hold the offered rate with about 20 origin calls per maxAge window; the burst profile shows dedup collapsing a cold stampede.

### Markdown render (function) `markdown-render`

25 ms blocking render to 20 KiB HTML, 3k documents.

Origin: 0 ms I/O + 25 ms CPU, concurrency unbounded. 3000 keys, ~20 KiB payload.

| config | offered | achieved | rejected | p50 | p90 | p99 | p99.9 | origin calls/req | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 30 | 30 | 0 | 100 | 315 | 596 | 626 | 1.000 | - | 25.789 | 75.69 |
| memory | 30 | 30 | 0 | 0.07 | 3.74 | 25.16 | 25.18 | 0.073 | - | 3.618 | 1.82 |
| redis-local | 30 | 30 | 0 | 0.25 | 4.31 | 25.49 | 25.63 | 0.073 | - | 3.802 | 1.79 |
| redis-az | 30 | 30 | 0 | 0.87 | 6.09 | 26.30 | 26.48 | 0.073 | - | 4.423 | 1.83 |
| redis-az-bytes | 30 | 30 | 0 | 0.90 | 6.18 | 26.34 | 26.49 | 0.073 | - | 4.478 | 1.83 |
| sql | 30 | 30 | 0 | 2.56 | 13.69 | 29.05 | 30.00 | 0.073 | - | 4.986 | 1.90 |
| object-store | 30 | 30 | 0 | 32.61 | 61.57 | 113 | 120 | 0.073 | - | 5.002 | 1.95 |

| config | offered | p99 vs no cache | raw origin call difference | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|--:|
| memory | 30 | 23.69x | 330 | 356 | 0.00 | 26 | 0.0 MiB |
| redis-local | 30 | 23.38x | 330 | 356 | 63.00 | 26 | 0.5 MiB |
| redis-az | 30 | 22.66x | 330 | 356 | 327 | 26 | 0.5 MiB |
| redis-az-bytes | 30 | 22.63x | 330 | 356 | 328 | 26 | 0.5 MiB |
| sql | 30 | 20.52x | 330 | 356 | 1066 | 26 | 0.5 MiB |
| object-store | 30 | 5.26x | 330 | 356 | 12179 | 26 | 0.5 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> A cached function has no response header to report a status through, so read `origin calls/req` instead. SWR shows up as a p50 that stays at storage latency while origin calls continue in the background.
>
> Baseline throughput is pinned at 1000/25 = 40 rps. Cached capacity should scale with hit ratio until storage latency becomes the new floor. `redis-az-bytes` is here as the counter-example: this value is a string, not bytes and not a response body, so it declares no payload and the frame has nothing to lift — it should cost more than plain `redis-az`, not less.

### Fan-out aggregation (function) `fanout-aggregate`

3 parallel upstreams, 220 ms slowest, 500 keys, SWR with a long stale window.

Origin: 220 ms I/O + 1 ms CPU, concurrency 90. 500 keys, ~6 KiB payload.

| config | offered | achieved | rejected | p50 | p90 | p99 | p99.9 | origin calls/req | hit/stale/miss/304 | cpu/req | loop p99 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|
| **no cache** | 90 | 90 | 0 | 322 | 540 | 786 | 1020 | 3.000 | - | 6.537 | 2.02 |
| memory | 90 | 90 | 0 | 0.05 | 0.28 | 450 | 593 | 0.681 | - | 2.903 | 1.97 |
| redis-az | 90 | 90 | 0 | 0.77 | 2.16 | 452 | 593 | 0.681 | - | 3.605 | 1.98 |
| kv-edge | 90 | 90 | 0 | 6.75 | 21.47 | 461 | 647 | 0.698 | - | 4.239 | 2.01 |
| tiered mem+redis-az | 90 | 90 | 0 | 0.05 | 0.30 | 452 | 594 | 0.681 | - | 2.987 | 1.97 |
| tiered mem+kv-edge | 90 | 90 | 0 | 0.05 | 0.49 | 461 | 676 | 0.684 | - | 3.015 | 1.97 |

| config | offered | p99 vs no cache | raw origin call difference | storage reads | blocked on reads | storage writes | bytes written |
|---|--:|--:|--:|--:|--:|--:|--:|
| memory | 90 | 1.75x | 2493 | 1075 | 0.00 | 244 | 0.0 MiB |
| redis-az | 90 | 1.74x | 2493 | 1075 | 879 | 244 | 1.5 MiB |
| kv-edge | 90 | 1.70x | 2475 | 1075 | 8867 | 250 | 1.5 MiB |
| tiered mem+redis-az | 90 | 1.74x | 2493 | 1135 | 44.31 | 303 | 0.4 MiB |
| tiered mem+kv-edge | 90 | 1.71x | 2490 | 1135 | 445 | 304 | 0.4 MiB |

> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.
>
> A cached function has no response header to report a status through, so read `origin calls/req` instead. SWR shows up as a p50 that stays at storage latency while origin calls continue in the background.
>
> Stale serves answer in microseconds, so p50 and p90 should collapse while p99 stays bounded by the origin: a key's first touch has no stale entry and blocks. The tiered run should recover most of a slow backend's read cost while paying write amplification on misses.

### Break-even

Measured hit-path cost, sequential, memory storage, no competing load:

| payload | handler direct | handler cached | ocache adds | function direct | function cached | ocache adds |
|--:|--:|--:|--:|--:|--:|--:|
| 4 KiB | 35.8 us | 55.2 us | **+19.5 us** | 0.1 us | 4.4 us | **+4.3 us** |
| 6 KiB | 37.9 us | 58.9 us | **+21.0 us** | 0.1 us | 4.6 us | **+4.5 us** |
| 8 KiB | 51.0 us | 58.8 us | **+7.8 us** | 0.1 us | 4.3 us | **+4.3 us** |
| 15 KiB | 52.4 us | 81.0 us | **+28.6 us** | 0.1 us | 4.2 us | **+4.1 us** |
| 20 KiB | 56.6 us | 81.7 us | **+25.1 us** | 0.1 us | 4.5 us | **+4.5 us** |
| 40 KiB | 92.3 us | 114.2 us | **+21.9 us** | 0.1 us | 4.3 us | **+4.2 us** |
| 64 KiB | 119.7 us | 149.5 us | **+29.8 us** | 0.1 us | 4.3 us | **+4.2 us** |

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
