// Docs: @docs/8.cache-control.md

import { cacheControlForbidsReuse } from "./cache-control.ts";
import { hasUnkeyedVary, hasVaryWildcard } from "./vary.ts";

import { builtinCacheableStatuses, type HandlerConfig } from "./config.ts";
import type { HTTPEvent, ResponseCacheEntry } from "../types.ts";

// Storage validation and cache-control synthesis must share this predicate.
export function isCacheableStatus<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  status: number,
): boolean {
  return config.cacheableStatuses.has(status);
}

// A 304 stands in only for the built-in statuses: preconditions are ignored for a response
// that would otherwise be an error (RFC 9110 §13.2.1), so a cached 404 is served as is.
export function isConditionalStatus(status: number): boolean {
  return builtinCacheableStatuses.has(status);
}

// Validate on write and read so access rejects unsafe legacy entries.
export async function validateEntry<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  value: ResponseCacheEntry | undefined,
): Promise<boolean> {
  const { opts, varyHeaderNames } = config;
  if (!value) {
    return false;
  }
  if (forbidsSharedCaching(value.headers)) {
    return false;
  }
  // Reject variance that this handler cannot represent in its key.
  if (hasUnkeyedVary(value.headers?.vary, varyHeaderNames)) {
    return false;
  }
  // Reject response cookies from legacy or foreign entries.
  if (value.headers?.["set-cookie"]) {
    return false;
  }
  if (!isCacheableStatus(config, value.status)) {
    return false;
  }
  // An empty string is a valid zero-byte representation, and a byte view is the binary form.
  // Anything else is a missing body or a backend that declared `binary` without keeping views:
  // a serializing one returns `{"0":255,...}` here, which no reader can turn back into bytes.
  if (typeof value.body !== "string" && !ArrayBuffer.isView(value.body)) {
    return false;
  }
  if (value.headers.etag === "undefined" || value.headers["last-modified"] === "undefined") {
    return false;
  }
  // The caller hook can only reject, and errors fail closed.
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
}

/**
 * Returns whether response headers forbid shared-cache storage or reuse.
 *
 * This includes Cache-Control opt-outs and `Vary: *`.
 * Unkeyed Vary names are a separate key-coverage failure.
 */
function forbidsSharedCaching(headers: ResponseCacheEntry["headers"] | undefined): boolean {
  if (!headers) {
    return false;
  }
  const vary = headers.vary;
  if (typeof vary === "string" && hasVaryWildcard(vary)) {
    return true;
  }
  return cacheControlForbidsReuse(headers["cache-control"]);
}
