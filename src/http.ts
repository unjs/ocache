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
  } as const;
}

/** Methods whose responses are cacheable by default. `QUERY` is safe + idempotent (RFC 10008). */
const DEFAULT_METHODS = ["GET", "HEAD", "QUERY"] as const;

/** Memoized buffered request bodies, keyed by event, so the body stream is read at most once. */
const BODY_BUFFERS = new WeakMap<object, ArrayBuffer | undefined>();

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

  const cacheableMethods = (opts.methods || DEFAULT_METHODS).map((m) => m.toUpperCase());

  const _opts: CacheOptions<ResponseCacheEntry> = {
    ...opts,
    shouldBypassCache: (event) => {
      return !cacheableMethods.includes(event.req.method.toUpperCase());
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
      const segments = [_hashedPath, ..._headers];

      // QUERY (and other body-bearing methods): the request content *is* the query, so the cache key
      // MUST incorporate it along with related metadata (RFC 10008, Section 2.7).
      const body = await _getBufferedBody(event);
      if (body !== undefined) {
        const contentType = event.req.headers.get("content-type") || "";
        const accept = event.req.headers.get("accept") || "";
        const bodyKey = await _resolveBodyKey(body, contentType, event as E, opts);
        segments.push(`ct.${hash(contentType)}`, `ac.${hash(accept)}`, `body.${bodyKey}`);
      }

      return segments.join(":");
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
    group: opts.group || "handlers",
    integrity: opts.integrity || hash([handler, _integrityOpts(opts)]),
  };

  const _cachedHandler = cachedFunction<ResponseCacheEntry>(async (event: HTTPEvent) => {
    // Filter non variable headers
    const filteredHeaders = [...event.req.headers.entries()].filter(
      ([key]) => !variableHeaderNames.includes(key.toLowerCase()),
    );

    // Buffer the body (if any) before rebuilding the request, so body-bearing methods like QUERY
    // still receive their content downstream. Reuses the same buffer already read for the cache key.
    const bodyBuf = await _getBufferedBody(event);

    try {
      const originalReq = event.req;
      (event as any).req = new Request(event.req.url, {
        method: originalReq.method,
        headers: filteredHeaders,
        ...(bodyBuf === undefined ? {} : { body: bodyBuf }),
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

    // Advertise supported query formats (RFC 10008, Section 3) unless the handler set it already.
    if (opts.acceptQuery && !res.headers.has("accept-query")) {
      res.headers.set("accept-query", serializeAcceptQuery(opts.acceptQuery));
    }

    // For body-bearing methods, the response selection depends on the request content metadata.
    if (event.req.method !== "GET" && event.req.method !== "HEAD") {
      appendVary(res.headers, ["content-type", "accept"]);
    }

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
      return _createResponse(null, { status: 304 });
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
 * Reads and memoizes a request's body as an `ArrayBuffer` (per event), or `undefined` for methods
 * that cannot carry one (`GET`/`HEAD`) or empty bodies. The stream is consumed at most once and the
 * buffered bytes are reused both for the cache key and to rebuild the request for the handler.
 */
async function _getBufferedBody(event: HTTPEvent): Promise<ArrayBuffer | undefined> {
  if (BODY_BUFFERS.has(event)) {
    return BODY_BUFFERS.get(event);
  }
  const req = event.req;
  const method = req.method.toUpperCase();
  let buf: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD" && req.body != null) {
    try {
      buf = await req.arrayBuffer();
    } catch (error) {
      console.error("[cache] Failed to read request body:", error);
    }
  }
  BODY_BUFFERS.set(event, buf);
  return buf;
}

/** Matches JSON media types (`application/json`, `*+json`) but not `application/jsonpath` etc. */
const JSON_CONTENT_TYPE_RE = /\bjson\b/i;

/** Matches the `no-transform` cache directive in a `cache-control` header value. */
const NO_TRANSFORM_RE = /(?:^|,)\s*no-transform\s*(?:,|$)/i;

/**
 * Produces the body portion of the cache key. Applies the user `normalizeQueryKey` hook when given,
 * otherwise canonicalizes JSON content structurally and hashes other bodies as raw bytes. Normalization
 * is skipped when the request carries the advisory `no-transform` directive (RFC 10008, Section 2.7).
 */
async function _resolveBodyKey<E extends HTTPEvent>(
  body: ArrayBuffer,
  contentType: string,
  event: E,
  opts: CachedEventHandlerOptions<E>,
): Promise<string> {
  if (opts.normalizeQueryKey) {
    return hash(await opts.normalizeQueryKey({ body, contentType, event }));
  }
  const noTransform = NO_TRANSFORM_RE.test(event.req.headers.get("cache-control") || "");
  if (!noTransform && JSON_CONTENT_TYPE_RE.test(contentType)) {
    try {
      return hash(JSON.parse(new TextDecoder().decode(body)));
    } catch {
      // Fall through to raw hashing on malformed JSON.
    }
  }
  return hash(new TextDecoder().decode(body));
}

/** Serializes media type(s) as a Structured Fields list for the `Accept-Query` header (RFC 10008). */
function serializeAcceptQuery(types: string | string[] | readonly string[]): string {
  const list = Array.isArray(types) ? types : [types as string];
  return list
    .map((t) => _serializeMediaRange(String(t)))
    .filter(Boolean)
    .join(", ");
}

/** SF token grammar (RFC 9651): starts with ALPHA/`*`, then tchar plus `:` and `/`. */
const SF_TOKEN_RE = /^[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*$/;
/** SF key grammar (RFC 9651): starts with lcalpha/`*`, then lcalpha/DIGIT/`_`/`-`/`.`/`*`. */
const SF_KEY_RE = /^[a-z*][a-z0-9_.*-]*$/;

function _serializeMediaRange(input: string): string {
  const parts = input.split(";").map((p) => p.trim());
  const base = parts.shift() || "";
  if (!base) {
    return "";
  }
  let out = _sfBareItem(base);
  for (const param of parts) {
    if (!param) {
      continue;
    }
    const eq = param.indexOf("=");
    if (eq === -1) {
      out += `;${_sfKey(param)}`;
      continue;
    }
    const key = param.slice(0, eq).trim();
    const value = param
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
    out += `;${_sfKey(key)}=${_sfBareItem(value)}`;
  }
  return out;
}

function _sfBareItem(value: string): string {
  return SF_TOKEN_RE.test(value) ? value : `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

function _sfKey(key: string): string {
  const lower = key.toLowerCase();
  return SF_KEY_RE.test(lower) ? lower : `"${lower.replace(/(["\\])/g, "\\$1")}"`;
}

/** Merges header names into an existing `Vary` header without duplicating entries. */
function appendVary(headers: Headers, names: string[]): void {
  const set = new Set(
    (headers.get("vary") || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const name of names) {
    set.add(name.toLowerCase());
  }
  if (set.size > 0) {
    headers.set("vary", [...set].join(", "));
  }
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
