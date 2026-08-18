// Docs: @docs/2.functions.md, @docs/4.invalidation.md, @docs/9.isr.md

import { base64ToBytes, bytesToBase64 } from "./base64.ts";
import { malformedEntryError, storageRequiredError, timeoutError } from "./error.ts";
import { hash } from "./hash.ts";
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

/** Default deadline for the resolver and its hooks, in seconds. */
const DEFAULT_MAX_RESOLVE_TIME = 30;

type ResolvedCacheEntry<T> = CacheEntry<T> & { value: T; status: CacheStatus };

type PendingResolution<T> = {
  promise: Promise<{ value: T; maxAge?: number; staleMaxAge?: number }>;
  /** Set when a purge ran while this resolution was in flight. */
  fenced?: boolean;
};

// A purge must reach the in-flight resolutions of the instance it targets.
// This registry keeps that channel off the public `CachedFunction` type.
// Allocated on the first definition, so importing the module allocates nothing.
let fences: WeakMap<object, (key: string) => Promise<void> | undefined> | undefined;

// The narrowed request of a resolution carries that resolution's deadline signal.
// This registry keeps that channel off the resolver signature, which passes only the
// caller's arguments. Allocated on the first deadline, like `fences`.
let resolveSignals: WeakMap<HTTPEvent, AbortSignal> | undefined;

/** The deadline signal of the resolution this event leads, if it leads one. */
export function resolveSignal(event: HTTPEvent): AbortSignal | undefined {
  return resolveSignals?.get(event);
}

// Stops in-flight resolutions for `key` from writing after a purge.
// Await the result: a write that already reached storage cannot be fenced, so the
// purge must land after it.
export function fencePending(cachedFn: object, key: string): Promise<void> | void {
  return fences?.get(cachedFn)?.(key);
}

export type CachedFunction<T, ArgsT extends unknown[]> = {
  (...args: ArgsT): Promise<T>;
  /** Returns one storage key per base prefix. */
  resolveKeys: (...args: ArgsT) => Promise<string[]>;
  /** Removes matching entries from all base prefixes. */
  invalidate: (...args: ArgsT) => Promise<void>;
  /** Marks matching entries as stale in all base prefixes. */
  expire: (...args: ArgsT) => Promise<void>;
};

/**
 * Wraps a function with caching, SWR, integrity checks, and request deduplication.
 *
 * @param fn - Function to cache.
 * @param opts - Cache options.
 * @returns The cached function and its cache management methods.
 */
