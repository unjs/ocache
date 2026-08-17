import { hash } from "../hash.ts";
import { cachedFunction, expireCache, invalidateCache, resolveCacheKeys } from "../cache.ts";
import { resolveStorage } from "../storage.ts";

import { requiresRevalidation } from "./cache-control.ts";
import { integrityOpts, resolveHandlerConfig } from "./config.ts";
import { defaultHandleCacheHeaders, notModifiedHeaders } from "./conditional.ts";
import { deserializeEntry, serializeResponse } from "./entry.ts";
import { cacheableMethods, methodKey, resolveKey } from "./key.ts";
import { NarrowRequestError, narrowRequest, resolveBypass } from "./request.ts";
import { validateEntry } from "./validate.ts";

import type {
  HTTPEvent,
  EventHandler,
  CachedEventHandler,
  CacheOptions,
  CachedEventHandlerOptions,
  ResponseCacheEntry,
} from "../types.ts";

/**
 * Wraps an HTTP handler with response caching and conditional response support.
 *
 * Only GET and HEAD requests without Range are cacheable.
 * Only 200, 203, 301, and 308 responses are stored.
 * Response Cache-Control and Vary headers can prevent storage.
 *
 * @param handler - Handler to cache.
 * @param opts - Cache and HTTP options.
 * @returns A cached handler with resource-level cache management methods.
 */
export function defineCachedHandler<E extends HTTPEvent = HTTPEvent>(
  handler: EventHandler<E>,
  opts: CachedEventHandlerOptions<E> = {},
): CachedEventHandler<E> {
  // Handler configuration owns a merged copy of caller options.
  const config = resolveHandlerConfig(handler, opts);
  opts = config.opts;
  const { statusHeader } = config;

  const toResponse =
    opts.toResponse ||
    ((rawValue: unknown) =>
      rawValue instanceof Response ? rawValue : new Response(String(rawValue)));

  const createResponse =
    opts.createResponse ||
    ((body: string | Uint8Array | null, init: ResponseInit) =>
      new Response(body as BodyInit | null, init));

  const handleCacheHeaders = opts.handleCacheHeaders || defaultHandleCacheHeaders;

  // Stored values use `ResponseCacheEntry`, although the resolver returns Response.
  const _opts: CacheOptions<Response> = {
    ...opts,
    // Add cache status to a clone, not the stored entry.
    transform: statusHeader
      ? (entry) => {
          const value = entry.value as unknown as ResponseCacheEntry | undefined;
          if (!value) {
            return;
          }
          return {
            ...value,
            headers: {
              ...value.headers,
              [statusHeader]: String(entry.status).toUpperCase(),
            },
          };
        }
      : undefined,
    // `must-revalidate` permits storage but sets the stale window to zero.
    getMaxAge: async (entry) => {
      const res = entry.value;
      // Do not consume the body before serialization.
      const override =
        res instanceof Response && requiresRevalidation(res.headers.get("cache-control"))
          ? { staleMaxAge: 0 }
          : undefined;
      let dynamic: { maxAge?: number; staleMaxAge?: number } | undefined;
      try {
        const resolved = await opts.getMaxAge?.(entry);
        dynamic = typeof resolved === "number" ? { maxAge: resolved } : resolved;
      } catch (error) {
        if (opts.onError) {
          opts.onError(error);
        } else {
          console.error("[cache] getMaxAge hook error.", error);
        }
      }
      return override ? { ...dynamic, ...override } : dynamic;
    },
    // Serialization uses dynamic lifetimes from the complete entry.
    serialize: (entry) => serializeResponse(config, entry),
    // Request narrowing reads this same combined bypass result.
    shouldBypassCache: (event: HTTPEvent) => resolveBypass(config, event),
    getKey: async (event: HTTPEvent) =>
      methodKey(await resolveKey(config, event), event.req.method),
    // Validate the serialized shape on both writes and reads.
    validate: (entry) => validateEntry(config, entry.value as unknown as ResponseCacheEntry),
    group: opts.group || "handlers",
    integrity: opts.integrity || hash([handler, integrityOpts(opts)]),
  };

  // Bypassed calls return the live Response without serialization.
  const cachedFn = cachedFunction<Response>(async (event: HTTPEvent) => {
    // Bypassed requests keep their credentials and complete query.
    narrowRequest(config, event);

    const rawValue = await handler(event as E);
    return toResponse(rawValue, event as E);
  }, _opts);

  const cachedHandler: EventHandler<E> = async (event) => {
    if (opts.headersOnly) {
      if (handleCacheHeaders(event, { maxAge: opts.maxAge })) {
        return createResponse(null, { status: 304 });
      }
      return handler(event);
    }

    let cached: Response | ResponseCacheEntry;
    try {
      cached = (await cachedFn(event))! as Response | ResponseCacheEntry;
    } catch (error) {
      if (!(error instanceof NarrowRequestError)) {
        throw error;
      }
      // Narrowing failed, so the key cannot cover what the handler reads. Serve the
      // request uncached and unadvertised, exactly as an explicit bypass would.
      if (opts.onError) {
        opts.onError(error);
      } else {
        console.error("[cache] Bypassing cache.", error);
      }
      return toResponse(await handler(event), event);
    }

    // Return bypassed responses without cache headers or body buffering.
    if (cached instanceof Response) {
      return cached;
    }
    const response = cached;

    if (
      handleCacheHeaders(event, {
        modifiedTime: new Date(response.headers["last-modified"] as string),
        etag: response.headers.etag as string,
        maxAge: opts.maxAge,
      })
    ) {
      return createResponse(null, {
        status: 304,
        headers: notModifiedHeaders(response.headers, statusHeader),
      });
    }

    const { body, init } = deserializeEntry(response);
    return createResponse(body, init);
  };

  // Resource-level operations include every cacheable method variant.
  const variantOptions = async (event: E) => {
    // Resolve storage before copying options so all variants share one backend.
    resolveStorage(_opts);
    const key = await resolveKey(config, event);
    const methods = cacheableMethods.includes(event.req.method)
      ? [event.req.method, ...cacheableMethods.filter((m) => m !== event.req.method)]
      : // A non-cacheable event has no cache variant of its own.
        cacheableMethods;
    return methods.map((method) => {
      const _key = methodKey(key, method);
      return { ..._opts, getKey: () => _key };
    });
  };

  const revalidate = cachedHandler as CachedEventHandler<E>;
  revalidate.resolveKeys = async (event: E) => {
    const keys = await Promise.all(
      (await variantOptions(event)).map((options) => resolveCacheKeys({ options })),
    );
    return keys.flat();
  };
  revalidate.invalidate = async (event: E) => {
    await Promise.all((await variantOptions(event)).map((options) => invalidateCache({ options })));
  };
  revalidate.expire = async (event: E) => {
    await Promise.all((await variantOptions(event)).map((options) => expireCache({ options })));
  };

  return revalidate;
}
