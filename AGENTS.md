# ocache

ocache provides composable cache primitives. It works in any runtime that provides standard `Request` and `Response` objects.

[KEEP COMMENTS SHORT AND ONLY IF NOT OBVIOUS FROM CODE]

## Project Structure

```
src/
├── index.ts        # Public exports (re-exports from all modules)
├── types.ts        # All type definitions (HTTPEvent, CacheEntry, CacheOptions, etc.)
├── cache.ts        # Core: defineCachedFunction, cachedFunction, invalidateCache, resolveCacheKeys
├── http/           # HTTP layer: defineCachedHandler (depends on cache.ts)
│   ├── index.ts         # defineCachedHandler: the wiring onto cachedFunction + the serve path
│   ├── config.ts        # Caller options -> the per-handler `HandlerConfig` every module reads
│   ├── request.ts       # What bypasses the cache + narrowing what the handler may see
│   ├── key.ts           # Cache key: resource identity + method component
│   ├── filters.ts       # Cookie/query allowlist filters, shared by request.ts and key.ts
│   ├── entry.ts         # Storage codec both ways: Response <-> ResponseCacheEntry
│   ├── validate.ts      # The `validate` hook: status allowlist + response-side opt-outs
│   ├── cache-control.ts # RFC 9111 directive parser (no policy, just syntax)
│   ├── vary.ts          # Vary merging and the two response-`Vary` predicates
│   └── conditional.ts   # 304 decisions and the headers a 304 must echo
├── hash.ts         # `hash`/`serialize`: cache keys + integrity, digest via `#crypto`
├── base64.ts       # Binary-body codec: one implementation picked per runtime
└── storage.ts      # Storage interface, built-in memory storage, `createBlobStorage` frame codec

lib/                # Shipped as-is (not built): the two arms of the `#crypto` import
├── digest.node.mjs # `node` condition -> node:crypto
└── digest.mjs      # default condition -> portable sha256

