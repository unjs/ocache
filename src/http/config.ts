import { definedOptions, resolveName } from "../cache.ts";

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

/** Configuration shared by all modules for one handler. */
export interface HandlerConfig<E extends HTTPEvent> {
  /** Resolved handler options. */
  opts: CachedEventHandlerOptions<E>;

  /** Allowed request cookie names, or `undefined` to strip all cookies. */
  allowedCookieNames: string[] | undefined;

  /** Query names that reach the handler and cache key. */
  allowedQueryNames: string[] | undefined;

  /** Headers that reach the handler and cache key. */
  keyHeaderNames: string[];

  /** Request headers advertised in the response `Vary` header. */
  varyHeaderNames: string[];

  /** Cache-status header name, or `undefined` to disable it. */
  statusHeader: string | undefined;
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

  const allowedQueryNames = opts.allowQuery
    ? [...new Set(opts.allowQuery.filter(Boolean))]
    : undefined;

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
  };
}

/** Removes storage-location options from the integrity input. */
export function integrityOpts<E extends HTTPEvent>(
  opts: CachedEventHandlerOptions<E>,
): Omit<CachedEventHandlerOptions<E>, "base" | "group" | "name" | "storage"> {
  const { base: _, group: _g, name: _n, storage: _s, ...rest } = opts;
  return rest;
}
