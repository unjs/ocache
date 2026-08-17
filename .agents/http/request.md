# `http/request.ts` — bypass and request narrowing

The directory has one rule: **a handler may read exactly what the key covers**. `keyHeaderNames` controls narrowing in `config.ts`. `filters.ts` computes the allowlisted subsets used by this module and `key.ts`. The two modules must not derive separate subsets.

## Bypass

Non-GET/HEAD requests and every request with a `Range` header **bypass the cache**. This is the built-in part of `resolveBypass`. Compose it with, and never replace it with, the caller's `shouldBypassCache` (issue #50). Bypassed requests reach the handler without changes, including their bodies. A rewritten `Request` would otherwise omit the body.

Base narrowing on the **combined** decision, not only the built-in decision (finding 09). Earlier code considered a GET cacheable before the caller's `shouldBypassCache` excluded it. It removed credentials from the requests that the caller had explicitly exempted. Bypass is the escape path documented by the credential defaults. The defect caused anonymous or 401 output on every authenticated request. `narrowRequest` checks the decision itself instead of relying on its caller.

Compute the decision **exactly once per call**. The caller's hook can be asynchronous, expensive, or have side effects. `resolveBypass` stores the result on the event in `config.bypassed`, a per-handler `WeakMap` that follows the `searchCache` pattern. `cache.ts` awaits this result before it skips to the raw resolver. Keep per-call state keyed by event, not in a module-level slot, which would mix requests. Pass it through `config` because `cache.ts` invokes `fn(...args)` with only the caller's arguments.

**`Range` specifically** (finding 07) is the request-side part of the 206 fix. The status allowlist also excludes 206. `Range` was forwarded but was absent from the key and `Vary`. A range-aware handler such as a static-file, media, or `serveStatic` handler could store a partial representation under the range-free key. One `curl -r 0-0` request stored a one-byte body with `Content-Range`. Every later GET without `Range` received that truncated body for the full TTL. Synthesized `s-maxage` also sent it to shared CDNs. RFC 9110 §15.3.7 and RFC 9111 §3.3 state that a 206 answers only the request that specified the range. Combining partial responses is out of scope. Request bypass is the cheaper protection because no partial response is stored and `serialize` does not buffer a large partial body. This is a breaking change. A ranged request now also skips narrowing, as all bypassed requests do. It receives no `x-cache`, `etag`, or `cache-control` synthesis.

Return bypassed responses without changes. `serialize` runs outside the resolver, so a bypassed call returns the handler's live `Response`. The outer wrapper detects `value instanceof Response` and returns it directly. Do not buffer its body. Streaming and binary bodies must survive. Do not synthesize cache headers or a false `304` for a non-cacheable method. This differs from the old path, which always serialized.

## What the handler sees

The header filter is an **allowlist**. A header reaches the handler only when it appears in `keyHeaderNames`, is `cookie` under the three-way rule below, or appears in `safeHeaderNames`. Remove every other header on cacheable calls. `host` is the one rewritten name: narrowing replaces its value with the keyed URL authority.

Forward `varies` headers. Their values are part of the key, so the handler can safely read them. Reading them is the reason to declare them. Earlier code removed declared `varies` headers instead of forwarding them. For example, `varies: ["accept-language"]` produced separate keys and correct `Vary`, but every entry contained the default rendering. Correct forwarding was therefore a breaking behavior change.

Earlier code also forwarded every undeclared header. It removed only `authorization`, `proxy-authorization`, and `cookie`, which treated three examples as the full problem. Any other header read by the handler could affect output without affecting the key. For example, a MISS with `x-api-key: alice` stored Alice's tenant page under a shared key. It advertised synthesized `max-age=N` without `Vary` and replayed the page to later callers. This is the same credential defect under a different header name. `x-forwarded-host` causes the h3#1524 cross-tenant collision through another path when the key contains the same internal proxy authority for every tenant. Other examples are `origin` copied into CORS output, `accept` or `accept-language` used for negotiation, and `x-forwarded-proto` used for absolute links.

This change is broad and breaking. A handler that reads an undeclared header now receives `null` and produces the default variant. Declare the header in `varies` to key, expose, and advertise it. Alternatively, exclude those requests with `shouldBypassCache`. The default now fails closed by sharing one default rendering instead of sharing one caller's rendering. This matches the existing credential policy.

This rule is the request-side counterpart to `hasUnkeyedVary` in `.agents/http/response.md`. The response side refuses to store output that varies on an unkeyed header. The request side refuses to expose that header to the handler. A route that is wrong in both directions triggers both protections.

### `safeHeaderNames`

`filters.ts` defines these exemptions beside the cookie and query filters. No module may create its own list. Each exempt header cannot vary a rendering and cannot usefully be placed in `varies`:

- **`if-none-match` / `if-modified-since`** remain visible because `defaultHandleCacheHeaders` reads them from `event.req` in `http/index.ts` after narrowing replaces that request. If narrowing removed them, 304 responses worked on a HIT but never on a MISS. They are safe to forward. The only conditional responses that a handler can derive from them are 304 and 412, and those statuses are not in `cacheableStatuses`. The cache never stores such output.
- **`traceparent`, `tracestate`, `x-request-id`, `x-correlation-id`** support logging and trace propagation. They are unique per request by design. Adding one to `varies` would create one entry per request, so no useful keyed configuration exists. A handler that renders one into output creates data that no cache key can cover.

### `host`

`host` is **not** in `safeHeaderNames`. Narrowing removes the raw header and sets `host` to `(event.url ?? new URL(event.req.url)).host` — the host component of the very authority `resolveKey` hashes. A handler that renders a canonical link, an absolute asset URL, or a `Location` from `host` therefore renders from keyed data by construction.

