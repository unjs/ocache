import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { digest as portableDigest } from "../lib/digest.mjs";
import { digest as nodeDigest } from "../lib/digest.node.mjs";
import { hash, serialize } from "../src/hash.ts";

// `hash`/`serialize` are a storage format, not an implementation detail: their output *is* every
// cache key and every `integrity` field, so these tests pin the properties the rest of the
// codebase relies on (`.agents/hash.md`) — determinism, unambiguous type tagging, member-order
// insensitivity, termination — rather than any particular digest string.
describe("hash", () => {
  it("is a base64url sha256", () => {
    const digest = hash("value");
    expect(digest).toMatch(/^[\w-]{43}$/);
    // Stable across calls, and equal for equal values built independently.
    expect(hash("value")).toBe(digest);
    expect(hash(["a", { b: 1 }])).toBe(hash(["a", { b: 1 }]));
  });

  it("keeps values of different types apart", () => {
    const digests = [
      null,
      undefined,
      "null",
      "undefined",
      1,
      "1",
      1n,
      true,
      "true",
      [1],
      { 0: 1 },
      new Set([1]),
      new Map([["a", 1]]),
      { a: 1 },
      ["a,b"],
      ["a", "b"],
    ].map((value) => hash(value));
    expect(new Set(digests).size).toBe(digests.length);
  });
});

// Which arm of `#crypto` a consumer gets is decided by *their* bundler's conditions, not by this
// process: `node` resolves to `node:crypto`, everything else to the portable sha256. A key must
// not depend on that choice — one persistent backend can be written by a Node process and read
// by a worker — so both arms are imported by path here and held against Node's own digest.
describe("#crypto arms", () => {
  const inputs = [
    "",
    "a",
    // Around the 56-byte padding boundary (a length that no longer fits its own block).
    "x".repeat(54),
    "x".repeat(55),
    "x".repeat(56),
    "x".repeat(63),
    "x".repeat(64),
    "x".repeat(65),
    "x".repeat(119),
    "x".repeat(120),
    // Multi-block, and a response-body-sized one.
    "x".repeat(1000),
    "abc".repeat(50_000),
    // Multi-byte UTF-8: the digest is over the encoded bytes, not the code units. Both sides of
    // the portable arm's ASCII fast path — a non-ASCII code unit after an ASCII run, and a long
    // multi-byte string — have to reach the same encoder as `node:crypto` does.
    "héllo · 世界 · 🔑",
    "x".repeat(200) + "é",
    "世界".repeat(200),
  ];

  it("agree with `node:crypto` on every message-padding case", () => {
    for (const input of inputs) {
      const expected = createHash("sha256").update(input).digest("base64url");
      expect(portableDigest(input), `portable, for a ${input.length}-char input`).toBe(expected);
      expect(nodeDigest(input), `node, for a ${input.length}-char input`).toBe(expected);
    }
  });

  it("are what `hash` is wired to", () => {
    // Whichever arm this test run resolved, `hash` must be `digest(serialize(value))` — the
    // serialized form is the thing hashed, never the value's own `toString`.
    for (const value of ["value", { a: 1, b: [2, 3] }, () => 1, null]) {
      expect(hash(value)).toBe(portableDigest(serialize(value)));
    }
  });
});

