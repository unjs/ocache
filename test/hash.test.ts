import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { digest as portableDigest } from "../lib/digest.mjs";
import { digest as nodeDigest } from "../lib/digest.node.mjs";
import { hash, hashBytes, serialize } from "../src/hash.ts";

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

  it("hashes bytes without serializing them", () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x80]);
    expect(hashBytes(bytes)).toMatch(/^[\w-]{43}$/);
    // `serialize` renders a typed array as `'10:Uint8Array[255,0,128]`, which is both a string
    // allocation per byte and a different digest. `hashBytes` covers the bytes themselves.
    expect(hashBytes(bytes)).toBe(createHash("sha256").update(bytes).digest("base64url"));
    expect(hashBytes(bytes)).not.toBe(hash(bytes));
  });

  it("hashes a byte view's own window, not its backing buffer", () => {
    // The portable arm reads the message in place through a `DataView` over the same buffer,
    // so a view with a non-zero `byteOffset` has to hash from where it starts.
    const backing = new Uint8Array(128).map((_, index) => index);
    const view = backing.subarray(64, 100);
    expect(hashBytes(view)).toBe(createHash("sha256").update(view).digest("base64url"));
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

  // A response body reaches `digest` as bytes rather than as text, and the same entry is read
  // back on whichever arm the reader resolved, so both must agree there too. The lengths repeat
  // the padding boundaries above because the bytes path skips `encode`, not the padding.
  it("agree with `node:crypto` on raw bytes", () => {
    const lengths = [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 150_000];
    for (const length of lengths) {
      // Include bytes that are not valid UTF-8, which is what sends a body down this path.
      const bytes = new Uint8Array(length).map((_, index) => (index * 7 + 0x80) & 0xff);
      const expected = createHash("sha256").update(bytes).digest("base64url");
      expect(portableDigest(bytes), `portable, for ${length} bytes`).toBe(expected);
      expect(nodeDigest(bytes), `node, for ${length} bytes`).toBe(expected);
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

  // A constructor name is caller-controlled text too — a class can be named `A{},B` — so a raw tag
  // could spell out the boundary between two members just like a string value could.
  it("keeps a class name from imitating a member boundary", () => {
    const Weird = { ["A{},B"]: class {} }["A{},B"]!;
    const Prefixed = { ["'1:a:1}"]: class {} }["'1:a:1}"]!;
    const A = class A {};
    const B = class B {};
    const cases: unknown[][] = [
      // The reported collision: one instance of a class named `A{},B` against an `A` and a `B`.
      [new Set([new Weird()]), new Set([new A(), new B()])],
      [[new Weird()], [new A(), new B()]],
      // A name that spells a length prefix is still consumed by its own prefix.
      [new Prefixed(), { a: 1 }, new (class {})()],
      // An anonymous class is not the plain object it used to hash as.
      [new (class {})(), {}],
      // A class cannot claim a built-in's rendering by taking its name.
      [new (class URL {})(), new URL("http://a.example/x"), "URL"],
      [new (class Set {})(), new Set(), new (class Map {})(), new Map()],
      [new (class Headers {})(), new Headers()],
      [new (class Uint8Array {})(), new Uint8Array(), new (class ArrayBuffer {})()],
      // Bytes and element values are different readings of the same memory.
      [new Uint8Array([1, 2]), new Uint8Array([1, 2]).buffer],
    ];
    for (const group of cases) {
      const rendered = group.map((value) => serialize(value));
      expect(new Set(rendered).size, rendered.join(" | ")).toBe(group.length);
    }
  });

  // Anything with no own enumerable property and no `toJSON` used to render as its bare tag, so
  // every value of the type shared one cache key. These are readable synchronously, so they are
  // rendered by value; `.agents/hash.md` records the ones that are not.
  it("renders opaque built-ins by value instead of collapsing them to a tag", () => {
    // Entry order is part of a `URLSearchParams`, so it is the one collection that is not sorted.
    expect(serialize(new URLSearchParams("a=1"))).not.toBe(serialize(new URLSearchParams("z=9")));
    expect(serialize(new URLSearchParams("a=1&a=2"))).not.toBe(
      serialize(new URLSearchParams("a=2&a=1")),
    );
    expect(serialize(new URLSearchParams("a=1&b=2"))).toBe(
      serialize(new URLSearchParams([["a", "1"], ["b", "2"]])), // prettier-ignore
    );
    // A query string is not the `URL` it came from, nor a plain string of the same text.
    expect(serialize(new URLSearchParams("a=1"))).not.toBe(serialize("a=1"));

    // Header iteration is spec'd to be sorted by lowercased name, so construction order drops out
    // without a sort of ours, and name case is not part of the identity.
    expect(serialize(new Headers({ a: "1" }))).not.toBe(serialize(new Headers({ b: "1" })));
    expect(serialize(new Headers({ a: "1" }))).not.toBe(serialize(new Headers({ a: "2" })));
    expect(
      serialize(
        new Headers([
          ["a", "1"],
          ["b", "2"],
        ]),
      ),
    ).toBe(
      // prettier-ignore
      serialize(new Headers([["b", "2"], ["a", "1"]])), // prettier-ignore
    );
    expect(serialize(new Headers({ "X-A": "1" }))).toBe(serialize(new Headers({ "x-a": "1" })));

    // A `SharedArrayBuffer` is not an `ArrayBuffer`, so it fell through to its tag.
    const shared = new SharedArrayBuffer(4);
    new Uint8Array(shared).set([1, 2, 3, 4]);
    expect(serialize(shared)).not.toBe(serialize(new SharedArrayBuffer(4)));
    expect(serialize(new SharedArrayBuffer(8))).not.toBe(serialize(new SharedArrayBuffer(4)));
    expect(serialize(shared)).not.toBe(serialize(new Uint8Array([1, 2, 3, 4]).buffer));
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
    // Line breaks collapse to a space, so reindentation alone does not rotate every key.
    expect(
      serialize(function named(x: number) {
        return x;
      }),
    ).toBe(serialize(function named(x: number) { return x; })); // prettier-ignore
  });

  // Source text is the whole identity of a function, so a collapsed line break must still hold
  // the tokens either side apart. Collapsing it to nothing merged them, and two functions that
  // merge share one `anon_<hash>` name and one `integrity` — they then overwrite each other.
  it("keeps a collapsed line break from joining the tokens either side", () => {
    // Held in an array so none of them takes an inferred name: the source text is the only thing
    // that separates them.
    const [broken, joined, spaced] = [
      () => `a
b`,
      () => `ab`,
      () => `a b`,
    ];
    expect(serialize(broken)).not.toBe(serialize(joined));
    // The same merge, in the body of a function that relies on ASI. Its source is built here so
    // that neither this file's formatter nor the test transform can rewrite the break away.
    // eslint-disable-next-line no-new-func
    expect(serialize(new Function("a\nb"))).not.toBe(serialize(new Function("ab")));

    // What a space cannot separate stays merged: inside a literal, a line break and a space are
    // the same rendering. Reindentation stability is what this buys, and `.agents/hash.md` says
    // so — an argument that turns on it needs an explicit `name` or `getKey`.
    expect(serialize(broken)).toBe(serialize(spaced));
    // A bound or native function has no source to tell it apart: `bound f` and the arity are all
    // that is left, so the bound arguments are invisible.
    const add = (a: number, b: number) => a + b;
    expect(hash(add.bind(null, 1))).toBe(hash(add.bind(null, 2)));
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
    // A `DataView` has no elements; it is read as the bytes it spans.
    expect(serialize(new DataView(new Uint8Array([1, 2]).buffer))).toBe(
      serialize(new DataView(new Uint8Array([1, 2]).buffer)),
    );
    expect(serialize(new DataView(new Uint8Array([1, 2]).buffer))).not.toBe(
      serialize(new DataView(new Uint8Array([2, 1]).buffer)),
    );
  });

  it("renders bytes as base64 and multi-byte elements by value", () => {
    // Decimal element values are about four characters and one string allocation per byte, and
    // a byte-sized view has no element reading distinct from its bytes, so it renders compactly.
    expect(serialize(new Uint8Array([255, 0, 128]))).toContain("/wCA");
    expect(serialize(new Uint8Array([255, 0, 128]))).not.toContain("255,0,128");
    expect(serialize(new Uint8Array([1, 2, 3]).buffer)).toContain("AQID");
    expect(serialize(new DataView(new Uint8Array([1, 2, 3]).buffer))).toContain("AQID");
    // A multi-byte view keeps its element rendering, which is what makes its hash independent
    // of the machine's byte order. Base64 of its memory would not be.
    expect(serialize(new Int32Array([1, 2]))).toContain("1,2");
    // The length prefix still bounds the rendering, so no byte value can imitate a boundary.
    expect(serialize({ a: new Uint8Array([255]) })).not.toBe(serialize({ a: new Uint8Array([]) }));
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

  // Call arguments come from parsed payloads, where `constructor` is an ordinary key. Reading a
  // tag off its value threw, which failed the call before the cached function ever ran.
  it("renders an own `constructor` key as data instead of reading a tag off it", () => {
    expect(() => serialize(JSON.parse('{"constructor":null}'))).not.toThrow();
    for (const value of [null, 0, "x", undefined]) {
      expect(serialize({ a: 1, constructor: value })).toBe(serialize({ constructor: value, a: 1 }));
    }
    // The key is still part of the identity, and no value of it can claim a class tag.
    expect(serialize({ constructor: null })).not.toBe(serialize({ constructor: undefined }));
    expect(serialize({ constructor: null })).not.toBe(serialize({}));
  });

  // Nesting is one stack frame per level, and the default `getKey` hashes call arguments, so a
  // 10 kB parsed body (`"[".repeat(5000)`) threw `RangeError: Maximum call stack size exceeded`
  // out of the cache layer before the wrapped function ever ran. Worse, the depth it gave out at
  // moved with the runtime, the JIT tier, and how much stack the caller had already used, so the
  // same argument could hash on one request and throw on the next. The ceiling replaces that with
  // one boundary that does not move, and an error that says what to do (`.agents/hash.md`).
  it("stops at a depth ceiling instead of overflowing the stack", () => {
    const nest = (depth: number) => {
      let value: unknown = { leaf: 1 };
      for (let index = 0; index < depth; index++) {
        value = { a: value };
      }
      return value;
    };
    // 128 levels: a leaf under 127 wrappers is the deepest value still rendered.
    expect(() => serialize(nest(127))).not.toThrow();
    expect(() => serialize(nest(128))).toThrow(RangeError);
    // The failure lands on a per-request key path, so the message has to carry the fix with it.
    expect(() => serialize(nest(128))).toThrow(/nested deeper than 128 levels/);
    expect(() => serialize(nest(128))).toThrow(/getKey/);
    // The reported input: previously a stack overflow, now the same deterministic refusal.
    expect(() => hash(JSON.parse("[".repeat(5000) + "]".repeat(5000)))).toThrow(RangeError);
  });

  // A guard that misses one recursive branch just moves the overflow into that branch. `toJSON` is
  // the one to watch: it hands back a fresh value that the `seen` map cannot stop, so it has to
  // count as a level like any other child.
  it("applies the ceiling to every branch that recurses", () => {
    const chains: Record<string, (depth: number) => unknown> = {
      array: (depth) => {
        let value: unknown = [1];
        for (let index = 0; index < depth; index++) value = [value];
        return value;
      },
      class: (depth) => {
        class Node {
          constructor(public inner: unknown) {}
        }
        let value: unknown = new Node(1);
        for (let index = 0; index < depth; index++) value = new Node(value);
        return value;
      },
      set: (depth) => {
        let value: unknown = new Set([1]);
        for (let index = 0; index < depth; index++) value = new Set([value]);
        return value;
      },
      mapKey: (depth) => {
        let value: unknown = new Map([[1, 1]]);
        for (let index = 0; index < depth; index++) value = new Map([[value, 1]]);
        return value;
      },
      mapValue: (depth) => {
        let value: unknown = new Map([[1, 1]]);
        for (let index = 0; index < depth; index++) value = new Map([[1, value]]);
        return value;
      },
      toJSON: (depth) => {
        let value: unknown = { toJSON: () => 1 };
        for (let index = 0; index < depth; index++) {
          const inner = value;
          value = { toJSON: () => inner };
        }
        return value;
      },
    };
    for (const [name, chain] of Object.entries(chains)) {
      expect(() => serialize(chain(127)), name).not.toThrow();
      expect(() => serialize(chain(128)), name).toThrow(RangeError);
    }
  });

  // What the ceiling counts is what costs a stack frame. Breadth costs none, so an ordinary large
  // payload must keep hashing; and a cycle is answered by its back-reference, which is why the
  // `seen` lookup has to come before the ceiling rather than after it.
  it("counts nesting, not breadth, and lets a cycle terminate before the ceiling", () => {
    expect(() =>
      serialize(Array.from({ length: 50_000 }, (_, index) => ({ index }))),
    ).not.toThrow();

    // The cycle sits at the deepest level the ceiling allows: its self-reference must return the
    // `#<n>` placeholder instead of asking to descend one more level.
    const ring: Record<string, unknown> = { a: 1 };
    ring.self = ring;
    let value: unknown = ring;
    for (let index = 0; index < 127; index++) {
      value = { a: value };
    }
    expect(() => serialize(value)).not.toThrow();
  });
});
