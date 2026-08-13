import { hash } from "ohash";
import { resolveStorage } from "./storage.ts";

import type { StorageInterface, StorageOption } from "./storage.ts";
import type { HTTPEvent, CacheEntry, CacheOptions, CacheStatus } from "./types.ts";

function defaultCacheOptions() {
  return {
    name: "_",
    base: "/cache",
    swr: false,
    maxAge: 1,
  } as const;
}

/** Default deadline (seconds) on one shared resolution — the resolver plus `getMaxAge` and `serialize`. */
const DEFAULT_MAX_RESOLVE_TIME = 30;

type ResolvedCacheEntry<T> = CacheEntry<T> & { value: T; status: CacheStatus };

export type CachedFunction<T, ArgsT extends unknown[]> = {
  (...args: ArgsT): Promise<T>;
  /** Resolves all storage keys (one per base prefix) for the given arguments. */
  resolveKeys: (...args: ArgsT) => Promise<string[]>;
  /** Invalidates (removes) cached entries for the given arguments across all base prefixes. */
  invalidate: (...args: ArgsT) => Promise<void>;
  /** Marks cached entries as stale across all base prefixes. With SWR, stale values are still served (within `staleMaxAge`) while the next access triggers a background refresh. */
  expire: (...args: ArgsT) => Promise<void>;
};

/**
 * Wraps a function with caching support including TTL, SWR, integrity checks, and request deduplication.
 *
 * @param fn - The function to cache.
 * @param opts - Cache configuration options.
 * @returns A cached function with a `.resolveKey(...args)` method for cache key resolution.
 */
