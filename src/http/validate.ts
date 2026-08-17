import { cacheControlForbidsReuse } from "./cache-control.ts";
import { hasUnkeyedVary, hasVaryWildcard } from "./vary.ts";

import type { HandlerConfig } from "./config.ts";
import type { HTTPEvent, ResponseCacheEntry } from "../types.ts";

// Store only complete representations that are safe to reuse.
const cacheableStatuses: ReadonlySet<number> = /* @__PURE__ */ new Set([200, 203, 301, 308]);

// Storage validation and cache-control synthesis must share this predicate.
export function isCacheableStatus(status: number): boolean {
  return cacheableStatuses.has(status);
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
  if (!isCacheableStatus(value.status)) {
    return false;
  }
  // An empty string is a valid zero-byte representation.
  if (value.body === undefined) {
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
