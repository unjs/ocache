// Docs: @docs/5.handler.md, @docs/7.cookies.md, @docs/8.cache-control.md

/**
 * Merges names into `Vary` and removes case-insensitive duplicates.
 * Leaves `Vary: *` unchanged.
 */
export function appendVary(headers: Headers, names: string[]): void {
  const existing = headers.get("vary");
  if (hasVaryWildcard(existing)) {
    return;
  }
  const seen = new Set<string>();
  const merged: string[] = [];
  const add = (raw: string) => {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(name);
  };
  if (existing) {
    for (const part of existing.split(",")) {
      add(part);
    }
  }
  for (const name of names) {
    add(name);
  }
  headers.set("vary", merged.join(", "));
}

/** Returns whether `Vary` contains a wildcard token. */
export function hasVaryWildcard(value: string | null | undefined): boolean {
  return !!value && value.split(",").some((part) => part.trim() === "*");
}

/**
 * Returns whether `Vary` names a request header that the cache key does not cover.
 *
 * Compare with the advertisement list because cookie allowlists use a subset key.
 * Malformed names fail closed.
 * Wildcards remain the responsibility of {@link hasVaryWildcard}.
 */
export function hasUnkeyedVary(value: string | null | undefined, keyed: string[]): boolean {
  return (
    !!value &&
    value.split(",").some((part) => {
      const name = part.trim().toLowerCase();
      return !!name && name !== "*" && !keyed.includes(name);
    })
  );
}
