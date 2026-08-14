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
export const authHeaderNames = ["authorization", "proxy-authorization"];

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

  /** Cache tags advertised in `Cache-Tag`, or `undefined` to emit no header. */
  tagList: string[] | undefined;

  /** Filtered query values for this handler's requests. */
  searchCache: WeakMap<HTTPEvent, string>;

  /** Combined bypass results, evaluated once per request. */
  bypassed: WeakMap<HTTPEvent, boolean>;
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

  // An empty tag list means that no `Cache-Tag` header is advertised.
  const _tags = [...new Set((opts.tags ?? []).map((t) => t?.trim()).filter(Boolean))];
  const tagList = _tags.length > 0 ? _tags : undefined;

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
    tagList,
    searchCache: new WeakMap<HTTPEvent, string>(),
    bypassed: new WeakMap<HTTPEvent, boolean>(),
  };
}

/** Removes storage-location options from the integrity input. */
export function integrityOpts<E extends HTTPEvent>(
  opts: CachedEventHandlerOptions<E>,
): Omit<CachedEventHandlerOptions<E>, "base" | "group" | "name" | "storage"> {
  const { base: _, group: _g, name: _n, storage: _s, ...rest } = opts;
  return rest;
}
