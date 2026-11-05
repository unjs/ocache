// Docs: @docs/13.tracing.md

import type { CacheStatus, HTTPEvent, ResponseCacheEntry } from "./types.ts";

/**
 * Name of the tracing channel cached calls are traced on.
 *
 * Subscribers can use it instead of hardcoding the string:
 * `tracingChannel<CacheTraceContext>(GET_CHANNEL)`.
 */
export const GET_CHANNEL = "ocache.get";

/** Fields of the `ocache.get` context shared by functions and handlers. */
interface BaseCacheTraceContext {
  /** Resolved cache name. */
  name: string;
  /** Cache key group, e.g. `"functions"` or `"handlers"`. */
  group: string;
  /** Cache key from `getKey`. Unset for a bypassed call. */
  key?: string;
  /** How the call was served, or `"bypass"` when `shouldBypassCache` skipped the cache. */
  status?: CacheStatus | "bypass";
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

interface SubChannel {
  readonly hasSubscribers: boolean;
}

// A local shape instead of `node:diagnostics_channel` types keeps `@types/node` out of
// the published declarations.
interface TracingChannel<C extends object> {
  readonly hasSubscribers?: boolean;
  readonly start: SubChannel;
  readonly end: SubChannel;
  readonly asyncStart: SubChannel;
  readonly asyncEnd: SubChannel;
  readonly error: SubChannel;
  tracePromise<T>(fn: () => Promise<T>, context: C): Promise<T>;
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
let channel: TracingChannel<CacheTraceContext> | null | undefined;

function loadChannel(): TracingChannel<CacheTraceContext> | null {
  let tracingChannel: ((name: string) => TracingChannel<CacheTraceContext>) | undefined;
  try {
    // Runtimes disagree on an unknown builtin: some return `undefined`, some throw.
    tracingChannel = (globalThis as any).process?.getBuiltinModule?.(
      "node:diagnostics_channel",
    )?.tracingChannel;
  } catch {
    tracingChannel = undefined;
  }

  return typeof tracingChannel === "function" ? tracingChannel(GET_CHANNEL) : null;
}

// Runs one cached call, traced on `ocache.get` while something subscribes. Unobserved, it
// returns `call()` itself, so the call keeps its exact timing.
export function traceGet<T>(
  createContext: () => CacheTraceContext,
  call: (context?: CacheTraceContext) => Promise<T>,
): Promise<T> {
  if (channel === undefined) {
    channel = loadChannel();
  }
  // Some runtimes (e.g. Bun) lack the aggregate getter, so ask the sub-channels.
  const subscribed =
    channel &&
    (channel.hasSubscribers ??
      (channel.start.hasSubscribers ||
        channel.end.hasSubscribers ||
        channel.asyncStart.hasSubscribers ||
        channel.asyncEnd.hasSubscribers ||
        channel.error.hasSubscribers));
  if (!subscribed) {
    return call();
  }
  const context = createContext();

  return channel!.tracePromise(() => call(context), context);
}
