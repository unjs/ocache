// HTTP response caching: wires this directory's modules onto `cache.ts`'s `cachedFunction`.
// Holds only the wiring — the `CacheOptions` hooks, the resolver, the serve path and the
// revalidation helpers.

import { hash } from "ohash";
import { cachedFunction, expireCache, invalidateCache, resolveCacheKeys } from "../cache.ts";
import { resolveStorage } from "../storage.ts";

import { requiresRevalidation } from "./cache-control.ts";
import { integrityOpts, resolveHandlerConfig } from "./config.ts";
import { defaultHandleCacheHeaders, notModifiedHeaders } from "./conditional.ts";
import { deserializeEntry, serializeResponse } from "./entry.ts";
import { cacheableMethods, methodKey, resolveKey } from "./key.ts";
import { narrowRequest, resolveBypass } from "./request.ts";
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
 * Wraps an HTTP event handler with response caching: keys by request origin, path, varied
 * headers and method, synthesizes `cache-control`/`etag`/`last-modified`, and answers `304`.
 *
 * Only `GET`/`HEAD` without a `Range` header is cacheable (everything else passes through
 * untouched), only `200`/`203`/`301`/`308` is stored, and a response opting itself out
 * (`no-store`, `private`, `no-cache`, zero shared lifetime, `Vary: *`) is served but never
 * stored — nor is one whose own `Vary` names a header outside `varies`, which a single entry
 * cannot honor. `must-revalidate` is not an opt-out — stored, served fresh, never served stale.
 *
 * @param handler - The event handler to cache.
 * @param opts - Cache and HTTP-specific configuration options.
 * @returns A cached event handler, also exposing `.resolveKeys(event)`, `.invalidate(event)`
 *   and `.expire(event)` — keyed exactly as it caches, covering every method variant.
 */
export function defineCachedHandler<E extends HTTPEvent = HTTPEvent>(
  handler: EventHandler<E>,
  opts: CachedEventHandlerOptions<E> = {},
): CachedEventHandler<E> {
  // Merged options (`name` resolved before the defaults merge — see `config.ts`) plus the
  // shared cookie/query/header lists. `opts` is rebound so every module reads the same
  // object; the caller's own object is never written to (storage-memo note in AGENTS.md).
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

  // The resolver returns a live `Response` (hence `T`), `serialize` turns it into the stored
  // `ResponseCacheEntry`, and `transform` reads that entry back on serve — so `entry.value`
  // holds the serialized shape once stored (the looseness `transform` already relies on).
  const _opts: CacheOptions<Response> = {
    ...opts,
    // Inject the cache-status header into a cloned entry value (never mutating the
    // stored entry) so it flows through to the final Response headers.
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
    // Per-entry lifetime, wrapping the caller's `getMaxAge` to honor `must-revalidate` —
    // which constrains *stale* serving, not storage (RFC 9111 §5.2.2.2), hence
    // `staleMaxAge: 0`: `cache.ts` reads that as `swr = false` for this entry alone, so a
    // fresh read still HITs and an expired one revalidates in the foreground. Our override is
    // computed first and the caller's hook isolated in its own `try`, since `cache.ts` drops
    // *both* values on a throw — which used to take our `staleMaxAge: 0` down with it.
    getMaxAge: async (entry) => {
      const res = entry.value;
      // Headers only — the body is read exactly once, by `serialize`, which runs after this.
      const override =
        res instanceof Response && requiresRevalidation(res.headers.get("cache-control"))
          ? { staleMaxAge: 0 }
          : undefined;
      let dynamic: { maxAge?: number; staleMaxAge?: number } | undefined;
      try {
        const resolved = await opts.getMaxAge?.(entry);
        // Normalize the caller's shorthand so the override below can merge with it.
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
    // Write-side seam (see `entry.ts`): consume the body, synthesize the cache headers, build
    // the entry. Runs once per resolution, and outside the resolver so bypassed requests —
    // which never reach it — get their live `Response` back untouched. Handed the whole entry,
    // not just its `Response`: the lifetimes it advertises are the ones the hook above just
    // resolved onto it.
    serialize: (entry) => serializeResponse(config, entry),
    // The built-in bypass composed with the caller's check (see `request.ts`). The single
    // evaluation of that composition per call: `cache.ts` short-circuits to the raw resolver
    // on `true`, and the resolver's narrowing reads the same memoized verdict.
    shouldBypassCache: (event: HTTPEvent) => resolveBypass(config, event),
    // Key = resource identity + method component; see `key.ts` for both halves.
    getKey: async (event: HTTPEvent) =>
      methodKey(await resolveKey(config, event), event.req.method),
    // Always inspects the serialized shape: on write right after `serialize`, on read the
    // entry as persisted.
    validate: (entry) => validateEntry(config, entry.value as unknown as ResponseCacheEntry),
    group: opts.group || "handlers",
    integrity: opts.integrity || hash([handler, integrityOpts(opts)]),
  };

  // Resolver: narrow the request (cacheable calls only), run the handler, return the *live*
  // `Response`. Serialization happens in the `serialize` hook above, which a bypassed
  // request skips entirely — so it flows back out untouched.
  const cachedFn = cachedFunction<Response>(async (event: HTTPEvent) => {
    // Cacheable calls only — `narrowRequest` gates itself on the composed bypass verdict, so
    // a request the caller excluded reaches the handler with its credentials and query intact.
    narrowRequest(config, event);

    // Call handler
    const rawValue = await handler(event as E);
    return toResponse(rawValue, event as E);
  }, _opts);

  const cachedHandler: EventHandler<E> = async (event) => {
    // Headers-only mode
    if (opts.headersOnly) {
      if (handleCacheHeaders(event, { maxAge: opts.maxAge })) {
        return createResponse(null, { status: 304 });
      }
      return handler(event);
    }

    // Call with cache
    const cached = (await cachedFn(event))! as Response | ResponseCacheEntry;

    // A bypassed request resolves to the handler's live `Response` (no `serialize`/
    // `transform`). Pass it straight through: no body buffering (streams and binary bodies
    // survive), no synthesized cache headers, no bogus 304 for a non-cacheable method.
    if (cached instanceof Response) {
      return cached;
    }
    const response = cached;

    // Check for cache headers
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

    // Send Response — the read half of the codec (null-body statuses, binary decode) lives
    // in `entry.ts`, next to the write half it mirrors.
    const { body, init } = deserializeEntry(response);
    return createResponse(body, init);
  };

  // On-demand revalidation from the event itself, without reconstructing the escaped key
  // (issue #71). Targets the *resource*: every method variant is covered whichever method the
  // event carries, so a purge can't leave a sibling HEAD entry advertising the dead etag —
  // the event's own variant first, so `resolveKeys()[0]` is the key it reads and writes.
  const variantOptions = async (event: E) => {
    // Each variant spreads `_opts` into a *fresh* object, so resolve the storage first:
    // otherwise a purge issued before the first request leaves every copy to build its own
    // default memory storage and silently no-op.
    resolveStorage(_opts);
    const key = await resolveKey(config, event);
    const methods = cacheableMethods.includes(event.req.method)
      ? [event.req.method, ...cacheableMethods.filter((m) => m !== event.req.method)]
      : // A non-cacheable event (e.g. a POST webhook trigger) has no variant of its own.
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
