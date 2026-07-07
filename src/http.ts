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

  const variableHeaderNames = (opts.varies || [])
    .filter(Boolean)
    .map((h) => h.toLowerCase())
    .sort();

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
      const _path = _url.pathname + _url.search;
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

    try {
      const originalReq = event.req;
      (event as any).req = new Request(event.req.url, {
        method: event.req.method,
        headers: filteredHeaders,
      });
      // Inherit runtime context
      if ((originalReq as any).runtime) {
        (event.req as any).runtime = (originalReq as any).runtime;
      }
    } catch (error) {
      console.error("[cache] Failed to filter headers:", error);
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
