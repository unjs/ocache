// Everything decided from the incoming request: whether it is cached at all, and what the
// handler may see of it (`narrowRequest` narrows exactly when `resolveBypass` said no —
// it gates itself on that verdict, so the two cannot disagree). One rule, shared with
// `key.ts`: a handler may read exactly what the key covers — otherwise it renders content
// from an input that never reaches the key. Filters live in `filters.ts`.

import type { HandlerConfig } from "./config.ts";
import { filterCookie, filteredSearch, safeHeaderNames } from "./filters.ts";
import { cacheableMethods } from "./key.ts";

import type { HTTPEvent } from "../types.ts";

// Built-in half; `resolveBypass` composes the caller's hook on top, never replaces it; never
// consulted alone. `Range` unkeyed — `curl -r 0-0` poisoned later GETs; 206 is off the allowlist.
function shouldBypassCache(event: HTTPEvent): boolean {
  return !cacheableMethods.includes(event.req.method) || event.req.headers.has("range");
}

// Composed, not clobbered (issue #50), and evaluated EXACTLY ONCE per call — the caller's hook may
// be async or side-effecting — so the verdict `cache.ts` awaits is memoized for `narrowRequest`.
export async function resolveBypass<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  event: HTTPEvent,
): Promise<boolean> {
  const bypass =
    shouldBypassCache(event) || (await config.opts.shouldBypassCache?.(event as E)) === true;
  config.bypassed.set(event, bypass);
  return bypass;
}

// NO-OP when bypassed: never keyed, so untouched — the rewrite drops the body; stripping
// credentials served the anonymous page to authed users. Gate: *composed* verdict, not built-in.
//
// MUTATES the caller's event, never restored: a body producer can run *after* the resolver, so
// handing back the credentialed request re-opens what narrowing closes. Copy instead: tracked.
export function narrowRequest<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  event: HTTPEvent,
): void {
  if (config.bypassed.get(event) ?? shouldBypassCache(event)) {
    return;
  }

  const { keyHeaderNames, allowedCookieNames, allowedQueryNames } = config;

  // An ALLOWLIST, the rule stated literally: not in `keyHeaderNames` ⇒ can't vary the key ⇒
  // must not be seen. The key list, never `Vary` (`allowCookies` differs between the two).
  // `varies` headers are therefore forwarded — that is the point of declaring them — as are
  // the `safeHeaderNames` that provably cannot vary a rendering. Everything else is dropped:
  // forwarding it let a handler render from an input no key covered, so the first caller's
  // `x-api-key`/`x-forwarded-host` rendering was replayed to every later caller, under a
  // synthesized `max-age` and with no `Vary` to warn a shared cache off it. The credential
  // strip was this rule applied to two names by hand.
  const filteredHeaders = [...event.req.headers.entries()].flatMap(([key, value]) => {
    const name = key.toLowerCase();
    if (name !== "cookie") {
      return keyHeaderNames.includes(name) || safeHeaderNames.includes(name)
        ? [[key, value] as [string, string]]
        : [];
    }
    // Same rule, three-way: `allowCookies` → the subset the key hashes; else `cookie` in
    // `keyHeaderNames` → the raw header, itself the key component; else stripped (secure default).
    if (!allowedCookieNames) {
      return keyHeaderNames.includes("cookie") ? [[key, value] as [string, string]] : [];
    }
    const cookie = filterCookie(value, allowedCookieNames);
    return cookie ? [["cookie", cookie] as [string, string]] : [];
  });

  // Narrowed so the handler can't depend on params outside the cache key.
  let _reqUrl = event.req.url;
  if (allowedQueryNames) {
    const _url = event.url ?? new URL(event.req.url);
    const _filteredUrl = new URL(_url);
    _filteredUrl.search = filteredSearch(config, event, _url);
    _reqUrl = _filteredUrl.href;
  }

  try {
    const originalReq = event.req;
    (event as any).req = new Request(_reqUrl, {
      method: event.req.method,
      headers: filteredHeaders,
    });
    // Inherit runtime context
    if ((originalReq as any).runtime) {
      (event.req as any).runtime = (originalReq as any).runtime;
    }
    // *Bound* to the original request (srvx/Cloudflare implement it against that receiver).
    // `cache.ts` reads it after this swap; dropping it makes every background write inert.
    if (typeof originalReq.waitUntil === "function") {
      event.req.waitUntil = originalReq.waitUntil.bind(originalReq);
    }
    if (allowedQueryNames && event.url) {
      (event as any).url = new URL(_reqUrl);
    }
  } catch (error) {
    console.error("[cache] Failed to filter request:", error);
  }
}
