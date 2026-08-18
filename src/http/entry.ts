// Docs: @docs/5.handler.md, @docs/7.cookies.md, @docs/8.cache-control.md, @docs/9.isr.md

import { base64ToBytes, bytesToBase64 } from "../base64.ts";
import { ResponseTooLargeError } from "../error.ts";
import { hash, hashBytes } from "../hash.ts";

import { resolveStatus } from "../cache.ts";

import type { HandlerConfig } from "./config.ts";
import { createStreamSink, takeStreamListener } from "./stream.ts";
import { isCacheableStatus } from "./validate.ts";
import { appendVary, hasUnkeyedVary, hasVaryWildcard } from "./vary.ts";

import type { StreamSink, StreamedResponse } from "./stream.ts";
import type { StorageOption } from "../storage.ts";
import type { CacheEntry, CacheStatus, HTTPEvent, ResponseCacheEntry } from "../types.ts";

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

// A backend that stores bytes charges one byte per binary body byte, so text at 2 bytes per
// UTF-16 code unit becomes the worst case there.
const BINARY_BODY_CHARGE_FACTOR = 2;

// Response constructors reject non-null bodies for these statuses.
const nullBodyStatuses: ReadonlySet<number> = /* @__PURE__ */ new Set([204, 205, 304]);

// Deduplicated callers share this single body read.
export async function serializeResponse<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  entry: CacheEntry<Response>,
  storage?: StorageOption,
  event?: HTTPEvent,
): Promise<ResponseCacheEntry> {
  const res = entry.value as Response;
  const limit = resolveMaxBodySize(config.opts.maxBodySize, storage);

  // Serve this body while it is still being read, when the caller opted in and this event
  // both leads the resolution and is waiting for it. `resolveStatus` answers only for such
  // an event, so a background refresh behind a stale hit never reaches the listener its own
  // caller opened. See `.agents/http/stream.md`.
  if (config.opts.stream && res.body && event) {
    const status = resolveStatus(event);
    const listener = status && takeStreamListener(event);
    if (status && listener) {
      return streamBody(config, entry, res, limit, status, listener, storage, event);
    }
  }

  return buildEntry(config, entry, res, await readBody(res, limit, event), storage);
}

// Build the stored entry from the complete body.
function buildEntry<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  entry: CacheEntry<Response>,
  res: Response,
  bytes: Uint8Array,
  storage: StorageOption | undefined,
): ResponseCacheEntry {
  // Use byte validity, not Content-Type, to preserve binary data in JSON storage.
  const text = decodeUtf8(bytes);
  // Store bytes as themselves where the backend keeps them, and as base64 everywhere else.
  // A declaring backend hands one view to every hit, so no reader may mutate a stored body.
  const base64 = text === undefined && !isBinaryStorage(storage);
  const body = text ?? (base64 ? bytesToBase64(bytes) : bytes);

  // Text and base64 share one value space: the text `/w==` and the byte 0xff hash alike.
  // The binary tag digests the bytes rather than a storage form, so one representation keeps
  // one validator whichever backend holds it.
  const etag = text === undefined ? `W/"b${hashBytes(bytes)}"` : `W/"${hash(text)}"`;
  const headers = buildHeaders(config, entry, res, etag);

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
 * Streams the body to its caller while buffering the same chunks for storage.
 *
 * The sink and the buffer hold the same chunk objects, so serving costs no retention beyond
 * the buffering the stored entry already needs.
 */
async function streamBody<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  entry: CacheEntry<Response>,
  res: Response,
  limit: number | undefined,
  status: CacheStatus,
  listener: (streamed: StreamedResponse | undefined) => void,
  storage: StorageOption | undefined,
  event: HTTPEvent,
): Promise<ResponseCacheEntry> {
  const sink: StreamSink = createStreamSink();

  // The synthesized validator digests a body that does not exist yet, so a streamed response
  // carries no `etag` unless the handler set one. Every later hit is served from the stored
  // entry, which does. `transform` never runs for this caller, so stamp the status here.
  const headers = buildHeaders(config, entry, res, undefined);
  if (config.statusHeader) {
    headers.set(config.statusHeader, status.toUpperCase());
  }
  listener({
    body: sink.body,
    init: { status: res.status, statusText: res.statusText, headers },
  });

  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let storable = true;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      sink.push(value);
      if (!storable) {
        continue;
      }
      size += value.byteLength;
      if (limit !== undefined && size > limit) {
        // Serving continues to completion, as an over-limit buffered body does. Release the
        // prefix: nothing may be stored, so holding it past the limit buys nothing.
        storable = false;
        chunks.length = 0;
      } else {
        chunks.push(value);
      }
    }
  } catch (error) {
    // The status line and headers are already sent, so a truncated body is the only signal
    // left. Never close this stream cleanly on a failed read.
    sink.error(error);
    throw error;
  }
  sink.close();

  if (!storable) {
    // The caller already has the whole body, so this error carries no passthrough response.
    throw new ResponseTooLargeError(limit!, event);
  }
  return buildEntry(config, entry, res, concatChunks(chunks, size), storage);
}

// Synthesize the stored and served headers. The etag is absent for a body still being read.
function buildHeaders<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  entry: CacheEntry<Response>,
  res: Response,
  etag: string | undefined,
): Headers {
  const { opts, varyHeaderNames } = config;

  // Copy headers because fetch and redirect responses can have immutable headers.
  const headers = new Headers(res.headers);

  if (etag !== undefined && !headers.has("etag")) {
    headers.set("etag", etag);
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

  return headers;
}

/**
 * Returns the body and init data needed to rebuild a stored response.
 *
 * Null-body statuses use `null` because Response rejects an empty string body for them.
 *
 * Both stored forms are read whatever the backend declares now: an entry outlives a change to
 * `StorageInterface.binary`, and a persistent backend can hold entries from both eras at once.
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

/** Whether the backend returns a stored byte view as itself. */
function isBinaryStorage(storage: StorageOption | undefined): boolean {
  return typeof storage === "object" && storage?.binary === true;
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
  // The factor follows the same backend declaration the body form does.
  const factor = isBinaryStorage(storage) ? BINARY_BODY_CHARGE_FACTOR : BODY_CHARGE_FACTOR;
  return maxEntryBytes != null && Number.isFinite(maxEntryBytes) && maxEntryBytes > 0
    ? Math.floor(maxEntryBytes / factor)
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
  return concatChunks(chunks, size);
}

// Join buffered chunks into one exact-size array. `.agents/storage.md` charges a view by its
// backing buffer, so an exact-size array is also the size the backend charges for.
function concatChunks(chunks: Uint8Array[], size: number): Uint8Array {
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
