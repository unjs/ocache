// Cache key composition: resource identity + method component. `resolveKey` derives the
// method-free part (auto: origin + path + varied headers + allowlisted cookies, or the
// caller's `getKey`), `methodKey` prefixes the method — so the revalidation helpers can
// enumerate every method variant of one resource from a single event.

import type { HandlerConfig } from "./config.ts";
import { filterCookie, filteredSearch } from "./filters.ts";

import { escapeKey, escapeKeySegment } from "../cache.ts";
import { hash } from "../hash.ts";
import type { HTTPEvent } from "../types.ts";

// The methods that get a key space of their own, and the single source of truth for them:
// `shouldBypassCache` derives its method half from this list and the revalidation helpers
// enumerate it. Making another method cacheable is a one-line addition here.
export const cacheableMethods = ["GET", "HEAD"];

// Resource identity: everything selecting a representation except the method. Separate from
// `methodKey` so the latter wraps *both* key branches and the revalidation helpers can
// enumerate variants without cloning the event.
export async function resolveKey<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  event: HTTPEvent,
): Promise<string> {
  const { opts, allowedQueryNames, allowedCookieNames, keyHeaderNames } = config;

  // Custom user-defined key
  const customKey = await opts.getKey?.(event as E);
  if (customKey) {
    // A no-op escape is already storage-safe; otherwise escaping is lossy, so the segment
    // carries a hash of the raw key. Same helper the `name` segment uses (`cache.ts`), so the
    // two treatments cannot drift.
    return escapeKeySegment(customKey);
  }
  // Auto-generated key
  const _url = event.url ?? new URL(event.req.url);
  const _search = allowedQueryNames ? filteredSearch(config, event, _url) : _url.search;
  const _path = _url.pathname + _search;
  let _pathname: string;
  try {
    _pathname =
      escapeKey(decodeURI(new URL(_path, "http://localhost").pathname)).slice(0, 16) || "index";
  } catch {
    _pathname = "-";
  }
  // The authority is part of the resource identity: without it one handler instance serving
  // several hostnames stored one entry per path across all of them, serving tenant A's
  // rendering to tenant B (h3#1524 finding #2, between hosts). Taken from `event.url` — what
  // the adapter resolved — never the attacker-controlled `Host` header, and hashed as a tuple
  // with `_path` so the origin/path boundary can't be read two ways.
  const _hashedPath = `${_pathname}.${hash([authority(_url), _path])}`;
  const _headers = keyHeaderNames
    .map((header) => [header, event.req.headers.get(header)])
    .map(([name, value]) => `${escapeKey(name as string)}.${hash(value)}`);
  // Keyed on the allowlisted cookie subset only (sorted, order-independent), never the raw
  // Cookie header. Omitted entirely when no cookies are allowed.
  const _cookies = allowedCookieNames
    ? [`cookie.${hash(filterCookie(event.req.headers.get("cookie"), allowedCookieNames))}`]
    : [];
  return [_hashedPath, ..._headers, ..._cookies].join(":");
}

/**
 * Prefixes a resource key with its method component; GET is the implicit default and carries
 * none, so its keys stay warm. Without this, a HEAD — whose body a spec-compliant host nulls —
 * seeds the shared entry with a zero-byte body that every GET is then served (h3#1524 finding
 * #3). Methods are verbatim (case-sensitive, already normalized by `Request`) and alphabetic,
 * which a resource key's first `:`-segment never is, so the key spaces cannot overlap. That
 * argument covers the *key* segment only; the `name` before it is escaped in `buildCacheKey`,
 * so it cannot spell a `HEAD:` of its own.
 */
export function methodKey(key: string, method: string): string {
  return method === "GET" ? key : `${method}:${key}`;
}

/**
 * The authority component: scheme + host + port. `URL.origin` where it exists, since it
 * canonicalizes (`http://a:80` == `http://a`), but it is the literal `"null"` for every
 * opaque origin — including non-special schemes that do have an authority — which would
 * collapse `x-proxy://a.example` and `x-proxy://b.example` into the very collision this
 * prevents. Those fall back to the verbatim `protocol//host`.
 */
function authority(url: URL): string {
  const origin = url.origin;
  return origin && origin !== "null" ? origin : `${url.protocol}//${url.host}`;
}
