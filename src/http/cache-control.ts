// Docs: @docs/8.cache-control.md, @docs/9.isr.md

/**
 * Returns whether `Cache-Control` forbids reuse by a shared cache.
 *
 * `s-maxage` overrides `max-age` per RFC 9111 section 5.2.2.10.
 * `must-revalidate` limits stale reuse but does not forbid storage.
 */
export function cacheControlForbidsReuse(cacheControl: unknown): boolean {
  if (typeof cacheControl !== "string" || !cacheControl) {
    return false;
  }
  // Collect both lifetimes before applying shared-cache precedence.
  let maxAge: number | undefined;
  let sMaxAge: number | undefined;
  for (const [name, value] of cacheControlDirectives(cacheControl)) {
    switch (name) {
      case "no-store":
      case "private": {
        return true;
      }
      // ocache cannot validate every reuse as RFC 9111 section 5.2.2.4 requires.
      case "no-cache": {
        return true;
      }
      case "max-age": {
        maxAge ??= deltaSeconds(value);
        break;
      }
      case "s-maxage": {
        sMaxAge ??= deltaSeconds(value);
        break;
      }
    }
  }
  const shared = sMaxAge ?? maxAge;
  return shared !== undefined && shared <= 0;
}

/** Returns whether stale reuse requires revalidation. */
export function requiresRevalidation(cacheControl: unknown): boolean {
  if (typeof cacheControl !== "string" || !cacheControl) {
    return false;
  }
  return cacheControlDirectives(cacheControl).some(([name]) => name === "must-revalidate");
}

/** Parses directives, including quoted values that contain commas. */
function cacheControlDirectives(value: string): Array<[string, string | undefined]> {
  const directives: Array<[string, string | undefined]> = [];
  let token = "";
  let quoted = false;
  const flush = () => {
    const directive = token.trim();
    token = "";
    if (!directive) {
      return;
    }
    const eq = directive.indexOf("=");
    const name = (eq < 0 ? directive : directive.slice(0, eq)).trim().toLowerCase();
    if (!name) {
      return;
    }
    let raw = eq < 0 ? undefined : directive.slice(eq + 1).trim();
    if (raw !== undefined && raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      raw = raw.slice(1, -1);
    }
    directives.push([name, raw]);
  };
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (quoted) {
      // A quoted pair escapes the next character.
      if (char === "\\") {
        token += char + (value[++i] ?? "");
        continue;
      }
      if (char === '"') {
        quoted = false;
      }
      token += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      token += char;
      continue;
    }
    if (char === ",") {
      flush();
      continue;
    }
    token += char;
  }
  flush();
  return directives;
}

/**
 * Parses RFC 9111 delta-seconds.
 * Accepts negative values as expired and ignores malformed values.
 */
function deltaSeconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value)) {
    return undefined;
  }
  return Number(value);
}
