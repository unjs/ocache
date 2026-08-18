import { hash } from "../hash.ts";
import {
  cachedFunction,
  expireCache,
  fencePending,
  invalidateCache,
  resolveCacheKeys,
} from "../cache.ts";
import { resolveStorage } from "../storage.ts";

import { requiresRevalidation } from "./cache-control.ts";
import { integrityOpts, resolveHandlerConfig } from "./config.ts";
import { defaultHandleCacheHeaders, notModifiedHeaders, readConditions } from "./conditional.ts";
import { ResponseTooLargeError, deserializeEntry, serializeResponse } from "./entry.ts";
import { cacheableMethods, methodKey, resolveKey } from "./key.ts";
import { NarrowRequestError, isBypassedMethod, narrowRequest, resolveBypass } from "./request.ts";
import { isCacheableStatus, validateEntry } from "./validate.ts";

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
    // Serialization uses dynamic lifetimes from the complete entry. The storage read
    // that precedes it has already resolved `_opts.storage`, whose declared per-entry
    // ceiling bounds how much of a body may be buffered.
    serialize: (entry, ctx) =>
      serializeResponse(config, entry, _opts.storage, ctx.args[0] as HTTPEvent),
    // `cachedHandler` answers bypassed requests itself, so this resolver never sees one.
    shouldBypassCache: undefined,
    getKey: async (event: HTTPEvent) =>
      methodKey(await resolveKey(config, event), event.req.method),
    // Validate the serialized shape on both writes and reads.
    validate: (entry) => validateEntry(config, entry.value as unknown as ResponseCacheEntry),
    group: opts.group || "handlers",
    integrity: opts.integrity || hash([handler, integrityOpts(opts)]),
  };

  const cachedFn = cachedFunction<Response>(async (event: HTTPEvent) => {
    narrowRequest(config, event);

    const rawValue = await handler(event as E);
    return toResponse(rawValue, event as E);
  }, _opts);

  const cachedHandler: EventHandler<E> = async (event) => {
    // Read the request validators before the handler runs, because narrowing keeps
    // only headers the key covers and no key covers a validator.
    const requestConditions = readConditions(event);

    if (opts.headersOnly) {
      // Nothing is stored, so the handler's own validators are the only conditions
      // there are: run it first, then answer a matching conditional request with 304.
      const live = await toResponse(await handler(event), event);
      // A 304 needs a cacheable method and a representation to be current.
      if (isBypassedMethod(event) || !isCacheableStatus(live.status)) {
        return live;
      }
      const lastModified = live.headers.get("last-modified");
      if (
        handleCacheHeaders(event, {
          ...requestConditions,
          modifiedTime: lastModified ? new Date(lastModified) : undefined,
          etag: live.headers.get("etag") ?? undefined,
          maxAge: opts.maxAge,
        })
      ) {
        return createResponse(null, {
          status: 304,
          // No entry means no cache status; `cacheStatusHeader` has no effect here.
          headers: notModifiedHeaders(live.headers, undefined),
        });
      }
      return live;
    }

    // Bypassed requests keep their credentials and complete query, and their live
    // response passes through unserialized: no buffering, no synthesized headers.
    if (await resolveBypass(config, event)) {
      return toResponse(await handler(event), event);
    }

    let response: ResponseCacheEntry;
    try {
      response = (await cachedFn(event))! as unknown as ResponseCacheEntry;
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        // Claim before any await: the leader and its followers all see this one error.
        const live = error.claim(event);
        if (opts.onError) {
          opts.onError(error);
        } else {
          console.error("[cache] Bypassing cache.", error);
        }
        // The body was never stored, so serve it live. A follower cannot read the
        // leader's one-use stream and runs the handler for its own request instead.
        return live ?? toResponse(await handler(event), event);
      }
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

    // Only a handler sets `last-modified`, so a stored entry often has none.
    const modifiedTime = response.headers["last-modified"] as string | undefined;
    if (
      handleCacheHeaders(event, {
        ...requestConditions,
        modifiedTime: modifiedTime ? new Date(modifiedTime) : undefined,
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
      return { key: _key, options: { ..._opts, getKey: () => _key } };
    });
  };

  const revalidate = cachedHandler as CachedEventHandler<E>;
  revalidate.resolveKeys = async (event: E) => {
    const keys = await Promise.all(
      (await variantOptions(event)).map(({ options }) => resolveCacheKeys({ options })),
    );
    return keys.flat();
  };
  // Fence each variant so an in-flight resolution cannot undo the purge.
  revalidate.invalidate = async (event: E) => {
    await Promise.all(
      (await variantOptions(event)).map(async ({ key, options }) => {
        await fencePending(cachedFn, key);
        return invalidateCache({ options });
      }),
    );
  };
  revalidate.expire = async (event: E) => {
    await Promise.all(
      (await variantOptions(event)).map(async ({ key, options }) => {
        await fencePending(cachedFn, key);
        return expireCache({ options });
      }),
    );
  };

  return revalidate;
}
