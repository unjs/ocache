import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hash as ohashHash } from "ohash";

import { digest } from "../src/crypto.ts";
import { hash } from "../src/hash.ts";
import { cachedFunction, createMemoryStorage } from "../src/index.ts";

// `src/crypto.ts` is only ever loaded on non-Node platforms (the `#crypto` condition sends
// Node at `ohash/crypto`), so it is imported here by path rather than through `#crypto` —
// otherwise the suite, running on Node, would test the native digest and never this one.
const nodeDigest = (message: string): string =>
  createHash("sha256").update(message, "utf8").digest("base64url");

/**
 * xorshift32 — a seeded PRNG, so "500 random inputs" is the same 500 on every run and a
 * failure is reproducible instead of a once-a-month CI mystery.
 */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x1_0000_0000;
  };
}

describe("compact SHA-256 digest", () => {
  // Block-boundary lengths are where a padding bug hides: 55 is the last length that fits its
  // length field in the first block, 56 forces a second, 64 is exactly one block.
  const vectors = [
    "",
    "a",
    "abc",
    "hello world",
    "x".repeat(55),
    "x".repeat(56),
    "x".repeat(57),
    "x".repeat(63),
    "x".repeat(64),
    "x".repeat(65),
    "x".repeat(119),
    "x".repeat(120),
    "日本語テキスト", // 3-byte sequences
    "\u{1F600}\u{1F389}\u{1D54F}", // astral, surrogate pairs
    "\0߿ࠀ￿", // UTF-8 length boundaries
    "x".repeat(100_000), // ≥ 100 kB, the response-body case
    "\u{1F600}".repeat(30_000), // ≥ 100 kB of 4-byte sequences
  ];

  it.each(vectors.map((v, i) => [i, v.length] as const))(
    "matches node:crypto on fixed vector %i (%i chars)",
    (i) => {
      const input = vectors[i]!;
      expect(digest(input)).toBe(nodeDigest(input));
    },
  );

  it("matches node:crypto across 500 random unicode inputs", () => {
    const next = rng(0x0c_ac_e5_17);
    const mismatches: string[] = [];
    for (let i = 0; i < 500; i++) {
      const length = Math.floor(next() * 400);
      let input = "";
      for (let j = 0; j < length; j++) {
        const pick = next();
        input +=
          pick < 0.35
            ? String.fromCodePoint(Math.floor(next() * 0x80)) // ascii
            : pick < 0.7
              ? String.fromCodePoint(0x80 + Math.floor(next() * 0xd000)) // 2/3-byte BMP
              : String.fromCodePoint(0x1_0000 + Math.floor(next() * 0xf_ffff)); // astral
      }
      if (digest(input) !== nodeDigest(input)) mismatches.push(JSON.stringify(input));
    }
    expect(mismatches).toEqual([]);
  });

  it("emits an unpadded 43-character base64url digest", () => {
    expect(digest("abc")).toMatch(/^[\w-]{43}$/);
  });

  // ohash's own JS fallback encodes via `unescape(encodeURIComponent(s))`, which throws a
  // URIError here; `TextEncoder` substitutes U+FFFD exactly as `node:crypto` does. So this is
  // an input that used to hash on Node and throw on the edge, and now agrees on both.
  it("substitutes lone surrogates like node:crypto rather than throwing", () => {
    const input = "a\uD800b";
    expect(digest(input)).toBe(nodeDigest(input));
  });
});