export function defineCachedFunction<T, ArgsT extends unknown[] = any[]>(
  fn: (...args: ArgsT) => T | Promise<T>,
  opts: CacheOptions<T, ArgsT> = {},
): CachedFunction<T, ArgsT> {
  // Resolve the name before defaults because the default name would hide the function name.
  const name = resolveName(opts.name, fn);
  // Storage resolution writes the instance to the caller's options object.
  const _optsRef = opts;
  // Explicit `undefined` values do not override defaults.
  opts = { ...defaultCacheOptions(), ...definedOptions(opts), name };

  // Resolve factories on first use and create one default store per cached function.
  const getStorage = (): StorageInterface => resolveStorage(_optsRef, opts);

  // A Map prevents user-controlled keys from reading Object prototype members.
  const pending = new Map<string, PendingResolution<T>>();

  // Release a slot only while it still belongs to this resolution.
  const releasePending = (key: string, current: PendingResolution<T>) => {
    if (pending.get(key) === current) {
      pending.delete(key);
    }
  };

  // Writes that already reached storage, per key. A purge waits for these so a slow
  // backend cannot land a pre-purge value after the purge removed the key.
  // TODO: this orders writes against purges within one process only. A backend shared
  // across processes needs generation/CAS support in `StorageInterface` to be correct.
  const writes = new Map<string, Promise<void>>();

  // Register a started write and resolve once it and every earlier write for the key land.
  const trackWrite = (key: string, write: Promise<void>) => {
    const earlier = writes.get(key);
    const tracked = earlier ? earlier.then(() => write) : write;
    writes.set(key, tracked);
    void tracked.then(() => {
      if (writes.get(key) === tracked) {
        writes.delete(key);
      }
    });
    return tracked;
  };

  // Resolve settings shared by every call.
  const group = opts.group || "functions";
  const integrity = opts.integrity || hash([fn, integrityOpts(opts)]);
  const validate = opts.validate || ((entry) => entry.value !== undefined);
  // Keep the default outside `defaultCacheOptions` to preserve existing integrity hashes.
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
    // One owner for background work: the explicit hook, else the event's host hook.
    // Never both, so a promise is registered once. A cached function has no event.
    const waitUntil = (promise: Promise<unknown>) => {
      if (opts.waitUntil) {
        opts.waitUntil(promise);
      } else {
        event?.req.waitUntil?.(promise);
      }
    };
    // The extension separates a key from a parent namespace with the same prefix.
    const bases = normalizeBases(opts.base);

    let entry: CacheEntry<T> = {} as CacheEntry<T>;
    // A negative index means that all storage tiers missed.
    let hitIndex = -1;
    try {
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
      const error = malformedEntryError();
      onError("[cache]", error);
    } else {
      // Clone entries because a backend may return a shared object reference.
      entry = { ...entry };
      // Undo the stored form before anything reads the value, including `validate`.
      decodeBinary(entry);
      // A codec has already consumed this marker; like `encoding` it describes storage.
      entry.payload = undefined;
    }

    // Per-entry lifetimes override static options.
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

    // A zero stale window requires foreground revalidation.
    const swr = opts.swr && staleTtl !== 0;

    const isFullyExpired =
      staleTtl !== undefined &&
      readMaxAge != null &&
      Date.now() - (entry.mtime || 0) > ttl + staleTtl;

    // Run asynchronous validation once per read.
    const _isValid = (await validate(entry, validateCtx)) !== false;

    // A mismatch means the entry belongs to another function, so it is unusable, not stale.
    const isMatched = entry.integrity === integrity;

    const expired =
      shouldInvalidateCache ||
      entry.stale === true ||
      !isMatched ||
      readMaxAge === 0 ||
      (ttl > 0 && Date.now() - (entry.mtime || 0) > ttl) ||
      !_isValid;

    // Remove values that are older than the complete stale window.
    if (isFullyExpired) {
      entry.value = undefined;
      entry.integrity = undefined;
      entry.mtime = undefined;
      entry.expires = undefined;
    }

    // This status must match the serve decision below.
    const status: CacheStatus =
      entry.value === undefined
        ? "miss"
        : !expired
          ? "hit"
          : swr && _isValid && isMatched
            ? "stale"
            : "revalidated";

    const resolveEntry = async () => {
      let current = pending.get(key);
      const isPending = current !== undefined;
      if (!current) {
        if (entry.value !== undefined && (opts.staleMaxAge || 0) >= 0 && opts.swr === false) {
          entry.value = undefined;
          entry.integrity = undefined;
          entry.mtime = undefined;
          entry.expires = undefined;
        }
        // Cancellable work may release its resources when the deadline abandons it.
        // Never derive this from a caller's signal: one resolution serves every waiter.
        const controller = maxResolveTime ? new AbortController() : undefined;
        if (controller && event) {
          (resolveSignals ??= new WeakMap()).set(event, controller.signal);
        }
        // Share serialization because it may consume a one-use stream.
        const resolution = (async () => {
          const value = await resolver();
          // Hooks inspect this entry before storage.
          const resolvedEntry: CacheEntry<T> = { value, mtime: Date.now(), integrity };
          let maxAge: number | undefined;
          let staleMaxAge: number | undefined;
          if (opts.getMaxAge) {
            try {
              const resolved = await opts.getMaxAge(resolvedEntry);
              const dynamic = typeof resolved === "number" ? { maxAge: resolved } : resolved;
              // Non-positive lifetimes disable storage.
              maxAge = clampTtl(dynamic?.maxAge);
              staleMaxAge = clampTtl(dynamic?.staleMaxAge);
              resolvedEntry.maxAge = maxAge;
              resolvedEntry.staleMaxAge = staleMaxAge;
            } catch (error) {
              onError("[cache] getMaxAge hook error.", error);
            }
          }
          // Run `serialize` after `getMaxAge` so the lifetime hook sees the live value.
          const stored = opts.serialize ? await opts.serialize(resolvedEntry, validateCtx) : value;
          // Every byte value becomes a `Uint8Array` here, so a miss returns what a hit returns.
          return { value: normalizeBinary(stored) as T, maxAge, staleMaxAge };
        })();
        // Reject all waiters on timeout and prevent a late result from reaching storage.
        current = {
          promise: maxResolveTime
            ? withDeadline(resolution, maxResolveTime, controller)
            : resolution,
        };
        pending.set(key, current);
      }

      let resolved: { value: T; maxAge?: number; staleMaxAge?: number };
      try {
        resolved = await current.promise;
      } catch (error) {
        // Treat a timeout like any other failed resolution.
        if (!isPending) {
          releasePending(key, current);
          // A purge already removed the entry, and a newer resolution may own the key.
          if (!current.fenced) {
            const evictPromise = evictFromStorage(getStorage(), key, bases, group, name).catch(
              (error) => {
                onError("[cache] Cache eviction error.", error);
              },
            );
            waitUntil(evictPromise);
          }
        }
        throw error;
      }

      // Leaders and followers use the same serialized value.
      entry.value = resolved.value;

      if (!isPending) {
        entry.mtime = Date.now();
        entry.integrity = integrity;
        entry.stale = undefined;
        // Store dynamic lifetimes with the entry.
        if (opts.getMaxAge) {
          entry.maxAge = resolved.maxAge;
          entry.staleMaxAge = resolved.staleMaxAge;
        }
        const setOpts = storageTtl(
          entry.maxAge ?? opts.maxAge,
          entry.staleMaxAge ?? opts.staleMaxAge,
          opts.swr,
        );
        try {
          const isValid = (await validate(entry, validateCtx)) !== false;
          // A purge that ran during this resolution wins. Check it as late as possible.
          if (current.fenced) {
            return;
          }
          if (isValid && setOpts !== false) {
            // Write misses to all tiers and promote lower-tier hits.
            const writeBases = hitIndex < 0 ? bases : bases.slice(0, hitIndex + 1);
            // Never persist per-call status. A binary value takes its stored form here, so
            // nothing above this line holds base64 text.
            const { status: _status, ...rest } = entry;
            const toStore = encodeBinary(rest, getStorage());
            // Tell a storage codec where the payload is. A byte value is its own, which
            // `encodeBinary` has already marked; any other shape is declared by its producer.
            const payload = opts.payload ?? (toStore.encoding ? "value" : undefined);
            if (payload) {
              toStore.payload = payload;
            }
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
            // Register before the next await so no purge can slip in unnoticed.
            trackWrite(key, promise);
            waitUntil(promise);
          } else if (hitIndex >= 0) {
            // Remove an old entry when its replacement cannot be stored.
            const evictPromise = evictFromStorage(getStorage(), key, bases, group, name).catch(
              (error) => {
                onError("[cache] Cache eviction error.", error);
              },
            );
            waitUntil(evictPromise);
          }
        } finally {
          // Hold the slot until the write is decided so a purge can still fence it.
          releasePending(key, current);
        }
      }
    };

    const _resolvePromise = expired ? resolveEntry() : Promise.resolve();

    if (entry.value === undefined) {
      await _resolvePromise;
    } else if (expired) {
      waitUntil(_resolvePromise);
    }

    // Keep status non-enumerable so storage cannot persist it.
    Object.defineProperty(entry, "status", {
      value: status,
      enumerable: false,
      writable: true,
      configurable: true,
    });

    if (swr && isMatched && (await validate(entry, validateCtx)) !== false) {
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
      // Only `undefined` falls back; a falsy transform result is a real value.
      value = (await opts.transform(entry, ...args)) ?? value;
    }
    return value;
  };

  // Cancel the storage write of every resolution that started before the purge.
  (fences ??= new WeakMap()).set(cachedFn, (key: string) => {
    const current = pending.get(key);
    if (current) {
      current.fenced = true;
      // Later callers must resolve again instead of following a purged result.
      pending.delete(key);
    }
    // A write already handed to storage is past the fence; the caller must wait for it.
    return writes.get(key);
  });

  // Resolve the key once so a custom `getKey` runs no more than the call does.
  const purgeOptions = async (args: ArgsT) => {
    // Resolve storage before purge helpers copy the options.
    getStorage();
    const key = await (opts.getKey || getKey)(...args);
    await fencePending(cachedFn, key);
    return { ...opts, getKey: () => key };
  };

  cachedFn.resolveKeys = (...args: ArgsT) => resolveCacheKeys({ options: opts, args });
  cachedFn.invalidate = async (...args: ArgsT) => {
    await invalidateCache({ options: await purgeOptions(args) });
  };
  cachedFn.expire = async (...args: ArgsT) => {
    await expireCache({ options: await purgeOptions(args) });
  };

  return cachedFn;
}

