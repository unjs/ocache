// Docs: @docs/13.tracing.md

import type { CacheEntry, CacheStatus, HTTPEvent, ResponseCacheEntry } from "./types.ts";

/**
 * Name of the tracing channel cached calls are traced on.
 *
 * Subscribers can use it instead of hardcoding the string:
 * `tracingChannel<CacheTraceContext>(GET_CHANNEL)`.
 */
export const GET_CHANNEL = "ocache.get";

/**
 * Name of the tracing channel resolutions are traced on: one event per run of the cached
 * function, in the foreground or in the background.
 *
 * `tracingChannel<CacheResolveTraceContext>(RESOLVE_CHANNEL)`.
 */
export const RESOLVE_CHANNEL = "ocache.resolve";

/** Fields of the `ocache.get` context shared by functions and handlers. */
interface BaseCacheTraceContext {
  /** Resolved cache name. */
  name: string;
  /** Cache key group, e.g. `"functions"` or `"handlers"`. */
  group: string;
  /** Cache key from `getKey`. */
  key?: string;
  /** Full storage keys, one per `base` prefix in read order. */
  keys?: string[];
  /** How the call was served. */
  status?: CacheStatus;
  /**
   * Fresh lifetime of the served value in seconds. For `"hit"` and `"stale"` it is the stored
   * entry's, for `"miss"` and `"revalidated"` the new value's.
   */
  maxAge?: number;
  /** Write time of the served value in Unix milliseconds. */
  mtime?: number;
  /** Error the call rejected with. */
  error?: unknown;
}

/** Context of an `ocache.get` event published by a cached function. */
export interface CachedFunctionTraceContext extends BaseCacheTraceContext {
  type: "function";
  /** The request event, when the first argument is one. */
  event?: HTTPEvent;
  /** Value returned to the caller. */
  result?: unknown;
}

/** Context of an `ocache.get` event published by a cached handler. */
export interface CachedHandlerTraceContext extends BaseCacheTraceContext {
  type: "handler";
  /** The request event. */
  event: HTTPEvent;
  /** Stored entry the response is built from. */
  result?: ResponseCacheEntry;
}

/**
 * Context of the `ocache.get` channel.
 *
 * Narrow on `type` to get the matching `result`.
 */
export type CacheTraceContext = CachedFunctionTraceContext | CachedHandlerTraceContext;

/** Fields of the `ocache.resolve` context shared by functions and handlers. */
interface BaseCacheResolveTraceContext {
  /** Resolved cache name. */
  name: string;
  /** Cache key group, e.g. `"functions"` or `"handlers"`. */
  group: string;
  /** Cache key from `getKey`. */
  key: string;
  /** Status of the read that started it. `"stale"` means it runs in the background. */
  status: Exclude<CacheStatus, "hit">;
  /** Error the resolution rejected with. */
  error?: unknown;
}

/** Context of an `ocache.resolve` event published by a cached function. */
export interface CachedFunctionResolveTraceContext extends BaseCacheResolveTraceContext {
  type: "function";
  /** The request event, when the first argument is one. */
  event?: HTTPEvent;
  /** The new entry, before storage. */
  result?: CacheEntry<unknown>;
}

/** Context of an `ocache.resolve` event published by a cached handler. */
export interface CachedHandlerResolveTraceContext extends BaseCacheResolveTraceContext {
  type: "handler";
  /** The request event. */
  event: HTTPEvent;
  /** The new entry, before storage. */
  result?: CacheEntry<ResponseCacheEntry>;
}

/**
 * Context of the `ocache.resolve` channel.
 *
 * Narrow on `type` to get the matching `result`.
 */
export type CacheResolveTraceContext =
  | CachedFunctionResolveTraceContext
  | CachedHandlerResolveTraceContext;

interface SubChannel {
  readonly hasSubscribers: boolean;
}

// A local shape instead of `node:diagnostics_channel` types keeps `@types/node` out of
// the published declarations.
interface TracingChannel {
  readonly hasSubscribers?: boolean;
  readonly start: SubChannel;
  readonly end: SubChannel;
  readonly asyncStart: SubChannel;
  readonly asyncEnd: SubChannel;
  readonly error: SubChannel;
  tracePromise<T>(fn: () => Promise<T>, context: object): Promise<T>;
}

// The inner cached functions of traced handlers. Allocated on the first one, like `fences`.
let handlerFunctions: WeakSet<object> | undefined;

// Marks a handler's inner cached function, so its calls are traced as `type: "handler"`.
export function markHandlerFunction(cachedFn: object): void {
  (handlerFunctions ??= new WeakSet()).add(cachedFn);
}

export function traceType(cachedFn: object): CacheTraceContext["type"] {
  return handlerFunctions?.has(cachedFn) ? "handler" : "function";
}

// `undefined` until the first lookup, `null` when the runtime has no tracing channels.
let factory: ((name: string) => TracingChannel) | null | undefined;
const channels: Record<string, TracingChannel> = {};

function loadFactory(): ((name: string) => TracingChannel) | null {
  let tracingChannel: unknown;
  try {
    // Runtimes disagree on an unknown builtin: some return `undefined`, some throw.
    tracingChannel = (globalThis as any).process?.getBuiltinModule?.(
      "node:diagnostics_channel",
    )?.tracingChannel;
  } catch {
    tracingChannel = undefined;
  }
  return typeof tracingChannel === "function"
    ? (tracingChannel as (name: string) => TracingChannel)
    : null;
}

// The channel, while something subscribes to it.
export function observed(name: string): TracingChannel | undefined {
  if (factory === undefined) {
    factory = loadFactory();
  }
  if (!factory) {
    return;
  }
  const channel = (channels[name] ??= factory(name));
  // Some runtimes (e.g. Bun) lack the aggregate getter, so ask the sub-channels.
  const subscribed =
    channel.hasSubscribers ??
    (channel.start.hasSubscribers ||
      channel.end.hasSubscribers ||
      channel.asyncStart.hasSubscribers ||
      channel.asyncEnd.hasSubscribers ||
      channel.error.hasSubscribers);
  return subscribed ? channel : undefined;
}

// Runs `call`, traced on `name` while something subscribes. Unobserved, it returns `call()`
// itself, so the call keeps its exact timing.
export function trace<C extends object, T>(
  name: string,
  createContext: () => C,
  call: (context?: C) => Promise<T>,
): Promise<T> {
  const channel = observed(name);
  if (!channel) {
    return call();
  }
  const context = createContext();
  return channel.tracePromise(() => call(context), context);
}