describe("hash()", () => {
  const values: [label: string, value: unknown][] = [
    ["empty string", ""],
    ["path", "/blog/hello"],
    ["authority + path tuple", ["https://example.com", "/blog/hello?page=2"]],
    ["options object", { maxAge: 60, swr: true, staleMaxAge: 600 }],
    ["mixed array", ["a", 1, null, true]],
    ["Set", new Set([1, 2, 3])],
    ["Map", new Map([["a", 1]])],
    ["RegExp", /x/g],
    ["null", null],
    ["undefined", undefined],
    ["response body", "hello /hello"],
  ];

  it.each(values)("agrees with ohash.hash() for %s", (_label, value) => {
    expect(hash(value)).toBe(ohashHash(value));
  });

  // Pinned literals, not a comparison. `hash()` composes every cache key and every
  // `integrity` value, so its output is a storage-compatibility surface: if an edit here
  // moves a single character, every entry in every deployed store goes cold (best case) or
  // collides with a differently-keyed one (worst). The values below were produced by
  // `ohash.hash()` before the digest was swapped — a diff on this test is the alarm.
  it("produces the exact digests recorded before the digest implementation changed", () => {
    expect(Object.fromEntries(values.map(([label, value]) => [label, hash(value)])))
      .toMatchInlineSnapshot(`
        {
          "Map": "4B1ZATgkYj_9F31yBb5oHXU6Z5Gy1GMSfmQzAwzKRb8",
          "RegExp": "0nDb8OcDxrqD5Q3PLvQsxN9rYE8btPRozphB9eq6SUc",
          "Set": "Jc7x0nqFx77EWkTrrt2PELw53FxHwaF_JDBFsh0tDJo",
          "authority + path tuple": "zB1eASxUWXQj1f8Th-1E-YrEpGii2omD02AkLIeoZic",
          "empty string": "b0nNvYDhuV1eZCfhUB_CF3kNruhwVfpbTnEGQoi93t4",
          "mixed array": "y79LGOP81obilCE7A0qDrM59dlqbs-amnyR4jtjWpyI",
          "null": "dCNOmK_nSY-12vHzasLXiswzlGT5UHA7jAGYkvmCuQs",
          "options object": "nbBY4k0BiEo94CnLEkB3M1H2aCUODRsf69zQ3Awmpjo",
          "path": "m6r7ZC0V9RKQhnBq7VbzJ0LyyWagMdfod7utN8wso4Q",
          "response body": "VBWs0zVdcsW5nlTtg6OxFYm27lYe4kxXC-2CxAfb7m8",
          "undefined": "6wRdeNJzEHNIsDAMAdKbdVLWIqu8b6-Bs-xVNZqplQw",
        }
      `);
  });
});

// The serializer is the half of `hash()` deliberately *not* reimplemented, and this is why:
// a hand-rolled one that drops the `$Set`/`$Map`/`$RegExp` cases serializes every `Set` to
// `Set{}`, so two calls with different contents share a key and the second caller is handed
// the first one's value — silently, with no error anywhere. Nothing else in the suite pins
// that, so it pins it here.
describe("cachedFunction distinguishes structured arguments (serializer fidelity)", () => {
  const distinctValues: [label: string, a: unknown, b: unknown][] = [
    ["Set contents", new Set([1, 2, 3]), new Set([4, 5, 6])],
    ["Set size", new Set([1]), new Set([1, 2])],
    ["Map values", new Map([["a", 1]]), new Map([["a", 2]])],
    ["Map keys", new Map([["a", 1]]), new Map([["b", 1]])],
    ["RegExp source", /alpha/, /beta/],
    ["RegExp flags", /alpha/g, /alpha/i],
    ["Date", new Date(0), new Date(1000)],
  ];

  it.each(distinctValues)("keys %s apart", async (_label, a, b) => {
    // The resolver ignores its argument and just counts: two different results mean two
    // different keys, and a repeat of the first result means the first entry survived.
    // (Returning a function of the argument would not work — `JSON.stringify(new Set([1]))`
    // is `{}` for every `Set`, which is the very confusion under test.)
    let calls = 0;
    const fn = cachedFunction(async (_value: unknown) => ++calls, {
      name: "structured",
      storage: createMemoryStorage(),
      maxAge: 60,
    });

    const first = await fn(a);
    const second = await fn(b);

    expect(second).not.toBe(first);
    // And the first key is still readable — the two entries coexist rather than overwrite.
    expect(await fn(a)).toBe(first);
  });
});
