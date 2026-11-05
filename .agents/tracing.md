# `tracing.ts` — diagnostics channel

One `TracingChannel`, `ocache.get`, named like `unstorage.<op>`, `db0.query`, and `h3.request`. Opt-in through the `tracing` option. User guide: `docs/docs/13.tracing.md`.

## Zero cost when unobserved

- `traceGet` returns `call()` itself unless something subscribes, and builds the context through a factory only then. An unobserved traced call keeps the exact microtask timing of an untraced one, which the SWR paths depend on (see `.agents/cache.md`, `maxResolveTime`). The full suite passes with `tracing` forced on and a subscriber attached.
- The builtin is read through `globalThis.process?.getBuiltinModule`, in a `try`, once. A runtime without it, or one that throws for an unknown builtin, disables tracing. Never import `node:diagnostics_channel`: the neutral bundle must not name a node builtin.
- Bun has no aggregate `TracingChannel#hasSubscribers`, so the check falls back to the sub-channels, as `db0` does.
- The context interface is a local shape, so the published declarations need no `@types/node`.

## Context

- `name`, `group`, and `event` exist at `start`; `key` after `getKey`; `status` as soon as the read decides it, before the resolution runs, so a failed miss still reports `"miss"`.
- Arguments are not published: they routinely carry user data.
- `tracing` is excluded from integrity in both `integrityOpts`, so enabling it keeps existing entries warm.
- A handler is traced through its inner cached function, so requests it bypasses before reaching the cache publish nothing.
