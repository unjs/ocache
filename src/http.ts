import { parseURL } from "ufo";
import { hash } from "ohash";
import { cachedFunction } from "./cache.ts";

import type {
  HTTPEvent,
  EventHandler,
  CacheOptions,
  CachedEventHandlerOptions,
  ResponseCacheEntry,
} from "./types.ts";

function defaultCacheOptions() {
  return {
    name: "_",
    base: "/cache",
    swr: true,
    maxAge: 1,
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
export function defineCachedHandler(
  handler: EventHandler,
  opts: CachedEventHandlerOptions = defaultCacheOptions(),
): EventHandler {
  const variableHeaderNames = (opts.varies || [])
    .filter(Boolean)
    .map((h) => h.toLowerCase())
    .sort();

  const _opts: CacheOptions<ResponseCacheEntry> = {
    ...opts,
    shouldBypassCache: (event) => {
      return event.req.method !== "GET" && event.req.method !== "HEAD";
    },
    getKey: async (event: HTTPEvent) => {
      // Custom user-defined key
      const customKey = await opts.getKey?.(event);
      if (customKey) {
        return escapeKey(customKey);
      }
      // Auto-generated key
      const _url = event.url ?? new URL(event.req.url);
      const _path = _url.pathname + _url.search;
      let _pathname: string;
      try {
        _pathname = escapeKey(decodeURI(parseURL(_path).pathname)).slice(0, 16) || "index";
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
    group: opts.group || "cache/handlers",
    integrity: opts.integrity || hash([handler, opts]),
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
    const rawValue = await handler(event);
    const res = rawValue instanceof Response ? rawValue : new Response(String(rawValue));

    // Stringified body
    // TODO: support binary responses
    const body = await res.text();

    if (!res.headers.has("etag")) {
      res.headers.set("etag", `W/"${hash(body)}"`);
    }

    if (!res.headers.has("last-modified")) {
      res.headers.set("last-modified", new Date().toUTCString());
    }

    const cacheControl = [];
    if (opts.swr) {
      if (opts.maxAge) {
        cacheControl.push(`s-maxage=${opts.maxAge}`);
      }
      if (opts.staleMaxAge) {
        cacheControl.push(`stale-while-revalidate=${opts.staleMaxAge}`);
      } else {
        cacheControl.push("stale-while-revalidate");
      }
    } else if (opts.maxAge) {
      cacheControl.push(`max-age=${opts.maxAge}`);
    }
    if (cacheControl.length > 0) {
      res.headers.set("cache-control", cacheControl.join(", "));
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
      if (handleCacheHeaders(event, { maxAge: opts.maxAge })) {
        return new Response(null, { status: 304 });
      }
      return handler(event);
    }

    // Call with cache
    const response = (await _cachedHandler(event))!;

    // Check for cache headers
    if (
      handleCacheHeaders(event, {
        modifiedTime: new Date(response.headers["last-modified"] as string),
        etag: response.headers.etag as string,
        maxAge: opts.maxAge,
      })
    ) {
      return new Response(null, { status: 304 });
    }

    // Send Response
    return new Response(response.body, {
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

interface CacheConditions {
  modifiedTime?: Date;
  maxAge?: number;
  etag?: string;
}

function handleCacheHeaders(event: HTTPEvent, opts: CacheConditions): boolean {
  // Check if-none-match
  const ifNoneMatch = event.req.headers.get("if-none-match");
  if (ifNoneMatch && opts.etag && ifNoneMatch === opts.etag) {
    return true;
  }

  // Check if-modified-since
  const ifModifiedSince = event.req.headers.get("if-modified-since");
  if (ifModifiedSince && opts.modifiedTime) {
    if (new Date(ifModifiedSince) >= opts.modifiedTime) {
      return true;
    }
  }

  return false;
}