describe("serialize", () => {
  // Cache keys are built from URLs, headers, cookies, and call arguments, so the rendering has to
  // stay unambiguous for text an attacker picks. Every place text is embedded is length-prefixed:
  // a value that contains the characters the format uses as separators cannot move a boundary and
  // land on a key that belongs to another input.
  it("keeps chosen inputs from imitating a member boundary", () => {
    const cases: unknown[][] = [
      // The reported collision: a quote and a separator inside an array element.
      [
        ["alice','scope", "doc"],
        ["alice", "scope','doc"],
      ],
      [["a", "b"], ["a','b"], ["a'", "'b"]],
      // The same, moved into a key, a Map key, and a Set member.
      [{ "a:1,b": 2 }, { a: 1, b: 2 }, { "a:1": ",b:2" }],
      [new Map([["a:1,b", 2]]), new Map<string, number>([["a", 1], ["b", 2]])], // prettier-ignore
      [new Set(["a,b"]), new Set(["a", "b"])],
      // A tag is not a name a value can claim by spelling it out.
      [new URL("http://a.example/x"), "URL(http://a.example/x)", ["URL(http://a.example/", "x)"]],
      [/a/g, "RegExp(/a/g)"],
      [new Error("boom"), "Error(Error: boom)"],
      [Symbol("a,b"), "Symbol(a,b)", [Symbol("a"), Symbol("b")], Symbol()],
    ];
    for (const group of cases) {
      const rendered = group.map((value) => serialize(value));
      expect(new Set(rendered).size, rendered.join(" | ")).toBe(group.length);
    }
  });

  // A function is rendered as source text, which is text a caller can also pass as a string.
  it("keeps a function apart from a string of the same source", () => {
    const fn = () => 1;
    expect(serialize(fn)).not.toBe(
      serialize(`${fn.name}(${fn.length})${Function.prototype.toString.call(fn)}`),
    );
  });

  it("sorts object, Map and Set members so order is not part of the identity", () => {
    expect(serialize({ a: 1, b: 2 })).toBe(serialize({ b: 2, a: 1 }));
    expect(
      serialize(
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
      ),
    ).toBe(
      serialize(
        new Map([
          ["b", 2],
          ["a", 1],
        ]),
      ),
    );
    expect(serialize(new Set([1, 2]))).toBe(serialize(new Set([2, 1])));
    // Sorting on the rendered pair gives a `Map` keyed by objects a total order too.
    const first = { id: 1 };
    const second = { id: 2 };
    expect(
      serialize(
        new Map([
          [first, "a"],
          [second, "b"],
        ]),
      ),
    ).toBe(
      serialize(
        new Map([
          [second, "b"],
          [first, "a"],
        ]),
      ),
    );
    // Arrays are ordered values, not members: their order *is* the identity.
    expect(serialize([1, 2])).not.toBe(serialize([2, 1]));
  });

  it("renders functions by name and source", () => {
    // Two anonymous functions of identical source — what `resolveName`'s `anon_<hash>` fallback
    // rides on, and the reason equal-source functions differing only in a closed-over variable
    // share a name.
    expect(serialize(() => 1)).toBe(serialize(() => 1));
    expect(serialize(() => 1)).not.toBe(serialize(() => 2));
    // The inferred name is part of it: `const a = () => 1` is not `const b = () => 1`.
    const a = () => 1;
    const b = () => 1;
    expect(serialize(a)).not.toBe(serialize(b));
    // Line breaks are collapsed, so reindentation alone does not rotate every key.
    expect(
      serialize(function named(x: number) {
        return x;
      }),
    ).toBe(serialize(function named(x: number) { return x; })); // prettier-ignore
  });

  it("terminates on cycles and still separates them from their acyclic twin", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => serialize(cyclic)).not.toThrow();
    // The back-reference is what terminates it; it must not read as the acyclic lookalike.
    expect(serialize(cyclic)).not.toBe(serialize({ a: 1, self: { a: 1 } }));
    const twin: Record<string, unknown> = { a: 1 };
    twin.self = twin;
    expect(serialize(cyclic)).toBe(serialize(twin));

    // A repeated (non-cyclic) reference renders in full, both times.
    const shared = { a: 1 };
    expect(serialize([shared, shared])).toBe(serialize([{ a: 1 }, { a: 1 }]));
  });

  it("renders built-ins by value, not by identity", () => {
    expect(serialize(new Date(0))).toBe(serialize(new Date(0)));
    expect(serialize(new Date(0))).not.toBe(serialize(new Date(1)));
    // Every invalid date is the same value here, and none of them throws.
    expect(serialize(new Date(Number.NaN))).toBe(serialize(new Date("nope")));
    expect(serialize(/a/g)).toBe(serialize(/a/g));
    expect(serialize(/a/g)).not.toBe(serialize(/a/i));
    expect(serialize(new URL("http://a.example/x"))).toBe(serialize(new URL("http://a.example/x")));
    expect(serialize(new URL("http://a.example/x"))).not.toBe(
      serialize(new URL("http://b.example/x")),
    );
    // Element values, never the machine's byte order — and the view type is part of the tag.
    expect(serialize(new Int32Array([1, 2]))).toBe(serialize(new Int32Array([1, 2])));
    expect(serialize(new Int32Array([1, 2]))).not.toBe(serialize(new Uint8Array([1, 2])));
    expect(serialize(new Uint8Array([1, 2]).buffer)).toBe(serialize(new Uint8Array([1, 2]).buffer));
    expect(serialize(new Uint8Array([1, 2]).buffer)).not.toBe(
      serialize(new Uint8Array([2, 1]).buffer),
    );
    // A `DataView` has no `join`; it is read as the bytes it spans.
    expect(serialize(new DataView(new Uint8Array([1, 2]).buffer))).toBe(
      serialize(new DataView(new Uint8Array([1, 2]).buffer)),
    );
    expect(serialize(new DataView(new Uint8Array([1, 2]).buffer))).not.toBe(
      serialize(new DataView(new Uint8Array([2, 1]).buffer)),
    );
  });

  it("distinguishes class instances that share their own enumerable properties", () => {
    class A {
      constructor(public x: number) {}
    }
    class B {
      constructor(public x: number) {}
    }
    expect(serialize(new A(1))).toBe(serialize(new A(1)));
    expect(serialize(new A(1))).not.toBe(serialize(new B(1)));
    expect(serialize(new A(1))).not.toBe(serialize({ x: 1 }));

    // State the class keeps out of its own enumerable properties is only reachable via `toJSON`.
    class Private {
      #value: number;
      constructor(value: number) {
        this.#value = value;
      }
      toJSON() {
        return this.#value;
      }
    }
    expect(serialize(new Private(1))).not.toBe(serialize(new Private(2)));
  });

  it("hashes a null-prototype object like the plain object it mirrors", () => {
    const bare = Object.assign(Object.create(null), { a: 1 });
    expect(serialize(bare)).toBe(serialize({ a: 1 }));
  });
});
