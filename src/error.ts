// Every error ocache throws, and every message it renders.
// `name` is the stable identifier; `instanceof` is internal only.

import type { HTTPEvent } from "./types.ts";

const PREFIX = "[ocache]";

// Build a named error. The name is a literal because a minifier renames the class.
function error(name: string, message: string, options?: ErrorOptions): Error {
  const err = new Error(`${PREFIX} ${message}`, options);
  err.name = name;
  return err;
}

/** The resolver and its hooks passed `maxResolveTime`. Named after `AbortSignal.timeout()`. */
export function timeoutError(seconds: number): Error {
  return error("TimeoutError", `Resolver timed out after ${seconds}s.`);
}

/** A purge helper needs the write-side backend; no global fallback exists. */
export function storageRequiredError(caller: string): Error {
  return error("StorageRequiredError", `${caller}() requires \`options.storage\`.`);
}

/** A composed stack with no layers would silently cache nothing. */
export function composeLayersError(): Error {
  return error("ComposeLayersError", "composeStorage() requires at least one layer.");
}

/** The backend returned something that is not an entry. */
export function malformedEntryError(): Error {
  return error("MalformedEntryError", "Malformed data read from cache.");
}

/** An event property could not be replaced; becomes the cause of `NarrowRequestError`. */
export function readOnlyEventError(property: string): Error {
  return error("ReadOnlyError", `\`event.${property}\` is read-only.`);
}

/** A value nests deeper than `serialize` may recurse. */
export function tooDeepError(maxDepth: number): RangeError {
  return new RangeError(
    `${PREFIX} Cannot hash a value nested deeper than ${maxDepth} levels. Pass an explicit \`getKey\`.`,
  );
}

/**
 * Signals that the event could not be narrowed to what the cache key covers.
 *
 * The handler could read credentials or excluded query values that no key covers,
 * so `defineCachedHandler` bypasses the cache for the request instead of storing it.
 */
export class NarrowRequestError extends Error {
  override name = "NarrowRequestError";
  constructor(cause: unknown) {
    super(`${PREFIX} Cannot narrow the request to the cache key.`, { cause });
  }
}

/**
 * Signals that the default `toResponse` cannot convert a handler's return value.
 *
 * `String(value)` renders an object as `[object Object]` and a byte view as its
 * comma-joined digits. Either is a valid 200, so the cache stored it and replayed it
 * for the whole lifetime without running the handler again. See
 * `.agents/http/response.md`.
 */
export class UnsupportedValueError extends TypeError {
  override name = "UnsupportedValueError";
  constructor(value: unknown) {
    super(
      `${PREFIX} Handler returned ${describeValue(value)}; return a Response or set \`toResponse\`.`,
    );
  }
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  return typeof value === "object" ? (value.constructor?.name ?? "an object") : typeof value;
}

/**
 * Signals that a response body passed the buffering limit and was not stored.
 *
 * The error carries the live response so the request that produced it can still be
 * served. That response holds a one-use stream, so only one caller may claim it.
 *
 * A streamed response carries none: its caller received the whole body as it was read,
 * so there is nothing left to hand over and nothing to release.
 */
export class ResponseTooLargeError extends Error {
  override name = "ResponseTooLargeError";

  /** The request whose resolution read this body, when the caller is an HTTP event. */
  #event: HTTPEvent | undefined;
  #response: Response | undefined;

  constructor(limit: number, event: HTTPEvent | undefined, response?: Response) {
    super(`${PREFIX} Response body exceeds the ${limit} byte cache limit.`);
    this.#event = event;
    this.#response = response;
    if (!response) {
      return;
    }
    // Nothing claims the response of a background revalidation. Release its stream one
    // macrotask later, because the rejection only ever reaches a caller through microtasks.
    const timer = setTimeout(() => {
      const unclaimed = this.#response;
      this.#response = undefined;
      void unclaimed?.body?.cancel().catch(() => {});
    }, 0);
    // Do not keep the process alive for this release.
    if (timer && typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  }

  /**
   * Returns the live response once, and only to the request that produced it.
   *
   * A deduplicated follower receives `undefined` because it cannot share the stream,
   * and because the response answers another request that was narrowed for the key.
   */
  claim(event: HTTPEvent): Response | undefined {
    if (!this.#response || event !== this.#event) {
      return undefined;
    }
    const response = this.#response;
    this.#response = undefined;
    return response;
  }
}