/** Alias for {@link defineCachedFunction}. */
export const cachedFunction = defineCachedFunction;

/**
 * Returns one storage key per base prefix.
 *
 * Pass the same `getKey`, `name`, `group`, and `base` options as the cached function.
 * This helper computes keys without accessing storage.
 *
 * @param input - Cache options and function arguments.
 * @returns Storage keys in base-prefix order.
 *
 * @example
 * ```ts
 * const keys = await resolveCacheKeys({
 *   options: { name: "fetchUser", getKey: (id: string) => id },
 *   args: ["user-123"],
 * });
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
 * Removes matching entries from all base prefixes.
 *
 * Pass the original options object or the same explicit storage backend.
 * This function throws when `options.storage` is unset because no global store exists.
 * Prefer the cached function's `.invalidate()` method when available.
 *
 * @param input - Cache options and function arguments.
 *
 * @example
 * ```ts
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
 * Marks matching entries as stale without removing them.
 *
 * SWR may serve the stale value within its original stale window.
 * Without SWR, the next call revalidates before returning.
 * Pass the original lifetime options to preserve the remaining storage TTL.
 * This function throws when `options.storage` is unset.
 *
 * @param input - Cache options and function arguments.
 *
 * @example
 * ```ts
 * await expireCache({
 *   options: { name: "fetchUser", getKey: (id: string) => id, maxAge: 60, swr: true, storage },
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

// Resolve names before merging defaults. Equal-source closures need explicit names.
export function resolveName(name: string | undefined, fn: (...args: any[]) => any): string {
  return name || fn.name || `anon_${hash(fn).slice(0, 16)}`;
}

// Copy options and remove `undefined` so defaults remain effective.
export function definedOptions<T extends object>(opts: T): T {
  const cleaned = { ...opts } as Record<string, unknown>;
  for (const key of Object.keys(cleaned)) {
    if (cleaned[key] === undefined) {
      delete cleaned[key];
    }
  }
  return cleaned as T;
}

// Purge helpers must use the write-side backend; no global fallback exists.
function requireStorage(
  options: { storage?: StorageOption } | undefined,
  caller: string,
): StorageInterface {
  if (!options?.storage) {
    throw storageRequiredError(caller);
  }
  return resolveStorage(options);
}

// Reject stalled work, then ask it to stop.
// Attach both settle handlers to clear the timer and absorb late rejections.
// Avoid `Promise.race` because its extra microtasks change SWR timing.
function withDeadline<T>(
  work: Promise<T>,
  seconds: number,
  controller?: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = timeoutError(seconds);
      // Reject before aborting, so the waiters' error is decided first: a resolver that
      // rejects on abort settles `work` one microtask too late to be seen here.
      reject(error);
      controller?.abort(error);
    }, seconds * 1000);
    // Do not keep the process alive for a deadline timer.
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

/** Clamps negative TTLs to zero and maps non-finite TTLs to `undefined`. */
function clampTtl(value: number | undefined): number | undefined {
  return value == null || !Number.isFinite(value) ? undefined : Math.max(0, value);
}