export function defineCachedFunction<T, ArgsT extends unknown[] = any[]>(
  fn: (...args: ArgsT) => T | Promise<T>,
  opts: CacheOptions<T, ArgsT> = {},
): CachedFunction<T, ArgsT> {
  // Resolve `name` from the caller's opts BEFORE merging defaults — see `resolveName`.
  const name = resolveName(opts.name, fn);
  // Keep a handle on the caller's own options object *before* the defaults merge clones
  // it: that object is the memo slot for the resolved storage, so a caller who hands the
  // same object to `invalidateCache`/`expireCache` reaches this instance's store (see
  // `resolveStorage`). The clone below is kept in sync as a mirror, since it is what the
  // `.invalidate()`/`.expire()` methods delegate with.
  const _optsRef = opts;
  // `definedOptions` first: an option explicitly set to `undefined` must read as unset, not
  // as "override the default with nothing". Applied to a *copy*, so `_optsRef` above is still
  // the caller's own object and the storage memo lands where the helpers can see it.
  opts = { ...defaultCacheOptions(), ...definedOptions(opts), name };

  // Storage is resolved on first actual read/write, never at definition time: the `storage`
  // option may be a factory precisely because the real backend is often only configured
  // after the module that defines this cached function has loaded. Unset means this
  // instance gets its *own* memory storage (no ambient global to collide on).
  const getStorage = (): StorageInterface => resolveStorage(_optsRef, opts);

  // Deduplicates concurrent resolutions for the same key. The shared result carries
  // the storable (post-`serialize`) value plus any dynamic TTL, so `getMaxAge` and
  // `serialize` run exactly once and every caller observes the same value.
  //
  // A `Map`, never a plain object: keys are caller-controlled (a documented `getKey`
  // may return an arbitrary string, e.g. `getKey: (id) => id`), and a plain object
  // inherits from `Object.prototype`, so `pending["constructor"]` / `"toString"` /
  // `"__proto__"` / … read truthy with nothing in flight. The call would then be
  // treated as a deduplicated follower, `await` the inherited member (not a thenable,
  // so it resolves to itself), and skip the resolver entirely — silently caching
  // `undefined`.
  const pending = new Map<string, Promise<{ value: T; maxAge?: number; staleMaxAge?: number }>>();

  // Normalize cache params
  const group = opts.group || "functions";
  const integrity = opts.integrity || hash([fn, integrityOpts(opts)]);
  const validate = opts.validate || ((entry) => entry.value !== undefined);
  // Seconds, like every other time-valued option here (`maxAge`, `staleMaxAge`, `getMaxAge`'s
  // return, the storage `ttl`) — the conversion to milliseconds happens at the `setTimeout`,
  // which is where `createMemoryStorage` does it too. A finite positive deadline arms the
  // timeout; `Infinity` / `0` / negative disable it — the normalization shape
  // `createMemoryStorage` uses for its own ceilings. Deliberately
  // NOT in `defaultCacheOptions()`: the default must not materialize as a key on `opts`, or
  // every entry written by an earlier ocache would go cold over a knob that says nothing
  // about the cached computation. Setting it explicitly does cost that one integrity change
  // (it stays in `integrityOpts` — it is not a storage-*location* field, and carving out an
  // exception for it would be the first).
  const rawMaxResolveTime = opts.maxResolveTime ?? DEFAULT_MAX_RESOLVE_TIME;
  const maxResolveTime =
    Number.isFinite(rawMaxResolveTime) && rawMaxResolveTime > 0 ? rawMaxResolveTime : undefined;
  const onError = (context: string, error: unknown) => {
    if (opts.onError) {
      opts.onError(error);
    } else {
      console.error(context, error);
    }
  };

  async function get(
    key: string,
    resolver: () => T | Promise<T>,
    args: ArgsT,
    shouldInvalidateCache?: boolean,
    event?: HTTPEvent,
  ): Promise<ResolvedCacheEntry<T>> {
    const validateCtx = { args };
    // Use extension for key to avoid conflicting with parent namespace (foo/bar and foo/bar/baz)
    const bases = normalizeBases(opts.base);

    let entry: CacheEntry<T> = {} as CacheEntry<T>;
    // Index of the base that had a cache hit (-1 = miss on all tiers)
    let hitIndex = -1;
    try {
      // Multi-tier read: try each base prefix in order, use first hit
      for (let i = 0; i < bases.length; i++) {
        const result = (await getStorage().get(
          buildCacheKey(key, { group, name }, bases[i]!),
        )) as CacheEntry<T> | null;
        if (result) {
          entry = result;
          hitIndex = i;
          break;
        }
      }
    } catch (error) {
      onError("[cache] Cache read error.", error);
    }

    // https://github.com/nitrojs/nitro/issues/2160
    if (typeof entry !== "object") {
      entry = {};
      const error = new Error("Malformed data read from cache.");
      onError("[cache]", error);
    } else {
      // Work on a per-call shallow clone: a storage backend may return the entry by
      // reference (the built-in memory storage does), so all subsequent in-place
      // mutations below — freshness resets, the `status` attach, the SWR value
      // refresh — must not corrupt the object still held in storage or let
      // concurrent same-key calls overwrite each other's per-call fields.
      entry = { ...entry };
    }

    // Per-entry TTL (set by the `getMaxAge` hook on the previous write) takes precedence over static options.
    const readMaxAge = entry.maxAge ?? opts.maxAge;
    const readStaleMaxAge = entry.staleMaxAge ?? opts.staleMaxAge;

    const ttl = (readMaxAge ?? 0) * 1000;
    if (ttl > 0) {
      entry.expires = Date.now() + ttl;
    }

    const staleTtl =
      opts.swr && readStaleMaxAge != null && readStaleMaxAge >= 0
        ? readStaleMaxAge * 1000
        : undefined;

    // A zero stale window means stale must never be served (e.g. upstream
    // proxy-revalidate semantics): revalidate in the foreground instead.
    const swr = opts.swr && staleTtl !== 0;

    // When staleMaxAge is set, an entry is completely dead after maxAge + staleMaxAge
    const isFullyExpired =
      staleTtl !== undefined &&
      readMaxAge != null &&
      Date.now() - (entry.mtime || 0) > ttl + staleTtl;

    // Computed once and reused for both the `expired` check and the `status`
    // decision below (same entry state, so re-validating would just repeat work).
    // `validate` may be async (e.g. checking the cached value against an external source),
    // so await it here. A sync return is fine too — `await` on a non-promise is a no-op.
    const _isValid = (await validate(entry, validateCtx)) !== false;

    const expired =
      shouldInvalidateCache ||
      entry.stale === true ||
      entry.integrity !== integrity ||
      readMaxAge === 0 ||
      (ttl > 0 && Date.now() - (entry.mtime || 0) > ttl) ||
      !_isValid;

    // If fully expired beyond staleMaxAge, clear the stale value so SWR won't serve it
    if (isFullyExpired) {
      entry.value = undefined;
      entry.integrity = undefined;
      entry.mtime = undefined;
      entry.expires = undefined;
    }

    // Determine how this call will be served (mirrors the serve decision below):
    // - no usable cached value -> resolved fresh (miss)
    // - fresh cached value -> hit
    // - expired but served stale under SWR -> stale
    // - a prior value existed but was expired/invalid and re-resolved in the
    //   foreground (no stale served) -> revalidated
    const status: CacheStatus =
      entry.value === undefined
        ? "miss"
        : !expired
          ? "hit"
          : swr && _isValid
            ? "stale"
            : "revalidated";

    const resolveEntry = async () => {
      const isPending = pending.has(key);
      if (!isPending) {
        if (entry.value !== undefined && (opts.staleMaxAge || 0) >= 0 && opts.swr === false) {
          // Remove cached entry to prevent using expired cache on concurrent requests
          entry.value = undefined;
          entry.integrity = undefined;
          entry.mtime = undefined;
          entry.expires = undefined;
        }
        // Resolve the value once and share it (plus any dynamic TTL and the
        // storable form) with all concurrent callers. `getMaxAge` and `serialize`
        // run exactly once here — critical for `serialize`, which may consume a
        // one-shot source (e.g. a `ReadableStream`).
        const resolution = (async () => {
          const value = await resolver();
          // Throwaway entry so the hooks can inspect resolution metadata.
          const resolvedEntry: CacheEntry<T> = { value, mtime: Date.now(), integrity };
          let maxAge: number | undefined;
          let staleMaxAge: number | undefined;
          // Derive per-entry lifetime from the resolved value, overriding static options for this write.
          if (opts.getMaxAge) {
            try {
              const resolved = await opts.getMaxAge(resolvedEntry);
              // A bare number is shorthand for `{ maxAge }`.
              const dynamic = typeof resolved === "number" ? { maxAge: resolved } : resolved;
              // Clamp to a non-negative TTL: a value <= 0 means "don't cache" (re-resolve every
              // access), never "cache forever as fresh". Non-finite (NaN) falls back to static options.
              maxAge = clampTtl(dynamic?.maxAge);
              staleMaxAge = clampTtl(dynamic?.staleMaxAge);
              resolvedEntry.maxAge = maxAge;
              resolvedEntry.staleMaxAge = staleMaxAge;
            } catch (error) {
              onError("[cache] getMaxAge hook error.", error);
            }
          }
          // Prepare the value for storage (write-side counterpart of `transform`).
          // Runs after `getMaxAge` so that hook still sees the raw resolved value.
          const stored = opts.serialize ? await opts.serialize(resolvedEntry, validateCtx) : value;
          return { value: stored, maxAge, staleMaxAge };
        })();
        // Bound the shared resolution (finding 03). Every other way this promise can end
        // already cleans the slot up — the auditor verified the resolve path, the reject path,
        // a throwing `getMaxAge`, a throwing `serialize` and a throwing `validate` — so a
        // promise that *never settles* was the one leak: the slot stayed occupied forever and
        // every later request for that key became a follower of a resolution that would never
        // finish. One hung upstream took the key down for the whole process.
        //
        // The deadline **rejects the waiters** rather than merely dropping the slot (the
        // finding's weaker "at minimum" option), for three reasons. A caller left awaiting a
        // resolution nobody will ever complete is not "served" — it holds its request open
        // until something outside kills it, which on a serverless runtime is nothing; the
        // whole write block below sits *after* this `await`, so a rejection also guarantees an
        // abandoned resolver that settles late can never write its long-dead value over an
        // entry a fresh leader has since resolved; and the fault becomes visible (thrown to
        // the caller, or reported through `onError` by the SWR handler) instead of presenting
        // as a hang. The cost is real and deliberate: an upstream that would have answered at
        // 31s now fails at 30s, which is why the default is generous and `0`/`Infinity` opts
        // out entirely.
        //
        // The slot is *not* additionally dropped from the timer callback: with the promise
        // guaranteed to settle, the existing lifecycle already frees it, and an independent
        // deletion would open a window in which a successor installs its own promise that
        // this leader's `catch` then deletes — splitting the dedup group it just left.
        //
        // Covers the hooks too, not just `resolver()`: `serialize` is where a never-ending
        // body is drained, so a deadline around the resolver alone would miss the measured case.
        pending.set(key, maxResolveTime ? withDeadline(resolution, maxResolveTime) : resolution);
      }

      let resolved: { value: T; maxAge?: number; staleMaxAge?: number };
      try {
        resolved = await pending.get(key)!;
      } catch (error) {
        // Make sure entries that reject get removed. A timed-out resolution (see the deadline
        // above) is a rejection in every respect, this eviction included: "the resolution
        // failed" already has exactly one meaning here, and giving the timeout its own
        // softer one would pre-empt the open question of whether evicting on failure is right
        // at all — a question that belongs to every arm of it at once, not to this one.
        if (!isPending) {
          pending.delete(key);
          // Evict stale entry from storage so SWR doesn't keep serving it
          const evictPromise = evictFromStorage(getStorage(), key, bases, group, name).catch(
            (error) => {
              onError("[cache] Cache eviction error.", error);
            },
          );
          event?.req.waitUntil?.(evictPromise);
        }
        // Re-throw error to make sure the caller knows the task failed.
        throw error;
      }

      // Every caller (leader + deduplicated followers) observes the same storable
      // value, so `transform` deserializes consistently on every path.
      entry.value = resolved.value;

      if (!isPending) {
        // Update mtime, integrity + validate and set the value in cache only the first time the request is made.
        entry.mtime = Date.now();
        entry.integrity = integrity;
        entry.stale = undefined;
        pending.delete(key);
        // Persist the per-entry lifetime derived by `getMaxAge` above, overriding static options for this write.
        if (opts.getMaxAge) {
          entry.maxAge = resolved.maxAge;
          entry.staleMaxAge = resolved.staleMaxAge;
        }
        // Storage options for this write — `false` when the entry must not be stored at all,
        // `undefined` when it is stored with no TTL (see `storageTtl`). Per-entry lifetimes
        // from `getMaxAge` take precedence over the static options, as on the read path above.
        const setOpts = storageTtl(
          entry.maxAge ?? opts.maxAge,
          entry.staleMaxAge ?? opts.staleMaxAge,
          opts.swr,
        );
        if ((await validate(entry, validateCtx)) !== false && setOpts !== false) {
          // Multi-tier write: only write to tiers up to the one that matched.
          // If no tier had a hit (hitIndex === -1), write to all tiers.
          // If tier N matched, write to tiers 0..N (promote upward + refresh hit tier).
          const writeBases = hitIndex < 0 ? bases : bases.slice(0, hitIndex + 1);
          // `status` is a per-call field — never persist it to storage.
          const { status: _status, ...toStore } = entry;
          const promise = (async () => {
            try {
              await Promise.all(
                writeBases.map((b) =>
                  getStorage().set(buildCacheKey(key, { group, name }, b), toStore, setOpts),
                ),
              );
            } catch (error) {
              onError("[cache] Cache write error.", error);
            }
          })();
          event?.req.waitUntil?.(promise);
        } else if (hitIndex >= 0) {
          // A prior cached entry existed but this resolution isn't storable — `validate`
          // refused it, or it has no lifetime at all (`storageTtl` → `false`). Evict it
          // so SWR doesn't keep serving the stale value, which also clears out entries an
          // older ocache wrote with no expiry and no TTL. When there was no cache hit
          // (hitIndex === -1) nothing is stored, so skip the redundant delete (e.g. a handler
          // returning `Cache-Control: no-store`/`private` on every request).
          const evictPromise = evictFromStorage(getStorage(), key, bases, group, name).catch(
            (error) => {
              onError("[cache] Cache eviction error.", error);
            },
          );
          event?.req.waitUntil?.(evictPromise);
        }
      }
    };

    const _resolvePromise = expired ? resolveEntry() : Promise.resolve();

    if (entry.value === undefined) {
      await _resolvePromise;
    } else if (expired) {
      event?.req.waitUntil?.(_resolvePromise);
    }

    // Attach the per-call `status` to `entry`. `entry` is a per-call clone (see the
    // read path above), never the object a ref-sharing storage backend still holds,
    // so this can't corrupt shared state or race with concurrent same-key calls. It's
    // still marked NON-ENUMERABLE as defence-in-depth so it stays out of every
    // persistence path (object spreads, JSON/structuredClone). It is attached to the live
    // clone rather than to a fresh return-time copy, so an SWR revalidation that completes
    // while this call is still in the serve path is reflected in the returned value — which
    // no longer happens for a *sync* resolver, whose shared promise now carries the
    // `maxResolveTime` deadline and settles a microtask later than the serve path reads it.
    // That was always a tick-count accident: an async resolver never made it in time, so SWR
    // now serves the stale value for both, which is what SWR means.
    Object.defineProperty(entry, "status", {
      value: status,
      enumerable: false,
      writable: true,
      configurable: true,
    });

    if (swr && (await validate(entry, validateCtx)) !== false) {
      _resolvePromise.catch((error) => {
        onError("[cache] SWR handler error.", error);
      });
      return entry as ResolvedCacheEntry<T>;
    }

    return _resolvePromise.then(() => entry) as Promise<ResolvedCacheEntry<T>>;
  }

  const cachedFn = async (...args: ArgsT) => {
    const shouldBypassCache = await opts.shouldBypassCache?.(...args);
    if (shouldBypassCache) {
      return fn(...args);
    }
    const key = await (opts.getKey || getKey)(...args);
    const shouldInvalidateCache = await opts.shouldInvalidateCache?.(...args);
    const entry = await get(
      key,
      () => fn(...args),
      args,
      shouldInvalidateCache,
      isHTTPEvent(args[0]) ? args[0] : undefined,
    );
    let value = entry.value;
    if (opts.transform) {
      value = (await opts.transform(entry, ...args)) || value;
    }
    return value;
  };

  cachedFn.resolveKeys = (...args: ArgsT) => resolveCacheKeys({ options: opts, args });
  // Resolve storage before delegating: `opts` may still hold an unresolved factory (or
  // nothing at all) when a purge is issued before the first cached call, and the helpers
  // would then resolve a *different* store and silently no-op. `getStorage` memoizes
  // into `opts`, so both paths end up on this instance's backend either way.
  cachedFn.invalidate = (...args: ArgsT) => {
    getStorage();
    return invalidateCache({ options: opts, args });
  };
  cachedFn.expire = (...args: ArgsT) => {
    getStorage();
    return expireCache({ options: opts, args });
  };

  return cachedFn;
}

