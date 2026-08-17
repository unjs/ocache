// Key composition and request narrowing must use these same filtered values.

/**
 * Headers that remain visible unchanged without separate key components.
 *
 * Conditional headers can produce only non-storable responses.
 * Trace headers support propagation but must not affect rendered output.
 *
 * `host` is not one of them: `request.ts` replaces it with the keyed URL authority.
 *
 * `ReadonlySet` rather than `Object.freeze`, which does not stop `Set` mutation.
 */
export const safeHeaderNames: ReadonlySet<string> = /* @__PURE__ */ new Set([
  "if-modified-since",
  "if-none-match",
  "traceparent",
  "tracestate",
  "x-correlation-id",
  "x-request-id",
]);

/**
 * Returns an order-independent query with only allowed names.
 *
 * Pure, so key composition and URL rewriting agree without shared per-request state.
 */
export function filterSearch(url: URL, names: string[]): string {
  const filtered = new URLSearchParams();
  for (const name of names) {
    for (const value of url.searchParams.getAll(name).sort()) {
      filtered.append(name, value);
    }
  }
  const query = filtered.toString();
  return query ? `?${query}` : "";
}

/** Returns an order-independent Cookie header with only allowed names. */
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
