// Docs: @docs/2.functions.md, @docs/5.handler.md, @docs/10.api.md

import type { TracingChannel } from "node:diagnostics_channel";

/**
 * Name of the tracing channel each cached-handler call is published on.
 *
 * Subscribers can use it instead of hardcoding the string:
 * `tracingChannel<HandlerTraceContext>(HANDLER_CHANNEL)`.
 */
export const HANDLER_CHANNEL = "ocache.handler";

/**
 * Name of the tracing channel each cached-function call is published on.
 *
 * Subscribers can use it instead of hardcoding the string:
 * `tracingChannel<FunctionTraceContext>(FUNCTION_CHANNEL)`.
 */
export const FUNCTION_CHANNEL = "ocache.function";

// Runtimes disagree on what `getBuiltinModule` does with a module they do not implement
// (return `undefined` or throw), so tracing degrades to nothing either way.
export function openTracingChannel<T extends object>(name: string): TracingChannel<T> | undefined {
  try {
    return globalThis.process
      ?.getBuiltinModule?.("node:diagnostics_channel")
      ?.tracingChannel<T>(name);
  } catch {
    return undefined;
  }
}

// Checked per call, so a call nobody observes allocates no payload. A runtime whose channel
// has no `hasSubscribers` (Bun) publishes every call instead.
export function hasSubscribers(channel: TracingChannel<any>): boolean {
  return channel.hasSubscribers !== false;
}