/** Alias for {@link defineCachedFunction}. */
export const cachedFunction = defineCachedFunction;

// --- Public helpers ---

/**
 * Resolves all cache storage keys (one per base prefix) for given arguments and cache options.
 *
 * Uses the same key derivation as `defineCachedFunction` internally:
 * - When `opts.getKey` is provided, it is called with `args` to produce the key segment.
 * - Otherwise, `args` are hashed with `ohash` (same default as `defineCachedFunction`).
 *
 * Pass the same `getKey`, `name`, `group`, and `base` options you use in
 * `defineCachedFunction` / `defineCachedHandler` to get the exact storage keys.
 *
 * @param input - Object with `options` (cache options) and optional `args` (function arguments).
 * @returns An array of storage key strings (one per base prefix).
 *
 * @example
 * ```ts
 * const storage = createMemoryStorage();
 * const fn = cachedFunction(fetchUser, { name: "fetchUser", getKey: (id: string) => id, storage });
 *
 * const keys = await resolveCacheKeys({
 *   options: { name: "fetchUser", getKey: (id: string) => id },
 *   args: ["user-123"],
 * });
 * for (const key of keys) {
 *   await storage.set(key, null); // invalidate all tiers
 * }
 * ```
 */
export async function resolveCacheKeys<ArgsT extends unknown[] = any[]>(
  input: {
    options?: Pick<CacheOptions<any, ArgsT>, "base" | "group" | "name" | "getKey">;
    args?: ArgsT;
  } = {},
): Promise<string[]> {
  const opts = input.options ?? {};
  const args = input.args ?? ([] as unknown as ArgsT);
  const key = await (opts.getKey || getKey)(...args);
  return normalizeBases(opts.base).map((base) => buildCacheKey(key, opts, base));
}

