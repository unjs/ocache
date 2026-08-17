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
└── storage.ts      # Storage interface + built-in memory storage

lib/                # Shipped as-is (not built): the two arms of the `#crypto` import
├── digest.node.mjs # `node` condition -> node:crypto
└── digest.mjs      # default condition -> portable sha256
```

Each mechanism belongs in the module whose name describes it. `http/index.ts` contains only the connection to `cachedFunction`, the `CacheOptions` hooks, the resolver, the serve path, and the revalidation helpers. The `http/` dependency graph is a DAG. `cache-control.ts`, `vary.ts`, `conditional.ts`, and `config.ts` do not import from the directory.

## Deep dives (`.agents/`)

The `.agents/` layout matches `src/`. Before you edit an area, read the file that covers it. These files record measured symptoms, rejected alternatives, and reasons for the current design. Code comments only refer to these details.

| File                       | Covers                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `.agents/cache.md`         | `cache.ts`: `name`, option merging, lifetimes/storage TTL, dedup + deadline, hooks, purge, `waitUntil` |
| `.agents/http/key.md`      | `http/key.ts`: key shape (name, method, authority) + the revalidation helpers                          |
| `.agents/http/request.md`  | `http/request.ts` (+ `config.ts`, `filters.ts`): bypass, narrowing, cookies/credentials                |
| `.agents/http/response.md` | `http/entry.ts`, `validate.ts`, `vary.ts`, `cache-control.ts`, `conditional.ts`                        |
| `.agents/storage.md`       | `storage.ts`: memory-backend ceilings, byte accounting, `resolveStorage`                               |
| `.agents/hash.md`          | `hash.ts`: the digest backend lookup, what `serialize` renders and why it must stay stable             |

## Cross-module invariants

Most findings in the deep dives came from violations of these rules.

- **A handler may read exactly what the key covers.** `keyHeaderNames` controls both request narrowing in `request.ts` and key composition in `key.ts`. Both sides derive their allowlist subsets from the same pure helpers in `filters.ts`. Neither side may compute separate subsets. Narrowing uses an allowlist and removes undeclared headers. Only `safeHeaderNames` in `filters.ts` are exempt. Add a safe header only if no key could ever need to cover it.
- **The storage decision and the advertisement must use the same predicates.** `validate.ts` uses `isCacheableStatus`, `hasVaryWildcard`, and `hasUnkeyedVary` to decide whether it may store a response. `entry.ts` uses the same predicates to decide whether it may advertise a lifetime. Never copy these checks into a call site.
- **Never write an entry that has neither an expiry nor a storage TTL.** `storageTtl` is the only decision point. `remainingTtl` in `expireCache` derives from it.
- **Storage must be per instance, never global.** Persistent backends also require deterministic keys across process restarts.
- `cache.ts` and `storage.ts` export the shared internal functions `resolveName`, `definedOptions`, and `resolveStorage`. The function and handler paths must use these functions so they cannot differ. Both paths must resolve `name` **before** they merge defaults.
- Pass every segment of a `:`-joined key through `escapeKeySegment`.

## Docs

- Never edit content inside `<!-- automd -->` in README.md. `pnpm fmt` generates this content.
- User guides are in `docs/1.guide/`. If a behavior change changes a documented string or default, update the relevant guide. `8.cache-control.md` and `9.isr.md` are closest to these internals.

## Dev Commands

- `pnpm vitest run test/` — run tests
- `pnpm typecheck` — `tsc --noEmit --skipLibCheck`
- `pnpm lint` — `oxlint` + `oxfmt --check`
- `pnpm build` — build with obuild

## Design Decisions

- Do not add h3, srvx, or unstorage as a dependency. ocache is standalone and has **zero runtime dependencies**. Cache keys and integrity values use `src/hash.ts`. This module computes sha256/base64url over deterministic `serialize` output and replaces `ohash`. The `#crypto` conditional import provides the digest. The `node` condition selects `node:crypto`. The default condition selects portable sha256 from `lib/digest.mjs`. This lets each consumer bundle only the required implementation. Both implementations must produce byte-identical keys. `hash` is synchronous, so neither implementation uses WebCrypto. See `.agents/hash.md`.
- `base` supports `string | string[]`. For multiple tiers, reads stop at the first hit. Misses write every prefix. Revalidation writes the hit tier and every earlier tier.
- The default cache key group is `"functions"` in cache.ts and `"handlers"` in http/index.ts. Do not add an `ocache/` prefix.
- Both `integrityOpts` implementations in cache.ts and http/config.ts exclude the storage-location fields `base`, `group`, `name`, and `storage`. This keeps entries valid after a backend or prefix change. The JSDoc in `cache.ts` explains why hashing `storage` has no meaning and costs too much.
- `CachedEventHandlerOptions` provides these framework hooks: `toResponse(value, event)`, `createResponse(body, init)`, and `handleCacheHeaders(event, conditions)`. Each hook replaces the related built-in `Response` or 304 behavior.
