// The allowlist filters. `key.ts` hashes what these return and `request.ts` hands it to the
// handler — the directory's one rule, a handler may read exactly what the key covers — so
// neither side may compute "the allowlisted subset" on its own. Here, so neither imports the
// other.

import type { HandlerConfig } from "./config.ts";

import type { HTTPEvent } from "../types.ts";

/**
 * The only headers a handler may read *without* the key covering them — every other
 * undeclared name is stripped by `narrowRequest`. Each earns its place by being unusable
 * as a rendering input, because `varies` is no escape hatch for any of them:
 *
 * - `host` — already keyed, via the URL authority `resolveKey` hashes.
 * - `if-none-match` / `if-modified-since` — read by `defaultHandleCacheHeaders` *after*
 *   narrowing has mutated the event, so stripping them would kill the 304 on every MISS.
 *   Safe to forward: the only responses they can produce (304, 412) are off the status
 *   allowlist (`validate.ts`), so nothing derived from them is ever stored.
 * - the propagation headers — carried for logging/tracing, and per-request-unique by
 *   construction: a handler rendering from one produces something no key could cover.
 *   Deliberately NOT here: `user-agent` (device/bot branching is a real rendering input)
 *   and `baggage` (OTel's is app-readable tenant/flag context). Declare those in `varies`.
 */
export const safeHeaderNames = new Set([
  "host",
  "if-modified-since",
  "if-none-match",
  "traceparent",
  "tracestate",
  "x-correlation-id",
  "x-request-id",
]);

// Memoized per event so the key derivation and the URL rewrite don't recompute it.
export function filteredSearch<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  event: HTTPEvent,
  url: URL,
): string {
  let search = config.searchCache.get(event);
  if (search === undefined) {
    search = filterSearch(url, config.allowedQueryNames!);
    config.searchCache.set(event, search);
  }
  return search;
}

/** Rebuilds the query string from only the allowlisted param names, order-independent. */
function filterSearch(url: URL, names: string[]): string {
  const filtered = new URLSearchParams();
  for (const name of names) {
    for (const value of url.searchParams.getAll(name).sort()) {
      filtered.append(name, value);
    }
  }
  const query = filtered.toString();
  return query ? `?${query}` : "";
}

/** Rebuilds the `Cookie` header from only the allowlisted cookie names, sorted (order-independent). */
export function filterCookie(header: string | null | undefined, names: string[]): string {
  if (!header) {
    return "";
  }
  const kept: Array<[string, string]> = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    const name = (eq < 0 ? part : part.slice(0, eq)).trim();
    if (name && names.includes(name)) {
      kept.push([name, eq < 0 ? "" : part.slice(eq + 1).trim()]);
    }
  }
  kept.sort((a, b) =>
    a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1,
  );
  return kept.map(([n, v]) => `${n}=${v}`).join("; ");
}
