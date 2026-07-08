import { hash } from "ohash";
import { cachedFunction } from "./cache.ts";

import type {
  HTTPEvent,
  EventHandler,
  CacheEntry,
  CacheOptions,
  CachedEventHandlerOptions,
  CacheConditions,
  ResponseCacheEntry,
} from "./types.ts";

function defaultCacheOptions() {
  return {
    name: "_",
    base: "/cache",
    swr: true,
    maxAge: 1,
    cacheStatusHeader: true,
  } as const;
}

/**
 * Wraps an HTTP event handler with response caching.
 *
 * Automatically generates cache keys from the URL path and variable headers,
 * sets `cache-control`, `etag`, and `last-modified` headers, and handles
 * `304 Not Modified` responses via conditional request headers.
 *
 * @param handler - The event handler to cache.
 * @param opts - Cache and HTTP-specific configuration options.
 * @returns A new event handler that serves cached responses when available.
 */
export function defineCachedHandler<E extends HTTPEvent = HTTPEvent>(
  handler: EventHandler<E>,
  opts: CachedEventHandlerOptions<E> = {},
): EventHandler<E> {
  opts = { ...defaultCacheOptions(), ...opts };

  const variableHeaderNames = (opts.varies || [])
    .filter(Boolean)
    .map((h) => h.toLowerCase())
    .sort();

  const allowedQueryNames = opts.allowQuery
    ? [...new Set(opts.allowQuery.filter(Boolean))]
    : undefined;

  // Memoize the filtered query per request so getKey and the handler-facing URL
  // rewrite don't recompute it. Scoped to this handler instance so a shared
  // event can't pick up another handler's allowlist.
  const _searchCache = new WeakMap<HTTPEvent, string>();
  const _filteredSearch = (event: HTTPEvent, url: URL): string => {
    let search = _searchCache.get(event);
    if (search === undefined) {
      search = _filterSearch(url, allowedQueryNames!);
      _searchCache.set(event, search);
    }
    return search;
  };

  const _toResponse =
    opts.toResponse ||
    ((rawValue: unknown) =>
      rawValue instanceof Response ? rawValue : new Response(String(rawValue)));

  const _createResponse =
    opts.createResponse || ((body: string | null, init: ResponseInit) => new Response(body, init));

  const _handleCacheHeaders = opts.handleCacheHeaders || _defaultHandleCacheHeaders;

  // CDN-style cache-status header (X-Cache: HIT | MISS | STALE)
  const _statusHeader =
    opts.cacheStatusHeader === true
      ? "x-cache"
      : typeof opts.cacheStatusHeader === "string" && opts.cacheStatusHeader
        ? opts.cacheStatusHeader.toLowerCase()
        : undefined;

  // Freshness directives parsed from a Cache-Control the handler itself set, keyed by
  // response value. Populated in the resolver *before* the synthesized cache-control is
  // added, so `honorCacheControl` only ever honors a real upstream header — never the
  // one synthesized below from the static options.
  const _upstreamTtl = new WeakMap<ResponseCacheEntry, { maxAge?: number; staleMaxAge?: number }>();

  const _opts: CacheOptions<ResponseCacheEntry> = {
    ...opts,
    // When opted in, derive the per-entry maxAge/staleMaxAge from the (upstream)
    // response's Cache-Control freshness directives — a directive present on the
    // response wins for that field, absent fields fall back to the user's `getMaxAge`,
    // then the static options. Off: pass `getMaxAge` through.
    getMaxAge: opts.honorCacheControl
      ? (entry) => _honorCacheControlMaxAge(entry, opts, _upstreamTtl)
      : opts.getMaxAge,
    // Inject the cache-status header into a cloned entry value (never mutating the
    // stored entry) so it flows through to the final Response headers.
    transform: _statusHeader
      ? (entry) => {
          if (!entry.value) {
            return;
          }
          return {
            ...entry.value,
            headers: {
              ...entry.value.headers,
              [_statusHeader]: String(entry.status).toUpperCase(),
            },
          };
        }
      : undefined,
    shouldBypassCache: (event) => {
      return event.req.method !== "GET" && event.req.method !== "HEAD";
    },
    getKey: async (event: HTTPEvent) => {
      // Custom user-defined key
      const customKey = await opts.getKey?.(event as E);
      if (customKey) {
        return escapeKey(customKey);
      }
      // Auto-generated key
      const _url = event.url ?? new URL(event.req.url);
      const _search = allowedQueryNames ? _filteredSearch(event, _url) : _url.search;
      const _path = _url.pathname + _search;
      let _pathname: string;
      try {
        _pathname =
          escapeKey(decodeURI(new URL(_path, "http://localhost").pathname)).slice(0, 16) || "index";
      } catch {
        _pathname = "-";
      }
      const _hashedPath = `${_pathname}.${hash(_path)}`;
      const _headers = variableHeaderNames
        .map((header) => [header, event.req.headers.get(header)])
        .map(([name, value]) => `${escapeKey(name as string)}.${hash(value)}`);
      return [_hashedPath, ..._headers].join(":");
    },
    validate: (entry) => {
      if (!entry.value) {
        return false;
      }
      // Honor an explicit `Cache-Control: no-store` / `private` on the response — never cache it.
      if (_forbidsSharedCaching(entry.value.headers?.["cache-control"])) {
        return false;
      }
      // With honorCacheControl, `no-cache` gets the same treatment: without conditional
      // revalidation machinery, "revalidate on every use" means never serving from cache.
      if (
        opts.honorCacheControl &&
        _parseCacheControlDirectives(entry.value.headers?.["cache-control"])?.has("no-cache")
      ) {
        return false;
      }
      if (entry.value.status >= 400) {
        return false;
      }
      if (entry.value.body === undefined) {
        return false;
      }
      if (
        entry.value.headers.etag === "undefined" ||
        entry.value.headers["last-modified"] === "undefined"
      ) {
        return false;
      }
      return true;
    },
    group: opts.group || "handlers",
    integrity: opts.integrity || hash([handler, _integrityOpts(opts)]),
  };

  const _cachedHandler = cachedFunction<ResponseCacheEntry>(async (event: HTTPEvent) => {
    // Filter non variable headers
    const filteredHeaders = [...event.req.headers.entries()].filter(
      ([key]) => !variableHeaderNames.includes(key.toLowerCase()),
    );

    // Narrow the query the handler sees to the allowlist, so it can't depend on
    // params outside the cache key (mirrors the header filtering above).
    let _reqUrl = event.req.url;
    if (allowedQueryNames) {
      const _url = event.url ?? new URL(event.req.url);
      const _filteredUrl = new URL(_url);
      _filteredUrl.search = _filteredSearch(event, _url);
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
      if (allowedQueryNames && event.url) {
        (event as any).url = new URL(_reqUrl);
      }
    } catch (error) {
      console.error("[cache] Failed to filter request:", error);
    }

    // Call handler
    const rawValue = await handler(event as E);
    const res = await _toResponse(rawValue, event as E);

    // Stringified body
    // TODO: support binary responses
    const body = await res.text();

    if (!res.headers.has("etag")) {
      res.headers.set("etag", `W/"${hash(body)}"`);
    }

    if (!res.headers.has("last-modified")) {
      res.headers.set("last-modified", new Date().toUTCString());
    }

    // Capture the handler's own Cache-Control before the synthesized one below is added,
    // so honorCacheControl can tell real upstream freshness apart from the directives
    // derived from the static options.
    const upstreamCacheControl = opts.honorCacheControl ? res.headers.get("cache-control") : null;

    // Only synthesize a cache-control header when the handler did not set one
    // explicitly — never clobber an explicit cache-control with our SWR/s-maxage
    // directives (mirrors the etag / last-modified "preserve if present" behavior above).
    if (!res.headers.has("cache-control")) {
      const cacheControl = [];
      if (opts.swr) {
        if (opts.maxAge != null) {
          cacheControl.push(`s-maxage=${opts.maxAge}`);
        }
        if (opts.staleMaxAge != null) {
          cacheControl.push(`stale-while-revalidate=${opts.staleMaxAge}`);
        } else {
          cacheControl.push("stale-while-revalidate");
        }
      } else if (opts.maxAge) {
        // For non-SWR, set max-age directly
        cacheControl.push(`max-age=${opts.maxAge}`);
      }
      if (cacheControl.length > 0) {
        res.headers.set("cache-control", cacheControl.join(", "));
      }
    }

    const cacheEntry: ResponseCacheEntry = {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      body,
    };

    if (upstreamCacheControl) {
      const upstream = _parseCacheControlTtl(upstreamCacheControl);
      if (upstream) {
        _upstreamTtl.set(cacheEntry, upstream);
      }
    }

    return cacheEntry;
  }, _opts);

  return async (event) => {
    // Headers-only mode
    if (opts.headersOnly) {
      if (_handleCacheHeaders(event, { maxAge: opts.maxAge })) {
        return _createResponse(null, { status: 304 });
      }
      return handler(event);
    }

    // Call with cache
    const response = (await _cachedHandler(event))!;

    // Check for cache headers
    if (
      _handleCacheHeaders(event, {
        modifiedTime: new Date(response.headers["last-modified"] as string),
        etag: response.headers.etag as string,
        maxAge: opts.maxAge,
      })
    ) {
      const statusValue = _statusHeader
        ? (response.headers[_statusHeader] as string | undefined)
        : undefined;
      return _createResponse(null, {
        status: 304,
        headers: statusValue === undefined ? undefined : { [_statusHeader!]: statusValue },
      });
    }

    // Send Response
    return _createResponse(response.body ?? null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

// --- Internal helpers ---

function escapeKey(key: string | string[]) {
  return String(key).replace(/\W/g, "");
}

/** Rebuilds the query string from only the allowlisted param names, order-independent. */
function _filterSearch(url: URL, names: string[]): string {
  const filtered = new URLSearchParams();
  for (const name of names) {
    for (const value of url.searchParams.getAll(name).sort()) {
      filtered.append(name, value);
    }
  }
  const query = filtered.toString();
  return query ? `?${query}` : "";
}

/**
 * Tokenizes a `Cache-Control` header value into a lowercase directive-name → raw-value map.
 * Returns `undefined` for a missing or non-string header.
 */
function _parseCacheControlDirectives(
  cacheControl: unknown,
): Map<string, string | undefined> | undefined {
  if (typeof cacheControl !== "string" || !cacheControl) {
    return undefined;
  }
  const directives = new Map<string, string | undefined>();
  for (const directive of cacheControl.split(",")) {
    const [name, value] = directive.trim().split("=");
    directives.set(name!.toLowerCase(), value);
  }
  return directives;
}

/**
 * Whether a `Cache-Control` header value explicitly forbids storing the response in a
 * shared cache — `no-store` (never store anywhere) or `private` (not in a shared cache).
 */
function _forbidsSharedCaching(cacheControl: unknown): boolean {
  const directives = _parseCacheControlDirectives(cacheControl);
  return directives !== undefined && (directives.has("no-store") || directives.has("private"));
}

/**
 * `getMaxAge` implementation for `honorCacheControl`: derives the per-entry lifetime from
 * the freshness directives the handler (upstream) response set on its own `Cache-Control`.
 *
 * An upstream directive wins for its field; absent fields fall back to the user's
 * `getMaxAge` result, and fields still `undefined` fall back to the static options
 * (in cache.ts). Only a header set by the handler counts as upstream — the cache-control
 * synthesized from the static options is never parsed back (see `_upstreamTtl`).
 */
async function _honorCacheControlMaxAge<E extends HTTPEvent>(
  entry: CacheEntry<ResponseCacheEntry>,
  opts: CachedEventHandlerOptions<E>,
  upstreamTtl: WeakMap<ResponseCacheEntry, { maxAge?: number; staleMaxAge?: number }>,
): Promise<{ maxAge?: number; staleMaxAge?: number }> {
  const upstream = entry.value ? upstreamTtl.get(entry.value) : undefined;
  let dynamic: { maxAge?: number; staleMaxAge?: number } | undefined;
  if (opts.getMaxAge) {
    try {
      const resolved = await opts.getMaxAge(entry);
      // A bare number is shorthand for `{ maxAge }` (mirrors cache.ts).
      dynamic = typeof resolved === "number" ? { maxAge: resolved } : resolved;
    } catch (error) {
      // Isolate user-hook failures (as cache.ts does) so upstream directives still apply.
      if (opts.onError) {
        opts.onError(error);
      } else {
        console.error("[cache] getMaxAge hook error.", error);
      }
    }
  }
  return {
    maxAge: upstream?.maxAge ?? dynamic?.maxAge,
    staleMaxAge: upstream?.staleMaxAge ?? dynamic?.staleMaxAge,
  };
}

/**
 * Parses the freshness directives from a response `Cache-Control` header into per-entry
 * TTL overrides for the `getMaxAge` hook, using shared-cache semantics:
 * - `s-maxage` takes precedence over `max-age` for `maxAge`
 * - `stale-while-revalidate` maps to `staleMaxAge`
 * - `s-maxage` without `stale-while-revalidate` forces `staleMaxAge: 0` — per RFC 9111
 *   §5.2.2.10 `s-maxage` implies `proxy-revalidate`, so once stale the response must be
 *   revalidated before reuse (never served stale). An explicit `stale-while-revalidate`
 *   (RFC 5861) is the origin's in-protocol permission to serve stale and wins when present.
 *
 * Returns `undefined` when no relevant directive is present. A directive present but
 * without a numeric value (e.g. bare `stale-while-revalidate`, `max-age=`) yields
 * `undefined` for that field alone. `no-cache` is handled in `validate` instead —
 * such responses are never cached at all.
 */
function _parseCacheControlTtl(
  cacheControl: unknown,
): { maxAge?: number; staleMaxAge?: number } | undefined {
  const directives = _parseCacheControlDirectives(cacheControl);
  if (!directives) {
    return undefined;
  }
  // Shared cache: s-maxage overrides max-age.
  const sMaxAge = _parseSeconds(directives.get("s-maxage"));
  const maxAge = sMaxAge ?? _parseSeconds(directives.get("max-age"));
  let staleMaxAge = _parseSeconds(directives.get("stale-while-revalidate"));
  if (sMaxAge !== undefined && staleMaxAge === undefined) {
    // Implied proxy-revalidate: zero stale window (blocking revalidation once stale).
    staleMaxAge = 0;
  }
  if (maxAge === undefined && staleMaxAge === undefined) {
    return undefined;
  }
  return { maxAge, staleMaxAge };
}

/** Parses a Cache-Control directive value into seconds, or `undefined` if absent/empty/non-numeric. */
function _parseSeconds(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** Strips storage-location fields from opts so integrity only reflects the cached computation. */
function _integrityOpts<E extends HTTPEvent>(
  opts: CachedEventHandlerOptions<E>,
): Omit<CachedEventHandlerOptions<E>, "base" | "group" | "name"> {
  const { base: _, group: _g, name: _n, ...rest } = opts;
  return rest;
}

function _defaultHandleCacheHeaders(event: HTTPEvent, conditions: CacheConditions): boolean {
  // Check if-none-match
  const ifNoneMatch = event.req.headers.get("if-none-match");
  if (ifNoneMatch && conditions.etag && ifNoneMatch === conditions.etag) {
    return true;
  }

  // Check if-modified-since
  const ifModifiedSince = event.req.headers.get("if-modified-since");
  if (ifModifiedSince && conditions.modifiedTime) {
    if (new Date(ifModifiedSince) >= conditions.modifiedTime) {
      return true;
    }
  }

  return false;
}