bench/              # Two layers: what a hit costs, and what a hit buys
├── micro.ts        # mitata: per-call cost of the hit path, instant origin + Map storage
├── index.ts        # CLI + load runner over the scenarios
├── harness/        # clock, origin, storage profiles, driver, metrics, report, calibrate
└── scenarios/      # 5 handler + 2 function workloads
```

Each mechanism belongs in the module whose name describes it. `http/index.ts` contains only the connection to `cachedFunction`, the `CacheOptions` hooks, the resolver, the serve path, and the revalidation helpers. The `http/` dependency graph is a DAG. `cache-control.ts`, `vary.ts`, `conditional.ts`, and `config.ts` do not import from the directory.

## Deep dives (`.agents/`)

The `.agents/` layout matches `src/`. Before you edit an area, read the file that covers it. These files record measured symptoms, rejected alternatives, and reasons for the current design. Code comments only refer to these details.

| File                       | Covers                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `.agents/cache.md`         | `cache.ts`: `name`, option merging, lifetimes/storage TTL, dedup + deadline, hooks, purge, `waitUntil` |
| `.agents/http/key.md`      | `http/key.ts`: key shape (name, method, authority) + the revalidation helpers                          |
| `.agents/http/request.md`  | `http/request.ts` (+ `config.ts`, `filters.ts`): bypass, narrowing, cookies/credentials                |
| `.agents/http/response.md` | `http/entry.ts`, `validate.ts`, `vary.ts`, `cache-control.ts`, `conditional.ts`, `base64.ts`           |
| `.agents/storage.md`       | `storage.ts`: memory-backend ceilings, byte accounting, `resolveStorage`, the blob frame               |
| `.agents/hash.md`          | `hash.ts`: the digest backend lookup, what `serialize` renders and why it must stay stable             |

## Cross-module invariants

Most findings in the deep dives came from violations of these rules.

- **A handler may read exactly what the key covers.** `keyHeaderNames` controls both request narrowing in `request.ts` and key composition in `key.ts`. Both sides derive their allowlist subsets from the same pure helpers in `filters.ts`. Neither side may compute separate subsets. Narrowing uses an allowlist and removes undeclared headers. There are **no exemptions**: `host` is rewritten to the keyed authority, and every other undeclared header is removed. A handler must never read a header no key covers, including conditional and trace headers. `handleCacheHeaders` receives the request validators through `CacheConditions`, captured before narrowing.
- **The storage decision and the advertisement must use the same predicates.** `validate.ts` uses `isCacheableStatus`, `hasVaryWildcard`, and `hasUnkeyedVary` to decide whether it may store a response. `entry.ts` uses the same predicates to decide whether it may advertise a lifetime. Never copy these checks into a call site.
- **One declaration bounds both buffering and storage.** `StorageInterface.maxEntryBytes` is the backend's per-entry ceiling and the only source of the derived `maxBodySize` default in `http/entry.ts`. Never restate that number as a constant. A body larger than the derived limit is refused **while the stream is read**, because `set` can only refuse an entry the process has already built.
- **`StorageInterface.binary` decides the stored binary form and the charge factor together.** A backend declares whether it returns byte views intact; `http/entry.ts` reads that one flag to choose between a `Uint8Array` body and base64, and to divide `maxEntryBytes` by `2` rather than `8/3`. `cache.ts` reads the same flag for a cached function whose **value** is bytes, and records the form it wrote in `CacheEntry.encoding`. Never infer the capability from a value, and never let these decisions consult different sources. The read path is the exception in the other direction: `deserializeEntry` and `decodeBinary` accept both stored forms whatever the flag currently says, because entries outlive a change to it, and `validateEntry` and `decodeBinary` reject anything that is neither, on read as well as on write.
- **A storage codec reads `CacheEntry.payload`; it never looks for bytes in a value.** The producer of the stored shape declares where the bulk payload sits — `cache.ts` derives `"value"` for a byte value, `http/index.ts` declares `"value.body"` for a response body. `createBlobStorage` moves exactly that member into its frame and leaves everything else as JSON. This is `StorageInterface.binary` one step further out: the side that knows states it, and nothing infers a payload from a value's shape. Like `encoding`, the marker describes storage only — it is stamped on every write and cleared on every read, so no hook or caller sees it.
- **Never write an entry that has neither an expiry nor a storage TTL.** `storageTtl` is the only decision point. `remainingTtl` in `expireCache` derives from it.
- **Storage must be per instance, never global.** Persistent backends also require deterministic keys across process restarts.
- `cache.ts` and `storage.ts` export the shared internal functions `resolveName`, `definedOptions`, and `resolveStorage`. The function and handler paths must use these functions so they cannot differ. Both paths must resolve `name` **before** they merge defaults.
- Pass every single segment of a `:`-joined key through `escapeKeySegment`. In `buildCacheKey` these are `group` and `name`. `base` keeps its raw `:` because that separates prefix tiers, and `key` is the terminal namespace whose producer escapes its own segments (`http/key.ts` escapes a custom key because the method component precedes it).

## Docs

- Never edit content inside `<!-- automd -->` in README.md. `pnpm fmt` generates this content.
- User guides are in `docs/`. If a behavior change changes a documented string or default, update the relevant guide. `8.cache-control.md` and `9.isr.md` are closest to these internals.
- **`docs/11.benchmarks.md` is generated. Never edit it.** Edit the prose in `bench/docs.md` and run `pnpm bench:docs`. Every number on that page is substituted from a results JSON, so hand-editing it makes the page disagree with the run it claims to report.

## Dev Commands

- `pnpm vitest run test/` — run tests
- `pnpm typecheck` — `tsc --noEmit --skipLibCheck`
- `pnpm lint` — `oxlint` + `oxfmt --check`
- `pnpm build` — build with obuild
- `pnpm bench` — load scenarios, baseline vs cached, storage sweep. See `bench/README.md`
- `pnpm bench:micro` — per-call cost of the hit path
- `pnpm bench:chart` — results JSON -> SVG charts, plus the site's `docs/.docs/public/bench.svg`
- `pnpm bench:docs` — results JSON -> `docs/11.benchmarks.md`, charts inlined

## Benchmarks

`bench/README.md` documents the method; `bench/findings.md` records what it has shown so
far. Three stages: `bench/index.ts` produces results JSON, `bench/chart.ts` renders it to
SVG, `bench/docs.ts` fills `bench/docs.md` and writes the docs page.

`bench/chart.ts` also writes the landing summary the docs site links,
`docs/.docs/public/bench.svg` (the `combined` chart; `--no-landing` skips it). It is
generated: re-run the stage instead of editing it, and keep the path stable because the
site links it.

Two rules matter when changing anything there: the driver is open-loop and measures latency
from the intended arrival time, and every configuration runs from the same seed so a
baseline row and a cached row differ only in whether ocache is in the path. A change that
makes the numbers better by weakening either one is not a result.

Micro-measurements here must be paired and GC-controlled. Single-pass timing has produced
results that were wrong in direction, not merely noisy — see the method section of
`bench/findings.md` before trusting or adding a number.

## Design Decisions

- Do not add h3, srvx, or unstorage as a dependency. ocache is standalone and has **zero runtime dependencies**. Cache keys and integrity values use `src/hash.ts`. This module computes sha256/base64url over deterministic `serialize` output and replaces `ohash`. The `#crypto` conditional import provides the digest. The `node` condition selects `node:crypto`. The default condition selects portable sha256 from `lib/digest.mjs`. This lets each consumer bundle only the required implementation. Both implementations must produce byte-identical keys. `hash` is synchronous, so neither implementation uses WebCrypto. See `.agents/hash.md`.
- `src/base64.ts` holds all three binary-body codecs and picks one **at module load**: `globalThis.Buffer` where the runtime has it (Node, Bun), then the TC39 `Uint8Array` base64 methods (Deno, current browsers and workers), then a `btoa` loop. Unlike `#crypto` this is a runtime check, not a package condition: every arm is a few lines, so shipping all three costs ~0.5 kB minified, and `Buffer` is read off `globalThis` because bundlers inject a Buffer polyfill when they see the bare identifier. All three must produce identical bytes — a Node process and a worker share a persistent backend — and `test/base64.test.ts` holds them against each other. `http/entry.ts` skips base64 entirely for a backend that declares `binary`, `cache.ts` does the same for a binary function value, and `hash.ts` renders bytes with it. See `.agents/http/response.md`.
- `base` supports `string | string[]`. For multiple tiers, reads stop at the first hit. Misses write every prefix. Revalidation writes the hit tier and every earlier tier.
- The default cache key group is `"functions"` in cache.ts and `"handlers"` in http/index.ts. Do not add an `ocache/` prefix.
- Both `integrityOpts` implementations in cache.ts and http/config.ts exclude the storage-location fields `base`, `group`, `name`, and `storage`, plus the host-plumbing field `waitUntil`. This keeps entries valid after a backend, prefix, or runtime change. The JSDoc in `cache.ts` explains why hashing `storage` has no meaning and costs too much.
- `CachedEventHandlerOptions` provides these framework hooks: `toResponse(value, event)`, `createResponse(body, init)`, and `handleCacheHeaders(event, conditions)`. Each hook replaces the related built-in `Response` or 304 behavior.