/**
 * Invalidates (removes) cached entries for given arguments and cache options across all base prefixes.
 *
 * Uses the same key derivation as `defineCachedFunction` / `resolveCacheKeys`.
 *
 * Targets `options.storage` — pass the same backend (or, better, the very same options
 * object you cached with, whose resolved storage is memoized on it) the entries were
 * written to. **Throws** if `storage` is unset: there is no global store to fall back on,
 * so the call could only purge a fresh empty one while the stale entry kept being served.
 * A mismatched `name`/`getKey` still purges nothing silently. When the cached function is
 * at hand, prefer its own `.invalidate(...args)`.
 *
 * @param input - Object with `options` (cache options) and optional `args` (function arguments).
 *
 * @example
 * ```ts
 * // Invalidate a specific cached entry
 * await invalidateCache({
 *   options: { name: "fetchUser", getKey: (id: string) => id, storage },
 *   args: ["user-123"],
 * });
 * ```
 */
export async function invalidateCache<ArgsT extends unknown[] = any[]>(
  input: {
    options?: Pick<CacheOptions<any, ArgsT>, "base" | "group" | "name" | "getKey" | "storage">;
    args?: ArgsT;
  } = {},
): Promise<void> {
  const keys = await resolveCacheKeys(input);
  const storage = requireStorage(input.options, "invalidateCache");
  await Promise.all(keys.map((key) => storage.set(key, null)));
}

