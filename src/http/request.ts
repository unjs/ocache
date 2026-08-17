// A handler may read only request data that its cache key covers.

import type { HandlerConfig } from "./config.ts";
import { filterCookie, filteredSearch, safeHeaderNames } from "./filters.ts";
import { cacheableMethods } from "./key.ts";

import type { HTTPEvent, ServerRequest } from "../types.ts";

// Range requests bypass caching because the key does not cover byte ranges.
function shouldBypassCache(event: HTTPEvent): boolean {
  return !cacheableMethods.includes(event.req.method) || event.req.headers.has("range");
}

// Evaluate the combined bypass rule once because caller hooks may have side effects.
export async function resolveBypass<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  event: HTTPEvent,
): Promise<boolean> {
  const bypass =
    shouldBypassCache(event) || (await config.opts.shouldBypassCache?.(event as E)) === true;
  config.bypassed.set(event, bypass);
  return bypass;
}

// Leave bypassed requests unchanged, including their bodies and credentials.
// Do not restore mutations because a lazy response body may read the narrowed event later.
// Throws `NarrowRequestError` when the event cannot be narrowed; never narrows partially.
export function narrowRequest<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  event: HTTPEvent,
): void {
  if (config.bypassed.get(event) ?? shouldBypassCache(event)) {
    return;
  }

  const { keyHeaderNames, allowedCookieNames, allowedQueryNames } = config;

  // Remove every header that is neither keyed nor explicitly safe.
  const filteredHeaders = [...event.req.headers.entries()].flatMap(([key, value]) => {
    const name = key.toLowerCase();
    if (name !== "cookie") {
      return keyHeaderNames.includes(name) || safeHeaderNames.has(name)
        ? [[key, value] as [string, string]]
        : [];
    }
    // Forward the keyed cookie subset, the keyed raw header, or no cookies.
    if (!allowedCookieNames) {
      return keyHeaderNames.includes("cookie") ? [[key, value] as [string, string]] : [];
    }
    const cookie = filterCookie(value, allowedCookieNames);
    return cookie ? [["cookie", cookie] as [string, string]] : [];
  });

  // Remove query values that the key does not cover.
  let _reqUrl = event.req.url;
  if (allowedQueryNames) {
    const _url = event.url ?? new URL(event.req.url);
    const _filteredUrl = new URL(_url);
    _filteredUrl.search = filteredSearch(config, event, _url);
    _reqUrl = _filteredUrl.href;
  }

  const originalReq = event.req;
  const originalUrl = event.url;
  let replacedReq = false;
  let replacedUrl = false;
  try {
    const req: ServerRequest = new Request(_reqUrl, {
      method: originalReq.method,
      headers: filteredHeaders,
    });
    // Preserve adapter runtime context.
    if ((originalReq as any).runtime) {
      (req as any).runtime = (originalReq as any).runtime;
    }
    // Bind `waitUntil` because adapters may require the original Request receiver.
    if (typeof originalReq.waitUntil === "function") {
      req.waitUntil = originalReq.waitUntil.bind(originalReq);
    }
    (event as any).req = req;
    replacedReq = true;
    // A silent setter is as unsafe as a throwing one, so read the value back.
    if (event.req !== req) {
      throw new Error("`event.req` is read-only.");
    }
    if (allowedQueryNames && event.url) {
      const url = new URL(_reqUrl);
      (event as any).url = url;
      replacedUrl = true;
      if (event.url !== url) {
        throw new Error("`event.url` is read-only.");
      }
    }
  } catch (error) {
    // Restore here, unlike the success path: the handler has not run, so no lazy
    // response body can read the event yet.
    if (replacedReq) {
      (event as any).req = originalReq;
    }
    if (replacedUrl) {
      (event as any).url = originalUrl;
    }
    throw new NarrowRequestError(error);
  }
}

/**
 * Signals that the event could not be narrowed to what the cache key covers.
 *
 * The handler could read credentials or excluded query values that no key covers,
 * so `defineCachedHandler` bypasses the cache for the request instead of storing it.
 */
export class NarrowRequestError extends Error {
  override name = "NarrowRequestError";
  constructor(cause: unknown) {
    super("Cannot narrow the request to what the cache key covers.", { cause });
  }
}
