// The storage codec, both directions: live `Response` → stored `ResponseCacheEntry`
// (`serializeResponse`) and back on a hit (`deserializeEntry`). One file because the two
// halves must agree on the body encoding, the null-body statuses and which headers survive.

import { hash } from "ohash";

import type { HandlerConfig } from "./config.ts";
import { isCacheableStatus } from "./validate.ts";
import { appendVary, hasUnkeyedVary, hasVaryWildcard } from "./vary.ts";

import type { CacheEntry, HTTPEvent, ResponseCacheEntry } from "../types.ts";

// Transport/framing headers stripped from a cached entry: the body is stored fully decoded
// and re-buffered, so none of them still describes it. `content-range` too — it describes a
// *partial* body, a lie on the complete representations we store (a proxying handler copying
// upstream headers onto a 200 is how it gets attached; a real 206 never reaches storage).
const transportHeaders = [
  "content-encoding",
  "content-length",
  "content-range",
  "transfer-encoding",
];

// Statuses whose `Response` constructor throws on any non-null body. Read path only (storage
// rejects them via `validate.ts`'s allowlist), and still needed there: a body-less response
// is stored as `""`, and the MISS caller is served through that entry whatever `validate` says.
const nullBodyStatuses = new Set([204, 205, 304]);

// Serializes a resolved `Response` into the stored entry. Runs exactly once per resolution
// (shared across deduplicated callers), so consuming the body here is safe. Takes the whole
// entry, not just its `Response`: the lifetimes advertised below are the ones `cache.ts` has
// already resolved *onto it* (finding 10.2).
export async function serializeResponse<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  entry: CacheEntry<Response>,
): Promise<ResponseCacheEntry> {
  const { opts, varyHeaderNames } = config;
  const res = entry.value as Response;

  // Read the body once as raw bytes: valid UTF-8 is stored verbatim as a string (stable text
  // etags), anything else is base64-encoded and flagged so binary survives a JSON storage
  // backend. Discriminated on byte validity, not the spoofable/absent content-type.
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = decodeUtf8(bytes);
  const base64 = text === undefined;
  const body = base64 ? bytesToBase64(bytes) : text;

  if (!res.headers.has("etag")) {
    res.headers.set("etag", `W/"${hash(body)}"`);
  }

  if (!res.headers.has("last-modified")) {
    res.headers.set("last-modified", new Date().toUTCString());
  }

  // Synthesize only when the handler set no `cache-control`, and never for a response we
  // won't store — `validate` shares these predicates so the two can't drift (an unstored 500
  // once shipped `s-maxage=60`). Both `Vary` verdicts need a gate for the same reason and
  // neither is caught by the `has("cache-control")` check: a handler declaring `Vary: *` or
  // `Vary: Accept-Language` typically sets no `Cache-Control` at all, so without this the
  // response would be refused storage — origin takes every request — while being advertised
  // `s-maxage=…, stale-while-revalidate=…` to every shared cache downstream. Read here
  // *before* `appendVary` merges our own names in, which is the same verdict on a shorter
  // list. `sendCacheControl: false` opts out entirely (issue #49).
  const declaredVary = res.headers.get("vary");
  if (
    opts.sendCacheControl !== false &&
    isCacheableStatus(res.status) &&
    !hasVaryWildcard(declaredVary) &&
    !hasUnkeyedVary(declaredVary, varyHeaderNames) &&
    !res.headers.has("cache-control")
  ) {
    // The lifetimes `getMaxAge` resolved for *this* entry, else the static options — exactly
    // the precedence `cache.ts` applies to the freshness check and the storage TTL (finding
    // 10.2). Reading `opts` alone expired our own entry on the dynamic window while telling
    // every cache downstream the static one, which is most of a dynamic TTL's purpose gone.
    // `http/index.ts` always installs a `getMaxAge` wrapper, so both fields are always
    // *resolved* here — `undefined` meaning "no override", never "not asked".
    const maxAge = entry.maxAge ?? opts.maxAge;
    const staleMaxAge = entry.staleMaxAge ?? opts.staleMaxAge;

    const cacheControl = [];
    // `maxAge` is treated identically with and without `swr` — present (`0` included) is
    // advertised. So `validate` reads a zero lifetime out of our header as out of a
    // hand-written one, i.e. `maxAge: 0` keeps the response out of storage (it was written
    // already expired anyway).
    if (maxAge != null) {
      // Both cache kinds get the same number, and it is the one ocache itself enforces:
      // `s-maxage` overrides `max-age` in a shared cache (RFC 9111 §5.2.2.10) so nothing
      // changes for CDNs, while a *private* cache finally gets a freshness lifetime at all.
      // It had none before: `s-maxage` doesn't apply to it, so it fell back to heuristic
      // freshness (§4.2.2) over `Date - Last-Modified` — and `last-modified` is stamped at
      // fill time, so that is ≈ 0 and browsers revalidated on every navigation while the
      // server held the entry for `maxAge` (finding 10.3). `s-maxage` stays alongside it
      // rather than being folded away: it is what authorizes a shared cache to store the
      // response to an `Authorization`-carrying request at all (§3.5, reachable under
      // `allowAuthorization`), and `sendCacheControl: false` is the knob for wanting neither.
      cacheControl.push(`max-age=${maxAge}`);
      if (opts.swr) {
        cacheControl.push(`s-maxage=${maxAge}`);
      }
    }
    // Only ever with a delta-seconds. RFC 5861 §3 requires the argument, so the bare token we
    // used to emit for the ISR shape (`swr` with no `staleMaxAge`) was unparseable and had to
    // be ignored wholesale (RFC 9111 §5.2.3) — the window evaporated downstream while reading
    // as if it hadn't (finding 10.4). Nothing replaces it, because that shape's stale window
    // is *unbounded* (the entry is retained until the backend evicts it by capacity): there is
    // no honest number, and any invented one would advertise a stale window ocache cannot
    // promise. Silence is the strict direction — downstream revalidates when `max-age` runs
    // out and ocache answers that from its own stale entry, so ISR still happens, one layer in.
    if (opts.swr && staleMaxAge != null) {
      cacheControl.push(`stale-while-revalidate=${staleMaxAge}`);
    }
    if (cacheControl.length > 0) {
      res.headers.set("cache-control", cacheControl.join(", "));
    }
  }

  // Advertise the request headers this response varies on, merging with any `Vary` the
  // handler set. `varyHeaderNames`, not the key list: `allowCookies` keys on a hashed cookie
  // subset, but downstream caches can only be told at header granularity.
  if (varyHeaderNames.length > 0) {
    appendVary(res.headers, varyHeaderNames);
  }

  // No Set-Cookie ever survives a cacheable route — allowlisted or not, stored or served.
  // A cacheable response is shared with every later hit and every coalesced peer, so a minted
  // cookie reaches callers it wasn't minted for (issue #61; excepting `allowCookies` names
  // reopened it as session fixation, h3#1524 finding #15c). `allowCookies` is request-side
  // only; a handler that must mint one serves it from a bypassed (non-GET/HEAD) route.
  res.headers.delete("set-cookie");

  // The body is stored fully decoded and re-buffered, so replaying a stored
  // `content-encoding`/`content-length`/`transfer-encoding` would desync the headers from the
  // served bytes (nitro#2109). The runtime recomputes `content-length` on read.
  for (const header of transportHeaders) {
    res.headers.delete(header);
  }

  const cacheEntry: ResponseCacheEntry = {
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers.entries()),
    body,
    // Only set for binary bodies — text entries stay flag-free and byte-identical to
    // pre-binary-support ones.
    ...(base64 && { base64: true }),
  };

  return cacheEntry;
}

/**
 * The read half: a stored entry → the pieces its `Response` is rebuilt from (pieces, because
 * the construction itself is the caller's `createResponse` hook). Mirrors
 * {@link serializeResponse}: a null-body status is forced back to `null` (`""` is not nullish
 * and `new Response("", { status: 204 })` throws), and a `base64` entry decodes to raw bytes.
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

// Fatal decoder so invalid UTF-8 throws (→ base64) instead of substituting replacement
// characters. `ignoreBOM` keeps a leading BOM in the string so it re-encodes byte-for-byte,
// preserving the lossless roundtrip that lets valid UTF-8 be stored as a plain string.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes bytes as UTF-8, returning `undefined` when they aren't valid UTF-8 (i.e. binary). */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/** Encodes raw bytes to a base64 string (chunked to stay within `String.fromCharCode` arg limits). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x80_00;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decodes a base64 string produced by {@link bytesToBase64} back to raw bytes. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
