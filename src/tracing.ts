// Docs: @docs/13.tracing.md

import type { CacheStatus, HTTPEvent } from "./types.ts";

/**
 * Name of the tracing channel cached calls are traced on.
 *
 * Subscribers can use it instead of hardcoding the string:
 * `tracingChannel<CacheTraceContext>(GET_CHANNEL)`.
 */
export const GET_CHANNEL = "ocache.get";

/** Context of the `ocache.get` channel. */
export interface CacheTraceContext {
  /** Resolved cache name. */
  name: string;
  /** Cache key group, e.g. `"functions"` or `"handlers"`. */
  group: string;
  /** The request event, when the first argument is one. */
  event?: HTTPEvent;
  /** Cache key from `getKey`. Unset for a bypassed call. */
  key?: string;
  /** How the call was served, or `"bypass"` when `shouldBypassCache` skipped the cache. */
  status?: CacheStatus | "bypass";
  /** Value returned to the caller. */
  result?: unknown;
  /** Error the call rejected with. */
  error?: unknown;
}

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