/**
 * Expires cached entries for given arguments and cache options across all base prefixes,
 * without removing them.
 *
 * Unlike {@link invalidateCache} (which removes entries entirely), expired entries keep
 * serving the stale value with SWR — still bounded by the originally configured
 * `staleMaxAge` window — while the next access triggers a background refresh.
 * Without SWR, the next call re-resolves before returning.
 *
 * Uses the same key derivation as `defineCachedFunction` / `resolveCacheKeys`.
 * Pass the same `maxAge` / `swr` / `staleMaxAge` options you cache with so the
 * remaining storage TTL is preserved.
 *
 * Targets `options.storage` with the same rule as {@link invalidateCache}: **throws** if
 * `storage` is unset, since there is no global store to fall back on.
 *
 * @param input - Object with `options` (cache options) and optional `args` (function arguments).
 *
 * @example
 * ```ts
 * // Mark a cached entry for background refresh on next access
 * await expireCache({
 *   options: { name: "fetchUser", getKey: (id: string) => id, maxAge: 60, staleMaxAge: 300, storage },
 *   args: ["user-123"],
 * });
 * ```
 */
export async function expireCache<ArgsT extends unknown[] = any[]>(
  input: {
    options?: Pick<
      CacheOptions<any, ArgsT>,
      "base" | "group" | "name" | "getKey" | "maxAge" | "swr" | "staleMaxAge" | "storage"
    >;
    args?: ArgsT;
  } = {},
): Promise<void> {
  const opts = input.options ?? {};
  const keys = await resolveCacheKeys(input);
  const storage = requireStorage(opts, "expireCache");
  await Promise.all(
    keys.map(async (key) => {
      const entry = (await storage.get(key)) as CacheEntry | null;
      if (!entry || typeof entry !== "object" || entry.value === undefined) {
        return;
      }
      await storage.set(key, { ...entry, stale: true }, remainingTtl(entry, opts));
    }),
  );
}

