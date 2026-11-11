// Docs: @docs/5.handler.md, @docs/6.query-params.md, @docs/7.cookies.md, @docs/8.cache-control.md

import { definedOptions, resolveName } from "../cache.ts";
import { unreplayableStatusError } from "../error.ts";

import type { HTTPEvent, EventHandler, CachedEventHandlerOptions } from "../types.ts";

// Keep HTTP-only defaults separate from function-cache defaults.
export function defaultHandlerOptions() {
  return {
    name: "_",
    base: "/cache",
    swr: false,
    maxAge: 1,
    cacheStatusHeader: true,
  } as const;
}

// Strip credentials unless their values are part of the key.
export const authHeaderNames: readonly string[] = /* @__PURE__ */ Object.freeze([
  "authorization",
  "proxy-authorization",
]);

// Store only complete representations that are safe to reuse.
export const builtinCacheableStatuses: ReadonlySet<number> = /* @__PURE__ */ new Set([
  200, 203, 301, 308,
]);

// No complete representation to replay, so `cacheableStatusCodes` cannot admit them.
const unreplayableStatuses: ReadonlySet<number> = /* @__PURE__ */ new Set([204, 205, 206, 304]);

/** Configuration shared by all modules for one handler. */
export interface HandlerConfig<E extends HTTPEvent> {
  /** Resolved handler options. */
  opts: CachedEventHandlerOptions<E>;

  /** Allowed request cookie names, or `undefined` to strip all cookies. */
  allowedCookieNames: string[] | undefined;

  /** Query names that reach the handler and cache key, or `undefined` for the full query. */
  allowedQueryNames: string[] | undefined;

  /** Headers that reach the handler and cache key. */
  keyHeaderNames: string[];

  /** Request headers advertised in the response `Vary` header. */
  varyHeaderNames: string[];

  /** Cache-status header name, or `undefined` to disable it. */
  statusHeader: string | undefined;

  /** Statuses that may be stored and advertised: the built-in set plus `cacheableStatusCodes`. */
  cacheableStatuses: ReadonlySet<number>;
}

// Resolve the name before defaults so the default cannot hide the handler name.
export function resolveHandlerConfig<E extends HTTPEvent>(
  handler: EventHandler<E>,
  callerOpts: CachedEventHandlerOptions<E>,
): HandlerConfig<E> {
  const name = resolveName(callerOpts.name, handler);
  // Explicit `undefined` values do not override defaults.
  const opts: CachedEventHandlerOptions<E> = {
    ...defaultHandlerOptions(),
    ...definedOptions(callerOpts),
    name,
  };

  // An empty cookie list means that no cookies are allowed.
  const _cookieNames = [
    ...new Set((opts.allowCookies ?? []).map((c) => c?.trim()).filter(Boolean)),
  ];
  const allowedCookieNames = _cookieNames.length > 0 ? _cookieNames : undefined;

  const _declaredHeaderNames = [
    ...new Set([
      ...(opts.varies || []).filter(Boolean).map((h) => h.toLowerCase()),
      ...(opts.allowAuthorization ? authHeaderNames : []),
    ]),
  ].sort();

  // Cookie allowlists use a subset key but must still advertise `Vary: Cookie`.
  const keyHeaderNames = allowedCookieNames
    ? _declaredHeaderNames.filter((h) => h !== "cookie")
    : _declaredHeaderNames;

  const varyHeaderNames = allowedCookieNames
    ? [...new Set([..._declaredHeaderNames, "cookie"])].sort()
    : _declaredHeaderNames;

  // Query names are opt-in: an unset option allows none, `true` allows the whole query.
  const allowedQueryNames =
    opts.allowQuery === true ? undefined : [...new Set((opts.allowQuery || []).filter(Boolean))];

  const statusHeader =
    opts.cacheStatusHeader === true
      ? "x-cache"
      : typeof opts.cacheStatusHeader === "string" && opts.cacheStatusHeader
        ? opts.cacheStatusHeader.toLowerCase()
        : undefined;

  return {
    opts,
    allowedCookieNames,
    allowedQueryNames,
    keyHeaderNames,
    varyHeaderNames,
    statusHeader,
    cacheableStatuses: resolveCacheableStatuses(opts.cacheableStatusCodes),
  };
}

// The option widens the built-in set and never replaces it.
function resolveCacheableStatuses(extra: readonly number[] | undefined): ReadonlySet<number> {
  if (!extra?.length) {
    return builtinCacheableStatuses;
  }
  for (const status of extra) {
    // `new Response()` only accepts integers from 200 to 599.
    if (
      !Number.isInteger(status) ||
      status < 200 ||
      status > 599 ||
      unreplayableStatuses.has(status)
    ) {
      throw unreplayableStatusError(status);
    }
  }
  return new Set([...builtinCacheableStatuses, ...extra]);
}

/**
 * Removes storage-location and host-plumbing options from the integrity input.
 *
 * `stream` joins them because it decides only when a caller is handed the body, never what
 * is stored: a streamed and a buffered fill write the same entry, so turning it on must not
 * make every existing entry cold.
 */
export function integrityOpts<E extends HTTPEvent>(
  opts: CachedEventHandlerOptions<E>,
): Omit<
  CachedEventHandlerOptions<E>,
  "base" | "group" | "name" | "storage" | "waitUntil" | "stream"
> {
  const { base: _, group: _g, name: _n, storage: _s, waitUntil: _w, stream: _st, ...rest } = opts;
  return rest;
}