The old exemption assumed the two always agree. They agree only on adapters that build the URL _from_ `Host`. An adapter that resolves `event.url` from the connection, from a fixed base, or from a trusted proxy header leaves `Host` attacker-controlled and unkeyed. `Host: a.example` and `Host: b.example` on one resolved authority then shared an entry, and the first tenant's rendering was replayed under a synthesized `max-age` with no `Vary`. This is the same defect that `x-forwarded-host` has, reached through the one header the allowlist still exempted.

Normalizing, rather than removing, keeps host-dependent rendering working on the adapters where it was already correct. An authority-less URL (`file:`, `data:`) has no host to give, so the handler sees none. `varies: ["host"]` still puts `host` in `keyHeaderNames`; the raw header is then keyed, so narrowing forwards it unchanged and skips normalization.

Do **not** exempt `user-agent` or `baggage`. Device and bot branching commonly use `user-agent`. OTel `baggage` is designed for application values such as tenant IDs and feature flags. This differs from the opaque `traceparent` and `tracestate` pair. Declare both headers in `varies` when they affect output.

### Cookies (request side)

By default, cookies do not affect caching. Remove the `Cookie` header before the handler runs and do not vary the key by it. Two options affect only this request-side rule. The response-side rule cannot be changed. See `.agents/http/response.md`.

- `varies: ["cookie"]` is the **coarse** option. It is symmetric with `varies: ["authorization"]`, which is equivalent to `allowAuthorization: true`. `cookie` remains in `keyHeaderNames`, so the raw header affects the key and reaches the handler without changes. This is correct by construction. The caller accepts one entry for each distinct raw `Cookie` value, which is effectively one entry per visitor. Earlier code hashed the raw header but removed it before the handler. The handler then wrote the cookie-free default into every cookie-specific entry. This created N equal entries with no output variation. It also caused a key rebuilt from a served event to differ from the written key. Therefore, documented code such as `.invalidate(event)` after `handler(event)` purged nothing. That behavior also contradicted the rule that `varies` headers are visible.
- `allowCookies: string[]` is the preferred **fine** option. Only listed cookie names remain in the visible `Cookie` header and affect the key. `filterCookie` sorts them, so order does not matter. This option **overrides** `varies: ["cookie"]` in both directions. Remove `cookie` from `keyHeaderNames` because the allowlist hash is more precise. Never expose the raw header. Add `cookie` to `varyHeaderNames`, so `allowCookies` always emits `Vary: Cookie`.

Implement this as three branches in narrowing. Use the filtered subset when an allowlist exists. Otherwise, forward the raw header when `keyHeaderNames` contains `cookie`. Remove it in all other cases.

### Authorization

By default, `authorization` and `proxy-authorization` do not affect caching. Remove both from the handler-visible request on cacheable calls. A handler must not render per-user content from a credential absent from the key. No special code is needed because they are undeclared headers under the allowlist rule. Earlier code forwarded these headers without keying them. A token-authenticated route then failed open. The first caller's private response was stored under the anonymous key, replayed to everyone, and advertised with `max-age=N, s-maxage=N` to shared CDNs. Cookie-authenticated routes already failed closed. That difference was the defect.

`allowAuthorization: true` adds both names to both header lists. Deduplicate them against `opts.varies` and sort the result. One operation then keys the values, emits them in `Vary`, and keeps them visible. Listing either name in `varies` is the same opt-in. The caller accepts one entry for each credential value, shared by callers that present the same value. This is a breaking change. Handlers that need credentials must set `allowAuthorization` or bypass those requests.

## Mutation of the caller's event

Narrowing **mutates** `event.req`. It also mutates `event.url` when `allowQuery` applies. It does not restore either value. After a MISS, the caller sees the narrowed request. After a HIT or bypass, the caller does not.

Do not restore values in a `finally` block. A response body can read them after the resolver returns. For example, an asynchronous `ReadableStream.pull` runs while `serialize` calls `res.arrayBuffer()`. Early restoration would expose the original credentials to a lazy body that is then cached and replayed. It would also leave an SWR race in which a background refresh replaces the stale reader's event after the response returns. The correct fix is to avoid mutating the caller's event. That requires a design decision because `E` can be any framework event. This work is **tracked, open**.

Narrowing that **cannot be applied must fail closed**. An event can expose `req` or `url` as a read-only accessor, so the assignment throws or is silently ignored. Earlier code logged that error and ran the handler anyway. The handler then read the credentials and excluded query values that the key does not cover, and `serialize` stored that output under the narrow key and advertised `max-age`/`s-maxage` for it. This is the same fail-open shape as the forwarded-credential defect above, reached through the framework instead of the filter.

`narrowRequest` therefore throws `NarrowRequestError`, and `defineCachedHandler` catches only that error and serves the request through the handler directly. This is the bypass path: no key, no storage, no header synthesis. Do not throw the error to the caller. The condition is a property of the framework event, so it applies to every request, and a hard failure would take the route down rather than degrade it to no caching. Read each assignment back, because a silent setter is as unsafe as a throwing one. Narrowing is all or nothing: restore `event.req` when the later `event.url` assignment fails, so the handler never sees a request and URL that disagree. Restoring is correct **only** here. The handler has not run, so no lazy response body can read the event. Restore only the values that were actually replaced; assigning the original back to a getter-only property throws again.

Copy `runtime` and `waitUntil` to the replacement `Request`. Bind `waitUntil` to the original request. A direct method copy would use the narrowed `Request` as `this`, but srvx and Cloudflare implement it against the original request. All four `cache.ts` call sites read `waitUntil` after the replacement. If the property is lost, background writes can stop when the isolate exits. Every request then remains a MISS. SWR refresh and eviction after failure can fail in the same way.
