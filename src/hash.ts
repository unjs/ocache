// The `#crypto` package condition selects Node or portable SHA-256 at bundle time.
// Both implementations must return identical digests for shared storage.
// Keep serialization allocation-light because cache-key paths call it per request.

import { digest } from "#crypto";

/** Returns a base64url SHA-256 digest of the serialized input. */
export function hash(input: unknown): string {
  return digest(serialize(input));
}

/**
 * Renders values in a deterministic, type-tagged storage format.
 *
 * Text is length-prefixed, so distinct inputs never share a rendering.
 * Object, Map, and Set order does not affect the result.
 * Cycles use visit-order references.
 * Functions use source text, so equal-source closures are indistinguishable.
 */
export function serialize(input: unknown): string {
  // Strings do not need cycle tracking.
  return typeof input === "string" ? serString(input) : ser(input, new Map<object, string>());
}

/**
 * Renders text as `'<code units>:<text>`.
 *
 * Every rendering that embeds caller-controlled text goes through this function. The length
 * prefix is what makes the result unambiguous: the reader consumes exactly that many code units,
 * so no chosen input can imitate the `,`, `:`, `}`, or `]` that separate members.
 */
function serString(value: string): string {
  return `'${value.length}:${value}`;
}

function ser(value: unknown, seen: Map<object, string>): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string": {
      return serString(value);
    }
    case "bigint": {
      return `${value}n`;
    }
    case "symbol": {
      // A described symbol must not read as `Symbol()`, so the two cases stay apart.
      return value.description === undefined ? "Symbol()" : `Symbol${serString(value.description)}`;
    }
    case "function": {
      // The tag keeps a function apart from a string of its own source text.
      return `Function${serString(`${value.name}(${value.length})${Function.prototype.toString.call(value).replace(/\s*\n\s*/g, "")}`)}`;
    }
    case "object": {
      const ref = seen.get(value);
      if (ref !== undefined) {
        return ref;
      }
      seen.set(value, `#${seen.size}`);
      const serialized = serObject(value, seen);
      seen.set(value, serialized);
      return serialized;
    }
    default: {
      return String(value);
    }
  }
}

function serObject(value: object, seen: Map<object, string>): string {
  if (Array.isArray(value)) {
    let items = "";
    for (let index = 0; index < value.length; index++) {
      items += index === 0 ? ser(value[index], seen) : `,${ser(value[index], seen)}`;
    }
    return `[${items}]`;
  }
  const ctor = (value as { constructor?: { name?: string } | null }).constructor;
  // Tag class instances, but keep common plain objects untagged. Parsed input can carry an own
  // `constructor` key, so a null one reads as a plain object like a null prototype does.
  if (ctor === Object || ctor == null) {
    return serProperties("", value, seen);
  }
  if (value instanceof Date) {
    // Render all invalid dates identically without calling `toISOString`.
    return `Date(${Number.isNaN(value.getTime()) ? "null" : value.toISOString()})`;
  }
  if (value instanceof RegExp || value instanceof URL || value instanceof Error) {
    // A URL, a pattern, and a message are all caller-controlled text.
    return `${value.constructor.name}${serString(String(value))}`;
  }
  if (value instanceof Set) {
    const parts: string[] = [];
    for (const item of value) {
      parts.push(ser(item, seen));
    }
    return `Set[${parts.sort().join(",")}]`;
  }
  if (value instanceof Map) {
    // Sort rendered pairs because Map keys may not be comparable.
    const parts: string[] = [];
    for (const [key, item] of value) {
      parts.push(`${ser(key, seen)}:${ser(item, seen)}`);
    }
    return `Map{${parts.sort().join(",")}}`;
  }
  if (value instanceof ArrayBuffer) {
    return `ArrayBuffer[${new Uint8Array(value).join(",")}]`;
  }
  if (ArrayBuffer.isView(value)) {
    // Element values keep typed-array hashes independent of machine endianness.
    const items =
      "join" in value
        ? (value as unknown as number[]).join(",")
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).join(",");
    return `${value.constructor.name}[${items}]`;
  }
  return serProperties(ctor.name || "", value, seen);
}

// Prefer `toJSON` because enumerable properties omit private state and getters.
function serProperties(tag: string, value: object, seen: Map<object, string>): string {
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    return `${tag}(${ser(toJSON.call(value), seen)})`;
  }
  // Use code-unit order; locale-dependent order would change keys across machines.
  const keys = Object.keys(value).sort();
  let parts = "";
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    // A key is caller-controlled text like any other; render it the same way.
    parts += index === 0 ? `${serString(key)}:` : `,${serString(key)}:`;
    parts += ser((value as Record<string, unknown>)[key], seen);
  }
  return `${tag}{${parts}}`;
}
