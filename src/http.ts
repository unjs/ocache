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
    swr: false,
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

  // Non-GET/HEAD requests skip the cache entirely. Shared between the
  // `shouldBypassCache` option and the resolver so the request-narrowing
  // step below can't disagree with the bypass decision. This is the built-in
  // method check only — a caller's `opts.shouldBypassCache` is composed on top
  // of it in `_opts` below, never in place of it.
  const _shouldBypassCache = (event: HTTPEvent) =>
    event.req.method !== "GET" && event.req.method !== "HEAD";

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
    opts.createResponse ||
    ((body: string | Uint8Array | ReadableStream | null, init: ResponseInit) =>
      new Response(body as BodyInit | null, init));

  // Streaming handshake between the internal `serialize` hook (which owns the resolved
  // `Response` and tees its body) and the outer wrapper (which serves the client). Keyed
  // by the live event so a shared event can't cross handler instances. On a streamed MISS,
  // `serialize` resolves the deferred with the client-facing branch before it buffers the
  // other branch, letting the wrapper answer without waiting on the full read.
  const _streamDeferreds = new WeakMap<HTTPEvent, StreamDeferred>();

  const _handleCacheHeaders = opts.handleCacheHeaders || _defaultHandleCacheHeaders;

  // CDN-style cache-status header (X-Cache: HIT | MISS | STALE)
  const _statusHeader =
    opts.cacheStatusHeader === true
      ? "x-cache"
      : typeof opts.cacheStatusHeader === "string" && opts.cacheStatusHeader
        ? opts.cacheStatusHeader.toLowerCase()
        : undefined;

  // The cached function resolves to a live `Response`; `serialize` turns it into the
  // stored `ResponseCacheEntry`, and `transform` reads that entry back on serve. So `T`
  // is the resolver's `Response`, while `entry.value` holds the serialized entry once
  // stored — the same documented looseness `transform` already relies on.
  const _opts: CacheOptions<Response> = {
    ...opts,
    // Inject the cache-status header into a cloned entry value (never mutating the
    // stored entry) so it flows through to the final Response headers.
    transform: _statusHeader
      ? (entry) => {
          const value = entry.value as unknown as ResponseCacheEntry | undefined;
          if (!value) {
            return;
          }
          return {
            ...value,
            headers: {
              ...value.headers,
              [_statusHeader]: String(entry.status).toUpperCase(),
            },
          };
        }
      : undefined,
    // Write-side seam: consume the resolved `Response` body, synthesize the cache
    // headers, and build the storable `ResponseCacheEntry`. Runs exactly once per
    // resolution (shared across deduplicated callers), so `res.arrayBuffer()`'s one-shot
    // consumption is safe. Kept out of the resolver so bypassed requests — which never
    // reach `serialize` — get their live `Response` back untouched.
    serialize: async (entry, ctx) => {
      const res = entry.value as unknown as Response;

      // Synthesize the body-independent response headers first, so a streamed MISS
      // response (handed to the client below, before the body is buffered) still carries
      // them. `etag` is the exception — it hashes the body, so it is synthesized after
      // buffering and therefore only decorates the *stored* entry (and thus cache HITs),
      // never the initial streamed response, which can't be hashed without buffering.
      if (!res.headers.has("last-modified")) {
        res.headers.set("last-modified", new Date().toUTCString());
      }

      // Only synthesize a cache-control header when the handler did not set one
      // explicitly — never clobber an explicit cache-control with our SWR/s-maxage
      // directives (mirrors the etag / last-modified "preserve if present" behavior).
      // `sendCacheControl: false` opts out of synthesis entirely (server-only caching):
      // the entry is still stored/served with SWR/etag/last-modified, but no
      // cache-control is advertised to clients/CDNs — without the `no-store`/`private`
      // tricks that would also disqualify the entry from storage (issue #49, nitro#3997).
      if (opts.sendCacheControl !== false && !res.headers.has("cache-control")) {
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

      // Advertise the request headers this response varies on so downstream
      // caches/CDNs/browsers store a separate variant per value — merging with any
      // `Vary` the handler already set rather than clobbering it (mirrors the
      // "preserve if present" behavior of the cache-control synthesis above).
      if (variableHeaderNames.length > 0) {
        _appendVary(res.headers, variableHeaderNames);
      }

      // Strip every Set-Cookie the allowlist doesn't cover BEFORE the headers are
      // serialized (and before the streaming tee below), so a per-request cookie (e.g. a
      // session id) can never reach a caller other than the one it was minted for —
      // neither a future cache hit, a concurrent coalesced peer sharing this resolution,
      // nor the streamed MISS response (issue #61). By default (no `allowCookies`) that
      // drops every Set-Cookie: a shared cache must not carry per-client cookies,
      // mirroring both the Cookie-request-header stripping on the way in and how CDNs /
      // Varnish treat cacheable responses. The rest of the response is still cached.
      // Prefer `getSetCookie()` so each cookie is inspected individually —
      // `Object.fromEntries(headers.entries())` below collapses multiples to one. On
      // runtimes without it we can't tell which cookies are present, so strip all of them
      // (fail safe) rather than risk replaying one.
      if (typeof res.headers.getSetCookie === "function") {
        const setCookies = res.headers.getSetCookie();
        const kept = setCookies.filter((c) => allowedCookieNames?.includes(_cookieName(c)));
        if (kept.length !== setCookies.length) {
          res.headers.delete("set-cookie");
          for (const c of kept) {
            res.headers.append("set-cookie", c);
          }
        }
      } else if (res.headers.has("set-cookie")) {
        res.headers.delete("set-cookie");
      }

      // Streaming: hand a live branch of the body to the waiting client before buffering
      // the other branch for storage, so the client isn't blocked on the full read. Only
      // when `stream` is enabled, the body is present, and a client is still waiting (an
      // unsettled deferred — a background SWR refresh finds it settled and just buffers).
      // The check-and-settle is synchronous (no `await` between them), so exactly one
      // resolution per event tees, shared across all coalesced callers.
      let bodySource: Response = res;
      const _event = ctx.args[0] as HTTPEvent | undefined;
      const _deferred = _event && _streamDeferreds.get(_event);
      if (opts.stream && res.body && _deferred && !_deferred.settled) {
        _deferred.settled = true;
        const [cacheBranch, clientBranch] = res.body.tee();
        // Buffer the cache branch below; the client reads its own branch concurrently.
        bodySource = new Response(cacheBranch, {
          status: res.status,
          statusText: res.statusText,
        });
        _deferred.resolve({
          body: clientBranch,
          status: res.status,
          statusText: res.statusText,
          // Headers captured post-synthesis / post-cookie-strip but pre-etag.
          headers: Object.fromEntries(res.headers.entries()),
        });
      }

      // Read the body once as raw bytes (from the cache branch when streaming). A
      // valid-UTF-8 body is stored verbatim as a string (unchanged behavior, so text
      // etags stay stable); anything else (images, protobuf/MVT tiles, other binary
      // Buffers) is base64-encoded and flagged, so the lossy `res.text()` UTF-8 decode
      // can't mangle it and it survives JSON-serializing storage backends. Valid UTF-8
      // roundtrips losslessly through the string form, so the discriminator is byte
      // validity, not the (spoofable/absent) content-type.
      const bytes = new Uint8Array(await bodySource.arrayBuffer());
      const text = _decodeUtf8(bytes);
      const base64 = text === undefined;
      const body = base64 ? _bytesToBase64(bytes) : text;

      if (!res.headers.has("etag")) {
        res.headers.set("etag", `W/"${hash(body)}"`);
      }

      const cacheEntry: ResponseCacheEntry = {
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries(res.headers.entries()),
        body,
        // Only set for binary bodies — text entries stay flag-free (and byte-identical to
        // pre-binary-support entries), so `transform`'s `{ ...value }` spread carries it through.
        ...(base64 && { base64: true }),
      };

      return cacheEntry;
    },
    // Compose the built-in non-GET/HEAD bypass with the caller's opt-in check
    // instead of clobbering it: bypass when either says so. A bare `...opts`
    // spread already carried `opts.shouldBypassCache`, but assigning the
    // built-in here used to silently discard it (issue #50).
    shouldBypassCache: async (event: HTTPEvent) => {
      if (_shouldBypassCache(event)) {
        return true;
      }
      return (await opts.shouldBypassCache?.(event as E)) === true;
    },
    getKey: async (event: HTTPEvent) => {
      // Custom user-defined key
      const customKey = await opts.getKey?.(event as E);
      if (customKey) {
        const _key = escapeKey(customKey);
        // If escaping was a no-op the key is already storage-safe and can't collide,
        // so keep it as-is. Otherwise escaping is lossy (distinct keys can collapse to
        // the same segment), so append a hash of the raw key to keep them distinct.
        // The `.` separator only appears in the hashed form, so an escaped-clean key
        // (pure `\w`, never contains `.`) and a hashed key can never overlap.
        return _key === customKey ? _key : `${_key.slice(0, 64)}.${hash(customKey)}`;
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
    validate: async (entry) => {
      // `validate` always inspects the serialized shape: on write it runs right after
      // `serialize` (entry.value is the freshly built `ResponseCacheEntry`), on read it
      // sees the entry as persisted.
      const value = entry.value as unknown as ResponseCacheEntry | undefined;
      if (!value) {
        return false;
      }
      // Honor an explicit `Cache-Control: no-store` / `private` on the response — never cache it.
      if (_forbidsSharedCaching(value.headers?.["cache-control"])) {
        return false;
      }
      // Defense-in-depth for entries this version didn't write (e.g. cached before the
      // Set-Cookie stripping in `serialize` existed, or by another writer sharing the
      // storage): reject a stored Set-Cookie outside the allowlist instead of replaying
      // it until expiry. Entries written by this version never carry a disallowed
      // Set-Cookie — `serialize` strips them before storage — so this only guards
      // pre-existing/foreign entries. Serialized headers collapse multiple Set-Cookie
      // values to the last, so the check is partial; the lossless guard is the strip.
      const _setCookie = value.headers?.["set-cookie"];
      if (_setCookie && !allowedCookieNames?.includes(_cookieName(_setCookie))) {
        return false;
      }
      if (value.status >= 400) {
        return false;
      }
      if (value.body === undefined) {
        return false;
      }
      if (value.headers.etag === "undefined" || value.headers["last-modified"] === "undefined") {
        return false;
      }
      // Additive user hook: ANDed with the built-in checks above so callers can
      // reject responses (e.g. redirects) without reimplementing load-bearing
      // safety checks. Cannot be used to force-cache a response the built-ins reject.
      // A throwing hook fails closed (treat as not cacheable) rather than breaking
      // the request — the response is still served, just not stored/served-from-cache.
      if (opts.shouldCache) {
        try {
          if ((await opts.shouldCache(value)) === false) {
            return false;
          }
        } catch (error) {
          if (opts.onError) {
            opts.onError(error);
          } else {
            console.error("[cache] shouldCache hook error.", error);
          }
          return false;
        }
      }
      return true;
    },
    group: opts.group || "handlers",
    integrity: opts.integrity || hash([handler, _integrityOpts(opts)]),
  };

  // Resolver: narrow the request (cacheable calls only), run the handler, and return
  // the *live* `Response`. Serialization into a `ResponseCacheEntry` happens in the
  // `serialize` hook above, so a bypassed request — which `cachedFunction` returns raw,
  // skipping `serialize`/`transform` — flows back out as an untouched `Response`.
  const _cachedHandler = cachedFunction<Response>(async (event: HTTPEvent) => {
    // Narrow the request for cache-key consistency — cacheable calls only. Bypassed
    // methods (POST etc.) are never stored or key-derived, so their request must reach
    // the handler untouched (cookies, varied headers, full query, body — the rewritten
    // Request below carries no body).
    if (!_shouldBypassCache(event)) {
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
        // Carry `waitUntil` across the narrowing rebuild — without this the background
        // cache write (and, in `stream` mode, the entire buffer-and-store) would lose the
        // runtime hook that keeps it alive on serverless, so the entry might never persist.
        // Bound to the original request in case the runtime's implementation relies on it.
        if (typeof (originalReq as any).waitUntil === "function") {
          (event.req as any).waitUntil = (originalReq as any).waitUntil.bind(originalReq);
        }
        if (allowedQueryNames && event.url) {
          (event as any).url = new URL(_reqUrl);
        }
      } catch (error) {
        console.error("[cache] Failed to filter request:", error);
      }
    }

    // Call handler
    const rawValue = await handler(event as E);
    return _toResponse(rawValue, event as E);
  }, _opts);

  // Builds the servable Response from a stored `ResponseCacheEntry` (cache hit path):
  // handles the 304 conditional short-circuit and decodes base64 binary bodies. Shared
  // by the non-streaming path and the cache-hit branch of the streaming path.
  const _serveEntry = (event: E, response: ResponseCacheEntry): Response => {
    // Check for cache headers
    if (
      _handleCacheHeaders(event, {
        modifiedTime: new Date(response.headers["last-modified"] as string),
        etag: response.headers.etag as string,
        maxAge: opts.maxAge,
      })
    ) {
      // A 304 must echo the `Vary` (and cache-status) that would have accompanied
      // the full response, so a shared cache doesn't lose the variant dimension
      // (RFC 7232 §4.1).
      const notModifiedHeaders: Record<string, string> = {};
      const statusValue = _statusHeader
        ? (response.headers[_statusHeader] as string | undefined)
        : undefined;
      if (statusValue !== undefined) {
        notModifiedHeaders[_statusHeader!] = statusValue;
      }
      const varyValue = response.headers.vary as string | undefined;
      if (varyValue !== undefined) {
        notModifiedHeaders.vary = varyValue;
      }
      return _createResponse(null, {
        status: 304,
        headers: Object.keys(notModifiedHeaders).length > 0 ? notModifiedHeaders : undefined,
      });
    }

    // Send Response. Binary bodies were stored base64-encoded; decode them back to raw
    // bytes so the Response carries the original payload untouched (no UTF-8 mangling).
    const body =
      response.base64 && typeof response.body === "string"
        ? _base64ToBytes(response.body)
        : (response.body ?? null);
    return _createResponse(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  return async (event) => {
    // Headers-only mode
    if (opts.headersOnly) {
      if (_handleCacheHeaders(event, { maxAge: opts.maxAge })) {
        return _createResponse(null, { status: 304 });
      }
      return handler(event);
    }

    // Streaming mode: race the cached resolution against the streaming handshake. On a
    // MISS `serialize` tees the body and resolves the deferred (with the client branch)
    // *before* it buffers the storage branch, so the deferred wins and we answer with a
    // live stream while the store completes in the background. On a HIT `serialize` never
    // runs, so `_cachedHandler` (the buffered entry) wins and we serve it normally. A
    // bypassed method resolves `_cachedHandler` to the live `Response`, which also wins.
    if (opts.stream) {
      const deferred = _createDeferred();
      _streamDeferreds.set(event, deferred);
      const cachedP = _cachedHandler(event) as Promise<Response | ResponseCacheEntry | undefined>;

      const outcome = await Promise.race([
        cachedP.then((v) => ({ streamed: null as StreamSignal | null, cached: v })),
        deferred.promise.then((s) => ({ streamed: s, cached: undefined })),
      ]);

      if (outcome.streamed) {
        const s = outcome.streamed;
        // Let the background write finish; `waitUntil` keeps it alive on serverless, and
        // the `catch` (with or without `waitUntil`) prevents an unhandled rejection if the
        // stream/store errors after the client response was already handed off.
        event.req.waitUntil?.(cachedP.catch(() => {}));
        cachedP.catch(() => {});
        const headers = { ...s.headers };
        if (_statusHeader) {
          headers[_statusHeader] = "MISS";
        }
        return _createResponse(s.body, {
          status: s.status,
          statusText: s.statusText,
          headers,
        });
      }

      // Served from cache (or bypassed). Mark the deferred settled so a later background
      // SWR refresh doesn't tee a stream nobody reads; cancel one already in flight.
      deferred.settled = true;
      deferred.promise.then(
        (s) => s.body.cancel().catch(() => {}),
        () => {},
      );
      const cached = outcome.cached!;
      if (cached instanceof Response) {
        return cached;
      }
      return _serveEntry(event, cached as ResponseCacheEntry);
    }

    // Call with cache
    const cached = (await _cachedHandler(event))! as Response | ResponseCacheEntry;

    // Bypassed requests (non-GET/HEAD, or a caller `shouldBypassCache`) resolve to the
    // handler's live `Response`: `cachedFunction` returns the resolver output raw on the
    // bypass path (no `serialize`/`transform`). Pass it straight through — no body
    // buffering (streaming and binary bodies survive), no synthesized cache headers, and
    // no bogus 304 for a method that was never cacheable.
    if (cached instanceof Response) {
      return cached;
    }
    return _serveEntry(event, cached);
  };
}

// --- Internal helpers ---

/** The live, client-facing branch of a streamed response, plus its response line/headers. */
interface StreamSignal {
  body: ReadableStream;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

/** One-shot handshake for a streamed resolution. `settled` guards against a second tee. */
interface StreamDeferred {
  promise: Promise<StreamSignal>;
  resolve: (signal: StreamSignal) => void;
  settled: boolean;
}

function _createDeferred(): StreamDeferred {
  let resolve!: (signal: StreamSignal) => void;
  const promise = new Promise<StreamSignal>((r) => {
    resolve = r;
  });
  return { promise, resolve, settled: false };
}

// Fatal decoder so invalid UTF-8 throws (→ binary) instead of substituting replacement
// characters. `ignoreBOM` keeps a leading BOM in the string so it re-encodes byte-for-byte,
// preserving the lossless roundtrip that lets valid UTF-8 be stored as a plain string.
const _utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes bytes as UTF-8, returning `undefined` when they aren't valid UTF-8 (i.e. binary). */
function _decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return _utf8Decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/** Encodes raw bytes to a base64 string (chunked to stay within `String.fromCharCode` arg limits). */
function _bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x80_00;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decodes a base64 string produced by {@link _bytesToBase64} back to raw bytes. */
function _base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

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
 * Merges `names` into the response's `Vary` header, preserving any header names the
 * handler already declared and deduplicating case-insensitively. A wildcard
 * (`Vary: *`) is left untouched since it already varies on everything.
 */
function _appendVary(headers: Headers, names: string[]): void {
  const existing = headers.get("vary");
  // A `*` token means the response varies on everything — nothing to add.
  if (existing && existing.split(",").some((part) => part.trim() === "*")) {
    return;
  }
  const seen = new Set<string>();
  const merged: string[] = [];
  const add = (raw: string) => {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(name);
  };
  if (existing) {
    for (const part of existing.split(",")) {
      add(part);
    }
  }
  for (const name of names) {
    add(name);
  }
  headers.set("vary", merged.join(", "));
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