// --- Internal helpers ---

// Cache-key `name` resolution, shared by `defineCachedFunction` and `defineCachedHandler`
// (which passes the wrapped `EventHandler` as `fn`) so the two paths cannot drift.
// Deliberately commented with `//`, not JSDoc, so docs4ts keeps it out of the API docs.
//
// MUST be called on the *caller's* options, BEFORE `defaultCacheOptions()` is merged in:
// those defaults set a truthy `name: "_"`, so merging first makes `opts.name` always `"_"`
// and the `fn.name` fallback dead code — a silent cache-key collision across every unnamed
// cached function/handler (https://github.com/unjs/ocache/issues/53). `defineCachedHandler`
// merged its defaults first and so shipped exactly that bug for handlers: every handler
// keyed as `_`, and two handlers sharing one `storage` (the configuration the `storage`
// docs recommend) either thrashed each other's entries or — when their sources match, so
// the integrity hash matches too — served each other's cached responses.
//
// For anonymous functions (no `opts.name`, no `fn.name`) fall back to a hash of the
// function source instead of a shared literal: two distinct inline arrows would
// otherwise resolve to the same key and thrash each other (each read fails the
// integrity check and re-resolves). A source hash is the right fallback precisely because
// it is *stable* — keys must survive a process restart for persistent/shared backends, so
// nothing per-instance (counter, WeakMap, randomness) is admissible here. The cost is that
// it can't disambiguate same-source functions that only differ by closed-over variables
// (the classic factory: `const make = (t) => defineCachedHandler(() => render(t))`) — pass
// an explicit `name`/`getKey` for those. The integrity hash collides there too, so it is
// unfixable from the source alone, and with a shared `storage` it is a cross-instance leak
// rather than mere thrash.
export function resolveName(name: string | undefined, fn: (...args: any[]) => any): string {
  return name || fn.name || `anon_${hash(fn).slice(0, 16)}`;
}

// Drops own properties whose value is `undefined`, so an option explicitly set to `undefined`
// is indistinguishable from an absent one. Shared by both defaults merges (`defineCachedFunction`
// here and `resolveHandlerConfig` in `http/config.ts`) so the two can't drift.
//
// Object spread copies own properties *including* undefined-valued ones, so
// `{ ...defaults(), ...opts }` let `{ maxAge: undefined }` clobber the `maxAge: 1` default
// while `{}` kept it. That spelling is what plumbing produces, never what anyone types —
// `defineCachedHandler(h, { maxAge: routeConfig.maxAge })` with an unset rule — and the route
// then silently stopped caching entirely (before finding 10.6 it silently cached *forever*:
// same divergence, opposite harm). Applies to every option, not just the lifetimes:
// `swr`/`staleMaxAge`/`storage`/`getKey`/`varies` all had the same shape.
//
// Idempotent, which is what makes the handler path safe: it merges twice (here, then again
// when `defineCachedHandler` hands its `_opts` to `cachedFunction`), and the second pass only
// ever sees an already-cleaned object plus the hooks `http/index.ts` sets itself — of which
// `transform: undefined` ("no cache-status header") is the one undefined-valued key, dropped
// to no effect since the defaults name no `transform` to restore.
//
// Only `undefined` is dropped; `null` is left as the caller wrote it. Returns a fresh object —
// the caller's own options object is never mutated (it is the storage memo slot, see
// `resolveStorage`), and the copy keeps symbol keys, exactly as a spread would.
//
// Costs one integrity hash: ohash walks an undefined-valued key, so an options object that
// carries one hashes differently once the key is gone. That is exactly the set of configs this
// fixes, and the effect is a single cold read per entry.
export function definedOptions<T extends object>(opts: T): T {
  const cleaned = { ...opts } as Record<string, unknown>;
  for (const key of Object.keys(cleaned)) {
    if (cleaned[key] === undefined) {
      delete cleaned[key];
    }
  }
  return cleaned as T;
}