// Binary values follow the same rule as a response body in `http/entry.ts`: the backend declares
// whether a byte view survives a round trip, and that one declaration chooses the stored form.
// The encoded form exists only between `encodeBinary` and `storage.set`, and between
// `storage.get` and `decodeBinary`, so every hook and every caller sees a `Uint8Array`.

/** Returns byte values as a `Uint8Array` over the same memory, and anything else unchanged. */
function normalizeBinary(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

/** Returns the entry to store, with a byte value in the form this backend can return. */
function encodeBinary(entry: CacheEntry<any>, storage: StorageInterface): CacheEntry<any> {
  const value = entry.value;
  if (!(value instanceof Uint8Array)) {
    return entry;
  }
  // A declaring backend hands one view to every hit and every deduplicated caller, so nothing
  // may mutate a stored value. Everywhere else, base64 survives a backend that serializes.
  return storage.binary
    ? { ...entry, encoding: "bytes" }
    : { ...entry, value: bytesToBase64(value), encoding: "base64" };
}

/** Restores a binary value in place, or drops one no reader can restore. */
function decodeBinary(entry: CacheEntry<any>): void {
  const encoding = entry.encoding;
  if (encoding === undefined) {
    return;
  }
  // The marker describes storage, not the value: it is written again from the backend in use.
  entry.encoding = undefined;
  if (encoding === "base64" && typeof entry.value === "string") {
    entry.value = base64ToBytes(entry.value);
    return;
  }
  if (encoding === "bytes" && ArrayBuffer.isView(entry.value)) {
    entry.value = normalizeBinary(entry.value);
    return;
  }
  // Neither stored form. A backend that declares `binary` without keeping views returns
  // `{"0":255,...}` here, which nothing can turn back into bytes; a miss re-resolves the value
  // instead of handing the caller an object where its bytes were.
  entry.value = undefined;
}

function getKey(...args: unknown[]) {
  return args.length > 0 ? hash(args) : "";
}

function buildCacheKey(
  key: string,
  opts: Pick<CacheOptions, "group" | "name">,
  base: string,
): string {
  // `group` and `name` are single segments; neither alphabet is controlled, so both are
  // escaped. `base` keeps its raw `:` tier separators and `key` is terminal.
  const group = escapeKeySegment(opts.group || "functions");
  const name = escapeKeySegment(opts.name || "_");
  return [base, group, name, key + ".json"].filter(Boolean).join(":").replace(/:\/$/, ":index");
}

// Hash changed segments because removing punctuation is lossy.
export function escapeKeySegment(raw: string): string {
  const escaped = escapeKey(raw);
  return escaped === raw ? escaped : `${escaped.slice(0, 64)}.${hash(raw)}`;
}

// Use `escapeKeySegment` for segments in colon-delimited keys.
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

// Never store an entry without an expiry or storage TTL.
// Unbounded SWR uses backend capacity instead of a TTL.
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
  // A bounded TTL must cover both the fresh and stale windows.
  return staleMaxAge != null && staleMaxAge >= 0 ? { ttl: maxAge + staleMaxAge } : undefined;
}

/** Returns the remaining storage TTL without extending the original lifetime. */
function remainingTtl(
  entry: CacheEntry,
  opts: Pick<CacheOptions, "maxAge" | "swr" | "staleMaxAge">,
): { ttl: number } | undefined {
  // Use the write-path policy and prefer per-entry lifetimes.
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
 * Removes storage-location and host-plumbing options from the integrity input.
 *
 * A backend change does not change the cached computation.
 * Hashing storage objects is also expensive and cannot capture closed-over configuration.
 * `waitUntil` only decides who owns background work, so adopting it or moving between
 * runtimes must not invalidate entries.
 */
function integrityOpts(
  opts: CacheOptions<any, any>,
): Omit<CacheOptions, "base" | "group" | "name" | "storage" | "waitUntil"> {
  const { base: _, group: _g, name: _n, storage: _s, waitUntil: _w, ...rest } = opts;
  return rest;
}
