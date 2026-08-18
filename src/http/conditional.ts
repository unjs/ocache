import type { HTTPEvent, CacheConditions, ResponseCacheEntry } from "../types.ts";

/**
 * Reads the conditional request headers before narrowing removes them.
 *
 * Narrowing forwards only what the key covers, and no key covers a validator, so
 * `event.req` no longer carries these by the time the 304 decision runs. Capture
 * them from the original request and pass them through {@link CacheConditions}.
 */
export function readConditions(
  event: HTTPEvent,
): Pick<CacheConditions, "ifNoneMatch" | "ifModifiedSince"> {
  return {
    ifNoneMatch: event.req.headers.get("if-none-match") ?? undefined,
    ifModifiedSince: event.req.headers.get("if-modified-since") ?? undefined,
  };
}

/**
 * Decides `304 Not Modified` from the request's conditional headers.
 *
 * RFC 9110 section 13.2.2 gives `If-None-Match` precedence: when it is present the
 * date check never runs, so a client holding a different representation gets the
 * full response instead of a `304` from an unrelated `If-Modified-Since`.
 */
export function defaultHandleCacheHeaders(_event: HTTPEvent, conditions: CacheConditions): boolean {
  const { ifNoneMatch, ifModifiedSince } = conditions;
  if (ifNoneMatch) {
    return matchesIfNoneMatch(ifNoneMatch, conditions.etag);
  }

  if (ifModifiedSince && conditions.modifiedTime) {
    if (new Date(ifModifiedSince) >= conditions.modifiedTime) {
      return true;
    }
  }

  return false;
}

/**
 * `If-None-Match` uses the weak comparison of RFC 9110 section 8.8.3.2, so `W/"x"`
 * and `"x"` match. `*` matches whenever a representation exists.
 */
function matchesIfNoneMatch(ifNoneMatch: string, etag: string | undefined): boolean {
  if (ifNoneMatch.trim() === "*") {
    // Reaching here means an entry was found, so a representation exists.
    return true;
  }
  if (!etag) {
    return false;
  }
  const current = weakTag(etag);
  return entityTags(ifNoneMatch).some((tag) => weakTag(tag) === current);
}

function weakTag(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
}

/**
 * Splits an entity-tag list. A quoted tag may contain `,` (RFC 9110 section 8.8.3),
 * so scan quoted strings instead of splitting on commas.
 */
function entityTags(value: string): string[] {
  const tags: string[] = [];
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (char === "," || char === " " || char === "\t") {
      index++;
      continue;
    }
    const start = index;
    if (value.startsWith("W/", index)) {
      index += 2;
    }
    if (value[index] === '"') {
      const end = value.indexOf('"', index + 1);
      index = end === -1 ? value.length : end + 1;
    } else {
      // Unquoted tags are malformed but compared as sent.
      while (index < value.length && value[index] !== ",") {
        index++;
      }
    }
    tags.push(value.slice(start, index).trim());
  }
  return tags;
}

/**
 * Headers a 304 repeats from the representation it stands in for (RFC 9110 §15.4.5).
 *
 * The validators let a client update the stored response it revalidated, and the
 * policy fields refresh its freshness lifetime. `Vary` preserves the variant
 * dimensions (RFC 7232 §4.1).
 */
const notModifiedHeaderNames: readonly string[] = /* @__PURE__ */ Object.freeze([
  "cache-control",
  "content-location",
  "date",
  "etag",
  "expires",
  "last-modified",
  "vary",
]);

/**
 * Returns the cached headers that a 304 response must repeat.
 */
export function notModifiedHeaders(
  headers: ResponseCacheEntry["headers"] | Headers,
  statusHeader: string | undefined,
): Record<string, string> | undefined {
  // `headersOnly` has no stored entry, so it reads a live response instead.
  const read = (name: string) =>
    headers instanceof Headers
      ? (headers.get(name) ?? undefined)
      : (headers[name] as string | undefined);
  const notModified: Record<string, string> = {};
  const statusValue = statusHeader ? read(statusHeader) : undefined;
  if (statusValue !== undefined) {
    notModified[statusHeader!] = statusValue;
  }
  for (const name of notModifiedHeaderNames) {
    const value = read(name);
    if (value !== undefined) {
      notModified[name] = value;
    }
  }
  return Object.keys(notModified).length > 0 ? notModified : undefined;
}