// Storage for the standalone purge helpers, which — unlike `resolveCacheKeys` (pure key
// derivation, no storage) — are useless without the backend the entries were written to.
// Since storage became per-instance there is no ambient store to fall back on, so an unset
// `storage` used to resolve a *fresh empty* one: the purge found nothing, reported success,
// and the stale entry kept being served. That silent no-op is the whole hazard, so it is an
// error instead. Both valid paths leave `storage` set, so this only ever fires on a genuine
// mistake: the cached function's own `.invalidate()`/`.expire()` (and `defineCachedHandler`'s
// event-scoped variants) resolve it before delegating, and a caller reaching for these
// helpers directly either passes an explicit shared backend or hands over the very options
// object they cached with, onto which the resolved storage was memoized.
function requireStorage(
  options: { storage?: StorageOption } | undefined,
  caller: string,
): StorageInterface {
  if (!options?.storage) {
    throw new Error(`[ocache] ${caller}() requires \`options.storage\``);
  }
  return resolveStorage(options);
}

// Rejects with a `TimeoutError` if `work` hasn't settled within `seconds`, so a resolution
// that never settles cannot pin its `pending` slot forever (finding 03 — see the call site
// for why the waiters are rejected rather than merely released). Seconds in, milliseconds
// converted at the timer, exactly as `createMemoryStorage` treats its `ttl`.
//
// `work` is *not* cancelled: there is no cancellation to reach for (the resolver is the
// caller's `fn`, invoked with the caller's arguments, and nothing here has an `AbortSignal`
// to hand it). It keeps running, its hooks may still run, and it may still settle late — but
// only into a promise nobody awaits any more, so a late settle can neither be served nor
// written to storage.
//
// The timer is cleared on *every* settle path, or a long-lived process accumulates one live
// timer per resolution — a rejecting `work` included, which is why the handler is attached as
// `.then(f, f)` and not as a `.finally` (whose returned promise would reject with nothing
// listening) or a lone `.then`. A late settle lands on those same handlers, so it is absorbed
// here rather than surfacing as an unhandled rejection.
//
// Hand-built rather than `Promise.race([...])`, which adopts a promise arm at a cost of two
// further microtask ticks. Ticks are not free here: how quickly a resolution lands on
// `entry.value` decides whether a background refresh is visible to the call it was triggered
// by. One tick is unavoidable and does change that for a *sync* resolver under SWR (see the
// `status` attach below); three would be gratuitous.
function withDeadline<T>(work: Promise<T>, seconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Reported in the unit the caller configured, never the converted milliseconds.
      const error = new Error(`[cache] Resolver timed out after ${seconds}s.`);
      // The name the platform gives this failure (`AbortSignal.timeout()`), so a caller can
      // tell a deadline apart from a resolver's own error without a class to import.
      error.name = "TimeoutError";
      reject(error);
    }, seconds * 1000);
    // Allow the process to exit even if a deadline is pending (as the memory storage does).
    if (timer && typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isHTTPEvent(input: unknown): input is HTTPEvent {
  return (input as any)?.req instanceof Request;
}

/** Normalizes a dynamic TTL: clamps negatives to 0, treats nullish/non-finite as "unset" (static fallback). */
function clampTtl(value: number | undefined): number | undefined {
  return value == null || !Number.isFinite(value) ? undefined : Math.max(0, value);
}

function getKey(...args: unknown[]) {
  return args.length > 0 ? hash(args) : "";
}

function buildCacheKey(
  key: string,
  opts: Pick<CacheOptions, "group" | "name">,
  base: string,
): string {
  const group = opts.group || "functions";
  // Escaped like every other segment: `name` is the one that used to reach the key raw, and it
  // stopped being a controlled alphabet once it started coming from `fn.name` (see `resolveName`).
  const name = escapeKeySegment(opts.name || "_");
  return [base, group, name, key + ".json"].filter(Boolean).join(":").replace(/:\/$/, ":index");
}

// A storage-safe segment of the `:`-joined key. Non-word characters are dropped, which is lossy,
// so a segment the escape changed also carries a hash of the raw value: `.` occurs only in that
// hashed form, so the two forms can never overlap and two raws that escape alike (`a:bc` /
// `ab:c`) stay distinct. Ordinary identifier characters come back byte-identical, so escaping
// this late costs no existing entry its key. Shared by the `name` segment here and a custom
// `getKey` in `http/key.ts`, which needs the same treatment for the same reason. Commented with
// `//`, not JSDoc, so docs4ts keeps it out of the API docs.
export function escapeKeySegment(raw: string): string {
  const escaped = escapeKey(raw);
  return escaped === raw ? escaped : `${escaped.slice(0, 64)}.${hash(raw)}`;
}

// Drops everything outside `[A-Za-z0-9_]` from a key segment. Lossy on purpose — see
// `escapeKeySegment`, which is what callers composing a `:`-joined key should reach for.
export function escapeKey(key: string | string[]): string {
  return String(key).replace(/\W/g, "");
}

function normalizeBases(base: CacheOptions["base"]): [string, ...string[]] {
  if (Array.isArray(base)) return base as [string, ...string[]];
  return [base ?? "/cache"];
}

async function evictFromStorage(
  storage: StorageInterface,
  key: string,
  bases: string[],
  group: string,
  name: string,
) {
  await Promise.all(bases.map((b) => storage.set(buildCacheKey(key, { group, name }, b), null)));
}

// The storage options a write gets: `{ ttl }`, `undefined` for "store it, with no storage
// TTL", or `false` for "do not store it at all". One helper, so the write path and
// `remainingTtl` (which rewrites an entry on the `expireCache` path) cannot drift.
//
// The rule is **never persist an entry that has neither an expiry nor a storage TTL** — such
// an entry is unservable-as-fresh *and* unreclaimable, a permanent HIT indistinguishable from
// a leak (finding 10.6). The two shapes that look alike under it are genuinely different and
// must stay distinguished:
//
// - `{ swr: true, maxAge: 60 }` -> the entry HAS an expiry (`entry.expires`, from `maxAge`)
//   and deliberately no TTL. It is merely *retained* past the moment it goes stale, which is
//   the whole of ISR: the last good value keeps being served while a background refresh
//   replaces it, and a *failed* refresh keeps serving the last success. `revalidate` marks an
//   entry eligible for regeneration; it never deletes it. **Allowed.** Do not "fix" this into
//   a `maxAge` TTL (finding 14.3's proposed fix): the entry would be dropped at the exact
//   moment it went stale, so SWR would degrade to foreground revalidation and nothing would
//   ever be served stale. The bound on this shape is the storage backend's *capacity*
//   (finding 14.1's byte budget) — never a timer.
// - `{ maxAge: 0 }` (or a `getMaxAge` clamped to it) -> neither an expiry nor a TTL: the read
//   path treats it as expired on arrival, so the entry could never be served, only purged by
//   hand. **Refused**, and a prior entry on that key is evicted instead (which also clears out
//   what an older ocache left behind). A nullish `maxAge` is refused with it — unreachable
//   from the two defaults merges (they always supply `maxAge: 1`, and `definedOptions` means
//   an explicit `undefined` no longer defeats that), but reachable through the standalone
//   `expireCache`, which merges nothing. It is also why `swr` with no `maxAge` needs no special
//   case of its own: there is no such configuration to normalize.
//
// `!swr` rather than `swr === false` so an unset `swr` aligns with the SWR-off default on the
// standalone `expireCache` path, which doesn't merge `defaultCacheOptions`. A negative
// `staleMaxAge` states no window and is treated as unset.
function storageTtl(
  maxAge: number | undefined,
  staleMaxAge: number | undefined,
  swr: boolean | undefined,
): { ttl: number } | undefined | false {
  if (maxAge == null || maxAge <= 0) {
    return false;
  }
  if (!swr) {
    return { ttl: maxAge };
  }
  // Under SWR a TTL has to cover the whole window the entry may still be served in; with no
  // stale window named there is no such moment, so no TTL is armed (the ISR shape above).
  return staleMaxAge != null && staleMaxAge >= 0 ? { ttl: maxAge + staleMaxAge } : undefined;
}

/** Computes remaining storage TTL (seconds) so expiring an entry doesn't extend its original lifetime. */
function remainingTtl(
  entry: CacheEntry,
  opts: Pick<CacheOptions, "maxAge" | "swr" | "staleMaxAge">,
): { ttl: number } | undefined {
  // The same decision the write path makes (`storageTtl`), so expiring an entry can neither
  // extend its lifetime nor strip a TTL off it — nor arm one the write deliberately withheld,
  // which would delete the ISR entry the moment it goes stale. Prefers the per-entry values
  // `getMaxAge` persisted, falling back to static options.
  const ttlOpts = storageTtl(
    entry.maxAge ?? opts.maxAge,
    entry.staleMaxAge ?? opts.staleMaxAge,
    opts.swr,
  );
  if (!entry.mtime || !ttlOpts) {
    return undefined;
  }
  return { ttl: Math.max(Math.ceil((entry.mtime + ttlOpts.ttl * 1000 - Date.now()) / 1000), 1) };
}

/**
 * Strips storage-location fields from opts so integrity only reflects the cached computation.
 *
 * `storage` belongs in that set for the same reason as `base`/`group`/`name`: it says
 * *where* entries live, not what they contain, so pointing an instance at a different
 * backend must not invalidate the entries already there. Hashing it would also be
 * meaningless and expensive — ohash walks a storage object's methods as source text, so
 * two `createMemoryStorage()` instances hash identically (including different `maxSize`,
 * a closure variable) while a factory vs. a ready instance hash differently: an integrity
 * change on a purely cosmetic config edit.
 */
function integrityOpts(
  opts: CacheOptions<any, any>,
): Omit<CacheOptions, "base" | "group" | "name" | "storage"> {
  const { base: _, group: _g, name: _n, storage: _s, ...rest } = opts;
  return rest;
}
