import { hash } from "../hash.ts";

import type { HandlerConfig } from "./config.ts";
import { isCacheableStatus } from "./validate.ts";
import { appendVary, hasUnkeyedVary, hasVaryWildcard } from "./vary.ts";

import type { StorageOption } from "../storage.ts";
import type { CacheEntry, HTTPEvent, ResponseCacheEntry } from "../types.ts";

// Buffered response bodies no longer match these transport headers.
const transportHeaders: readonly string[] = /* @__PURE__ */ Object.freeze([
  "content-encoding",
  "content-length",
  "content-range",
  "transfer-encoding",
]);

// A stored body costs at most 8/3 bytes per body byte: base64 expands it by 4/3 and the
// storage estimate charges 2 bytes per UTF-16 code unit.
const BODY_CHARGE_FACTOR = 8 / 3;

// Response constructors reject non-null bodies for these statuses.
const nullBodyStatuses: ReadonlySet<number> = /* @__PURE__ */ new Set([204, 205, 304]);

// Deduplicated callers share this single body read.
export async function serializeResponse<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  entry: CacheEntry<Response>,
  storage?: StorageOption,
  event?: HTTPEvent,
): Promise<ResponseCacheEntry> {
  const { opts, varyHeaderNames } = config;
  const res = entry.value as Response;

  // Use byte validity, not Content-Type, to preserve binary data in JSON storage.
  const bytes = await readBody(res, resolveMaxBodySize(opts.maxBodySize, storage), event);
  const text = decodeUtf8(bytes);
  const base64 = text === undefined;
  const body = base64 ? bytesToBase64(bytes) : text;

  // Copy headers because fetch and redirect responses can have immutable headers.
  const headers = new Headers(res.headers);

  if (!headers.has("etag")) {
    // Text and base64 share one value space: the text `/w==` and the byte 0xff hash alike.
    headers.set("etag", `W/"${base64 ? "b" : ""}${hash(body)}"`);
  }

  // No `last-modified` is synthesized: fill time is not a modification time, and its
  // one-second resolution cannot distinguish two bodies. The etag above is the validator.

  // Advertisement must use the same status and Vary predicates as storage validation.
  const declaredVary = headers.get("vary");
  if (
    opts.sendCacheControl !== false &&
    isCacheableStatus(res.status) &&
    !hasVaryWildcard(declaredVary) &&
    !hasUnkeyedVary(declaredVary, varyHeaderNames) &&
    !headers.has("cache-control")
  ) {
    // Advertise dynamic entry lifetimes before static options.
    const maxAge = entry.maxAge ?? opts.maxAge;
    const staleMaxAge = entry.staleMaxAge ?? opts.staleMaxAge;

    const cacheControl = [];
    if (maxAge != null) {
      // Send `max-age` for private caches and `s-maxage` for shared-cache authorization.
      cacheControl.push(`max-age=${maxAge}`);
      if (opts.swr) {
        cacheControl.push(`s-maxage=${maxAge}`);
      }
    }
    // Omit stale-while-revalidate when the stale window is unbounded.
    if (opts.swr && staleMaxAge != null) {
      cacheControl.push(`stale-while-revalidate=${staleMaxAge}`);
    }
    if (cacheControl.length > 0) {
      headers.set("cache-control", cacheControl.join(", "));
    }
  }

  // Vary can name only the complete Cookie header, not an allowlisted subset.
  if (varyHeaderNames.length > 0) {
    appendVary(headers, varyHeaderNames);
  }

  // Never share a response cookie with deduplicated or later callers.
  headers.delete("set-cookie");

  // Remove headers that describe the original transport body.
  for (const header of transportHeaders) {
    headers.delete(header);
  }

  const cacheEntry: ResponseCacheEntry = {
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(headers.entries()),
    body,
    // Keep text entries compatible with the original unflagged format.
    ...(base64 && { base64: true }),
  };

  return cacheEntry;
}

/**
 * Returns the body and init data needed to rebuild a stored response.
 *
 * Null-body statuses use `null` because Response rejects an empty string body for them.
 */
export function deserializeEntry(entry: ResponseCacheEntry): {
  body: string | Uint8Array | null;
  init: ResponseInit;
} {
  const body = nullBodyStatuses.has(entry.status)
    ? null
    : entry.base64 && typeof entry.body === "string"
      ? base64ToBytes(entry.body)
      : (entry.body ?? null);
  return {
    body,
    init: {
      status: entry.status,
      statusText: entry.statusText,
      headers: entry.headers,
    },
  };
}

/**
 * Signals that a response body passed the buffering limit and was not stored.
 *
 * The error carries the live response so the request that produced it can still be
 * served. That response holds a one-use stream, so only one caller may claim it.
 */
export class ResponseTooLargeError extends Error {
  override name = "ResponseTooLargeError";

  /** The request whose resolution read this body, when the caller is an HTTP event. */
  #event: HTTPEvent | undefined;
  #response: Response | undefined;

  constructor(limit: number, event: HTTPEvent | undefined, response: Response) {
    super(`Response body exceeds the ${limit} byte cache limit.`);
    this.#event = event;
    this.#response = response;
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

/** Returns the buffering limit in bytes, or `undefined` when nothing bounds the body. */
function resolveMaxBodySize(
  maxBodySize: number | undefined,
  storage: StorageOption | undefined,
): number | undefined {
  if (maxBodySize != null) {
    return Number.isFinite(maxBodySize) && maxBodySize > 0 ? maxBodySize : undefined;
  }
  // Derive the default from the backend: a larger body could never be stored anyway.
  const maxEntryBytes = typeof storage === "object" ? storage?.maxEntryBytes : undefined;
  return maxEntryBytes != null && Number.isFinite(maxEntryBytes) && maxEntryBytes > 0
    ? Math.floor(maxEntryBytes / BODY_CHARGE_FACTOR)
    : undefined;
}

// Buffer the body, refusing an oversized one while the stream is still being consumed.
async function readBody(
  res: Response,
  limit: number | undefined,
  event: HTTPEvent | undefined,
): Promise<Uint8Array> {
  if (limit === undefined || !res.body) {
    return new Uint8Array(await res.arrayBuffer());
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    chunks.push(value);
    size += value.byteLength;
    if (size > limit) {
      // Serve what was read plus the rest of the stream. Nothing reaches storage.
      throw new ResponseTooLargeError(limit, event, passthroughResponse(res, chunks, reader));
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Rebuild a live response from the buffered prefix and the unread rest of the stream.
// Headers stay untouched: this body is the original transport body, not a stored one.
function passthroughResponse(
  res: Response,
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      // Release the prefix once it belongs to the stream.
      chunks.length = 0;
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
      } else if (value) {
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

// Fatal decoding detects binary data; `ignoreBOM` preserves leading BOM bytes.
const utf8Decoder = /* @__PURE__ */ new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Returns decoded UTF-8 or `undefined` for invalid UTF-8. */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/** Encodes bytes in chunks that fit `String.fromCharCode`. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x80_00;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decodes base64 to bytes. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
