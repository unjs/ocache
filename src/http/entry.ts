import { hash } from "../hash.ts";

import type { HandlerConfig } from "./config.ts";
import { isCacheableStatus } from "./validate.ts";
import { appendVary, hasUnkeyedVary, hasVaryWildcard } from "./vary.ts";

import type { CacheEntry, HTTPEvent, ResponseCacheEntry } from "../types.ts";

// Buffered response bodies no longer match these transport headers.
const transportHeaders = [
  "content-encoding",
  "content-length",
  "content-range",
  "transfer-encoding",
];

// Response constructors reject non-null bodies for these statuses.
const nullBodyStatuses = new Set([204, 205, 304]);

// Deduplicated callers share this single body read.
export async function serializeResponse<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  entry: CacheEntry<Response>,
): Promise<ResponseCacheEntry> {
  const { opts, varyHeaderNames, tagList } = config;
  const res = entry.value as Response;

  // Use byte validity, not Content-Type, to preserve binary data in JSON storage.
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = decodeUtf8(bytes);
  const base64 = text === undefined;
  const body = base64 ? bytesToBase64(bytes) : text;

  // Copy headers because fetch and redirect responses can have immutable headers.
  const headers = new Headers(res.headers);

  if (!headers.has("etag")) {
    headers.set("etag", `W/"${hash(body)}"`);
  }

  if (!headers.has("last-modified")) {
    headers.set("last-modified", new Date().toUTCString());
  }

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

  // Tags are advisory for downstream caches. A handler header wins.
  if (tagList && !headers.has("cache-tag")) {
    headers.set("cache-tag", tagList.join(", "));
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

// Fatal decoding detects binary data; `ignoreBOM` preserves leading BOM bytes.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

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
