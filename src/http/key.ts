// Docs: @docs/5.handler.md, @docs/6.query-params.md, @docs/7.cookies.md, @docs/9.isr.md

import { hash } from "../hash.ts";

import { escapeKey, escapeKeySegment } from "../cache.ts";

import type { HandlerConfig } from "./config.ts";
import { filterCookie, filterSearch } from "./filters.ts";

import type { HTTPEvent } from "../types.ts";

// Request bypass and revalidation helpers must use this same method list.
export const cacheableMethods: readonly string[] = /* @__PURE__ */ Object.freeze(["GET", "HEAD"]);

// This key identifies a resource without its HTTP method.
export async function resolveKey<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  event: HTTPEvent,
): Promise<string> {
  const { opts, allowedQueryNames, allowedCookieNames, keyHeaderNames } = config;

  const customKey = await opts.getKey?.(event as E);
  if (customKey) {
    // Hash lossy escapes so custom keys cannot forge colon boundaries.
    return escapeKeySegment(customKey);
  }
  const _url = event.url ?? new URL(event.req.url);
  const _search = allowedQueryNames ? filterSearch(_url, allowedQueryNames) : _url.search;
  const _path = _url.pathname + _search;
  let _pathname: string;
  try {
    _pathname =
      escapeKey(decodeURI(new URL(_path, "http://localhost").pathname)).slice(0, 16) || "index";
  } catch {
    _pathname = "-";
  }
  // Include resolved URL authority to isolate hosts served by one handler.
  const _hashedPath = `${_pathname}.${hash([authority(_url), _path])}`;
  const _headers = keyHeaderNames
    .map((header) => [header, event.req.headers.get(header)])
    .map(([name, value]) => `${escapeKey(name as string)}.${hash(value)}`);
  // Hash the sorted cookie subset, never the raw header.
  const _cookies = allowedCookieNames
    ? [`cookie.${hash(filterCookie(event.req.headers.get("cookie"), allowedCookieNames))}`]
    : [];
  return [_hashedPath, ..._headers, ..._cookies].join(":");
}

/**
 * Prefixes non-GET resource keys with the HTTP method.
 *
 * Separate HEAD keys prevent bodyless HEAD responses from replacing GET responses.
 * GET has no prefix to preserve existing keys.
 */
export function methodKey(key: string, method: string): string {
  return method === "GET" ? key : `${method}:${key}`;
}

/**
 * Returns a canonical scheme, host, and port authority.
 * Uses protocol and host when opaque URLs report a `"null"` origin.
 */
function authority(url: URL): string {
  const origin = url.origin;
  return origin && origin !== "null" ? origin : `${url.protocol}//${url.host}`;
}
