import { hash } from "ohash";
import { cachedFunction } from "./cache.ts";

import type {
  HTTPEvent,
  EventHandler,
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

  // Allowlist of cookie names that may participate in caching. `undefined` means
  // "no cookies allowed": the Cookie request header is stripped before the handler
  // runs, cookies never vary the key, and Set-Cookie responses are refused storage.
  // Names are trimmed/deduped; an empty (or whitespace-only) list normalizes to the
  // "no cookies allowed" default.
  const _cookieNames = [
    ...new Set((opts.allowCookies ?? []).map((c) => c?.trim()).filter(Boolean)),
  ];
  const allowedCookieNames = _cookieNames.length > 0 ? _cookieNames : undefined;

  const variableHeaderNames = (opts.varies || [])
    .filter(Boolean)
    .map((h) => h.toLowerCase())
    // `allowCookies` supersedes `varies: ["cookie"]`: when set, cookie key-scoping and
    // handler-visibility are driven by the allowlist, so drop the coarse full-header vary.
    .filter((h) => !(allowedCookieNames && h === "cookie"))
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

  const _opts: CacheOptions<ResponseCacheEntry> = {
    ...opts,
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
      // Vary the key by the allowlisted cookie subset only (sorted, order-independent),
      // never the full raw Cookie header. Omitted entirely when no cookies are allowed.
      const _cookies = allowedCookieNames
        ? [`cookie.${hash(_filterCookie(event.req.headers.get("cookie"), allowedCookieNames))}`]
        : [];
      return [_hashedPath, ..._headers, ..._cookies].join(":");
    },
    validate: (entry) => {
      if (!entry.value) {
        return false;
      }
      // Honor an explicit `Cache-Control: no-store` / `private` on the response — never cache it.
      if (_forbidsSharedCaching(entry.value.headers?.["cache-control"])) {
        return false;
      }
      // Refuse to store (and later replay to other requests) a response that sets a
      // cookie outside the allowlist — otherwise a per-request `Set-Cookie` (e.g. a
      // session id) leaks to every cache-hit request. The decision is made in the
      // resolver via `getSetCookie()` (lossless, unlike the collapsed serialized
      // header) and flagged non-enumerably; it is absent on storage-read entries,
      // which are never blocked (a stored entry never carried a disallowed cookie).
      if ((entry.value as { _blockSetCookie?: boolean })._blockSetCookie) {
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
    // Filter non variable headers, and narrow the Cookie header to the allowlist so
    // the handler can't depend on cookies outside the cache key (mirrors allowQuery).
    const filteredHeaders = [...event.req.headers.entries()]
      .filter(([key]) => !variableHeaderNames.includes(key.toLowerCase()))
      .flatMap(([key, value]) => {
        if (key.toLowerCase() !== "cookie") {
          return [[key, value] as [string, string]];
        }
        const cookie = allowedCookieNames ? _filterCookie(value, allowedCookieNames) : "";
        return cookie ? [["cookie", cookie] as [string, string]] : [];
      });

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

    // Flag the entry non-storable when it sets a cookie outside the allowlist, read
    // back in `validate`. Prefer `getSetCookie()` so every Set-Cookie is inspected —
    // `Object.fromEntries(headers.entries())` above collapses them to just the last.
    // On runtimes without `getSetCookie` we can't enumerate individual cookies, so
    // fall back to header presence and block conservatively rather than fail open
    // (a fail-open default here would silently leak Set-Cookie across cache hits).
    const setCookies =
      typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : undefined;
    const blockSetCookie = setCookies
      ? setCookies.some((c) => !allowedCookieNames?.includes(_cookieName(c)))
      : res.headers.has("set-cookie");
    if (blockSetCookie) {
      Object.defineProperty(cacheEntry, "_blockSetCookie", { value: true, enumerable: false });
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

/** Rebuilds the `Cookie` header from only the allowlisted cookie names, sorted (order-independent). */
function _filterCookie(header: string | null | undefined, names: string[]): string {
  if (!header) {
    return "";
  }
  const kept: Array<[string, string]> = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    const name = (eq < 0 ? part : part.slice(0, eq)).trim();
    if (name && names.includes(name)) {
      kept.push([name, eq < 0 ? "" : part.slice(eq + 1).trim()]);
    }
  }
  kept.sort((a, b) =>
    a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1,
  );
  return kept.map(([n, v]) => `${n}=${v}`).join("; ");
}

/** Extracts the cookie name from a `Set-Cookie` header value (the token before the first `=`). */
function _cookieName(setCookie: string): string {
  const eq = setCookie.indexOf("=");
  return (eq < 0 ? setCookie.split(";")[0]! : setCookie.slice(0, eq)).trim();
}

/**
 * Whether a `Cache-Control` header value explicitly forbids storing the response in a
 * shared cache — `no-store` (never store anywhere) or `private` (not in a shared cache).
 */
function _forbidsSharedCaching(cacheControl: unknown): boolean {
  if (typeof cacheControl !== "string" || !cacheControl) {
    return false;
  }
  return cacheControl.split(",").some((directive) => {
    const name = directive.trim().split("=")[0]!.toLowerCase();
    return name === "no-store" || name === "private";
  });
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
