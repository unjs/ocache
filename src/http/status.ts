// Docs: @docs/5.handler.md

import type { CacheStatus, HTTPEvent } from "../types.ts";

// How the last cached handler to answer an event served it. Keyed by event, like
// `resolveStatuses` in `cache.ts`, so a framework can read it without a response header.
// Allocated on the first response served from the cache path.
let servedStatuses: WeakMap<HTTPEvent, CacheStatus> | undefined;

/**
 * Returns how a cached handler served the response for this event.
 *
 * Unlike the cache-status header, this is set whatever `cacheStatusHeader` is, and a
 * handler cannot forge it by setting that header on a response the cache never saw.
 *
 * Returns `undefined` when no cached handler answered the event, or when the last one to
 * answer it served the live response without the cache: a bypassed request, `headersOnly`,
 * or the fallback for a body over `maxBodySize` or an event that cannot be narrowed.
 * When cached handlers nest on one event, the outermost one answers last and wins.
 *
 * @param event - The event passed to a handler from `defineCachedHandler`.
 * @returns The cache status of the served response, or `undefined` without the cache.
 *
 * @example
 * ```ts
 * const res = await cachedHandler(event);
 * const status = getCacheStatus(event); // "hit" | "stale" | "revalidated" | "miss" | undefined
 * ```
 */
export function getCacheStatus(event: HTTPEvent): CacheStatus | undefined {
  return servedStatuses?.get(event);
}

// Serve path: record the status of the response about to be returned, or clear it.
export function setCacheStatus(event: HTTPEvent, status: CacheStatus | undefined): void {
  if (status) {
    (servedStatuses ??= new WeakMap()).set(event, status);
  } else {
    servedStatuses?.delete(event);
  }
}
