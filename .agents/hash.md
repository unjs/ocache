# `src/hash.ts` — cache keys and integrity

`hash(input)` = base64url(sha256(`serialize(input)`)). Every storage key and `integrity` field uses this function. Uses include the `anon_<hash>` value in `resolveName`, `escapeKeySegment`, the default `getKey(...args)`, `integrity`, the `_hashedPath`, header, and cookie components in `http/key.ts`, and the body etag in `http/entry.ts`.

This code replaced the `ohash` dependency, so ocache now has no runtime dependencies. The output has the same general shape as ohash: sha256, base64url, function source text, and sorted object entries. It is **not** byte-compatible. An upgrade changes every key and integrity value once. ocache does not find entries from an older version. This causes one cold read, not a found entry that fails integrity validation. Adding the length prefix described below rotated the keys a second time, with the same one-time effect. Length-prefixing the constructor-name tags rotated the keys for class instances, typed arrays, buffers, `URL`, `RegExp`, and `Error` a third time. Plain objects, arrays, strings, `Set`, `Map`, and `Date` were deliberately left byte-identical, so the common shapes did not rotate again.

## The digest backend: `#crypto`

`src/hash.ts` imports `digest` from `#crypto` and has no other crypto knowledge. Do not add a capability check, `try`/`catch`, or a `node:` specifier there. No other code may access a crypto API. The conditional `imports` entry in package.json selects the implementation:

| Condition | File                  | What it is                                                      |
| --------- | --------------------- | --------------------------------------------------------------- |
| `node`    | `lib/digest.node.mjs` | `node:crypto`, one-shot `crypto.hash()` (`createHash` fallback) |
| `default` | `lib/digest.mjs`      | Portable sha256 (FIPS 180-4), base64url from the alphabet       |

The portable arm emits base64url characters directly from the alphabet. This replaced the earlier `btoa` implementation.

**Use a condition, not a runtime `if`.** The consumer's bundler resolves the condition. Each build then includes only the required implementation. A server bundle excludes the portable sha256 code, saving 1.7 kB minified and 1.1 kB gzip. A worker bundle does not see an unsupported `node:` specifier. A runtime check cannot provide either property because both implementations must remain in the bundle. `test/bundle.ts` builds both platforms and gives each a separate size budget. The difference between its two rows is `lib/digest.mjs`.

Keep these consequences in mind:

- **Both implementations must return identical digests.** Otherwise, Node and worker processes that share a persistent backend use different key spaces. `test/hash.test.ts` imports both files directly and compares them with `node:crypto` at every message-padding boundary. The test detects sabotage: changing one round constant makes it fail. For this reason, `lib/digest.mjs` directly implements §6.2 without custom changes. The file does not appear in the `--coverage` table because v8 coverage reports only files transformed by vitest. These files ship without transformation. Read the test before you conclude that an implementation has no test coverage.
- **The implementations ship as `.mjs`; the build does not produce them from `src/`.** Consumers resolve the condition, so the published package must include both files. Keep `"lib"` in `files`. Keep `#crypto` external in `dist/index.mjs`. obuild does this without configuration. If the build changes, check its `Dependencies:` line.
- `crypto.hash()` requires Node >= 20.12/21.7, and Node compatibility layers may lag. The Node implementation imports the namespace and then checks for the method. Do not use a named import for a possibly missing export. A missing named export causes a link-time `SyntaxError` before fallback code can run.

### Why not WebCrypto

`crypto.subtle.digest` is **asynchronous**, but `hash` must remain synchronous. `resolveName` and `integrity` run at definition time inside synchronous `defineCachedFunction` and `defineCachedHandler` calls. `escapeKeySegment` runs during ordinary string composition in `buildCacheKey`. WebCrypto would require `hash` to return a promise. It would defer `name` and `integrity` until the first asynchronous use and add `await` to every key path. This would add permanent asynchronous work to a hot path to save about 1.7 kB minified only in the non-Node implementation. `ohash` uses a JavaScript implementation for the same reason.

## What `serialize` guarantees

- **Deterministic output across processes and machines.** Do not use counters, `WeakMap` identity, randomness, or `localeCompare`. Sort order changes the hash, and locale can differ by process. Every machine that shares a backend must derive the same key.
- **Type-tagged branches.** Examples include `'3:str`, `1n`, `Set[…]`, `Map{…}`, `Headers{…}`, `'3:Foo{…}`, and `'10:Uint8Array[…]`. Values of different types must not have the same rendering. Every length-prefixed form carries a tag ahead of the prefix (`Function'…`, `Symbol'…`, `'3:URL'…`, `'6:RegExp'…`, `'5:Error'…`), so a value never reads as a plain string of the same text.
- **Length-prefixed text.** Anything that embeds caller-supplied text goes through `serString`, which renders `'<code units>:<text>`: a string, an object key, a `Map` key, a symbol description, function source, the `RegExp`/`URL`/`URLSearchParams`/`Error` text, `Headers` names and values, and **every constructor-name tag** (`serTag`). **This is a security property, not formatting.** Without the prefix, text that spells out the `,`, `:`, `}`, or `]` between members moves a boundary — `["alice','scope", "doc"]` and `["alice", "scope','doc"]` rendered identically, and cache keys are built from exactly this kind of chosen input (URLs, header values, cookie names and values, call arguments). One caller could then land on another caller's entry, which is cache poisoning and cross-input disclosure. With the prefix, a reader consumes the declared number of code units, so no chosen text can imitate a separator. Never embed text without it. The cost is one `.length` read, which does not change the measurements below.
- **A constructor name is caller-controlled text.** A class name can hold any character — `{ ["A{},B"]: class {} }["A{},B"].name` is `A{},B` — so a raw tag can imitate a member boundary exactly as a string value can. `serialize(new Set([new A()]))` for that class rendered `Set[A{},B{}]`, which is also what a `Set` of one `A` and one `B` rendered. `serTag` routes every tag through `serString`. The one exception is a **plain object**, which keeps its bare `{…}`: it is the common shape and must not churn. An anonymous class therefore renders `'0:{…}`, which is what keeps it apart from `{}` (`hash(new (class {})()) === hash({})` before).
- **Order-independent members.** Sort object, `Map`, and `Set` entries. `{a, b}` and `{b, a}` must share an entry. Object keys are unique and already provide a total order. `Map` entries are sorted as complete rendered `key:value` pairs. Rendered `Map` and `Set` members provide a total order, including for object keys. Use bare `sort()`. Its default string comparator uses code-unit order by definition. Never use `localeCompare`.
- **Cycles terminate** as `#<n>` in visit order. Replace the `seen` entry with the completed rendering. A repeated reference that is not cyclic must still render in full.
- **Nesting terminates at `MAX_DEPTH` (128) with a `RangeError`.** The traversal is recursive, so depth is stack frames. The ceiling is a refusal, never a truncation: a rendering that dropped or elided a subtree would give two different values one key. See "The depth ceiling" below.
- **Functions render as source text** with each line break and the whitespace around it collapsed to **one space**. Equal source produces equal hashes across restarts. This makes `anon_<hash>` names and `integrity` usable with persistent backends. Reindentation alone does not make entries cold, because reindentation only changes whitespace that touches a line break. Collapsing to nothing instead of a space was a bug: it joined the tokens either side, so `() => { foo\nbar }` rendered as `() => { foobar }` and two unrelated functions shared one `anon_<hash>` name and one `integrity`. Three costs remain, and all three are the same fix — pass an explicit `name`, `getKey`, or `integrity`:
  - Equal source with different closed-over values is indistinguishable. This limitation appears in the `resolveName` documentation, `.agents/cache.md`, and the guides.
  - Inside a string or template literal, a line break and a space are the same rendering, so `` () => `a\nb` `` and `` () => `a b` `` share a hash. Telling them apart needs a tokenizer, and reindentation stability is worth more than the distinction.
  - A **bound or native** function has no source: `Function.prototype.toString` gives `function () { [native code] }`, so `fn.bind(null, 1)` and `fn.bind(null, 2)` render identically — the bound arguments are invisible. `resolveName` is unaffected (`fn.bind(…).name` is `bound fn`, so it never reaches the hash), but `integrity` and an argument-position function are.
- **Typed arrays render element values, not bytes.** Raw bytes would make an `Int32Array` key depend on machine endianness. `DataView` has no `join`, so it is the only view rendered as bytes.
- **Use `toJSON` when a class provides it.** Own enumerable properties omit private fields and getters. Without `toJSON`, distinct instances could both render as `Ctor{}`.

Any change to these rules changes every persisted key. Treat this rendering as a storage format.

## Opaque built-ins

An object with no own enumerable property and no `toJSON` falls through to `serProperties`, so it used to render as nothing but its tag. Every value of that type then shared one storage key. In an HTTP cache library, the default `getKey` hashes call arguments, so this was reachable with ordinary arguments:

| Input                        | Before                | Now                              |
| ---------------------------- | --------------------- | -------------------------------- |
| `new URLSearchParams("a=1")` | `URLSearchParams{}`   | `'15:URLSearchParams'3:a=1`      |
| `new Headers({ a: "1" })`    | `Headers{}`           | `Headers{'1:a:'1:1}`             |
| `new SharedArrayBuffer(4)`   | `SharedArrayBuffer{}` | `'17:SharedArrayBuffer[0,0,0,0]` |

`serialize(new URLSearchParams("a=1"))` and `serialize(new URLSearchParams("z=9"))` were the same string, which means one caller's cached response served to another.

- **`URLSearchParams` renders in entry order and is never sorted.** The order-independence rule for objects, `Map`, and `Set` does not apply: duplicate keys are legal and their order is part of the value, so `a=1&a=2` must not share a key with `a=2&a=1`. It shares the `RegExp`/`URL`/`Error` branch because its `toString` is the spec's `application/x-www-form-urlencoded` serializer — order-preserving, percent-encoding `&` and `=` inside names and values, and therefore injective on the entry list.
- **`Headers` is not re-sorted.** Fetch's header-list iteration sorts by lowercased name and combines duplicates, so it is already deterministic across runtimes; sorting again would only hide a runtime that got that wrong. `set-cookie` is the exception the spec carves out: those entries are yielded separately, in insertion order. Two `Headers` that differ only in `set-cookie` insertion order therefore render differently. That direction is safe — an extra key, never two values merged onto one.
- **`Headers` keeps a fixed literal tag**, not `serTag`. Its body has the same `'<k>:'<v>` shape as `serProperties`, so a length-prefixed tag would let a user class named `Headers` with an `a: "1"` property render exactly like `new Headers({ a: "1" })`. A fixed literal cannot be produced by a user class, because every class instance now starts with `'`. `Set`, `Map`, and `Date` keep fixed literals for the same reason.
- **`SharedArrayBuffer` is not an `ArrayBuffer`,** so `instanceof ArrayBuffer` missed it, and its global is absent in runtimes that do not enable it. `src/hash.ts` reads `globalThis.SharedArrayBuffer` **once** at module scope, so the branch costs a comparison and never touches a missing global. This is the only global lookup in the file; the digest is still reached only through `#crypto`, with no capability check.
- **`serTag` requires the name to be a string.** `constructor` is an ordinary key in parsed input, so `JSON.parse('{"constructor":{"name":{"length":5}}}')` reaches `serString` with a non-string `name`. `${value.length}` would then read the attacker's own `length`, and `${value}` its `toString` — a forged prefix, which is the exact hole the prefix exists to close. `serTag` renders a non-string name as `""`.

### Collisions left open, deliberately

**Values whose contents are not synchronously readable keep the bare-tag rendering.** `Blob`/`File` (`'4:Blob{}`), `Promise`, `WeakMap`, `WeakSet`, `ReadableStream`, `Request`, `Response`, and `AbortSignal` all still collide with another value of their own type.

The alternative considered was throwing. It was rejected: `serialize` cannot tell an argument that _should_ be part of the key from one the caller wants ignored, and the common opaque arguments are the ignorable kind — an `AbortSignal`, a logger, a database client threaded through a cached function. Throwing would turn those into a runtime failure on a per-request hot path, in production, at call time rather than at definition time. Rendering `Blob` as `size`/`type` was also rejected: it narrows the collision without closing it while looking like a by-value rendering. The rule is instead uniform and stated: **readable synchronously → rendered by value; not readable → tag only.** A caller that keys on such a value must pass an explicit `getKey` (noted in `docs/2.functions.md`).

**A class that takes another built-in's name merges with it.** The tag is the only thing separating siblings inside a branch, so `class ArrayBuffer extends Uint8Array {}` renders as `'11:ArrayBuffer[1,2]`, which a real `ArrayBuffer` over the same bytes also renders. The same holds for `class URL extends Error {}` with a URL-shaped message. `Object.prototype.toString` was considered as an unforgeable tag and rejected: a subclass can shadow `Symbol.toStringTag`, so it is forgeable too, and it costs a call plus a slice on the typed-array path. This residue is outside the threat model that motivates the prefix — an attacker supplies **data** (URLs, headers, cookies, JSON arguments), not JavaScript class declarations.

**A shadowed own `constructor` still decides the tag.** `{ constructor: {} }` renders `'0:{…}`, the same shape as an anonymous class instance carrying that own key. Reading the tag off the value is what makes an own `constructor` key safe (see the `ctor == null` branch), and both readings are already the same rendering today.

## The depth ceiling

`ser`, `serObject`, and `serProperties` are mutually recursive, so one level of nesting is one to three stack frames. Without a ceiling, `serialize(JSON.parse("[".repeat(5000) + "]".repeat(5000)))` threw `RangeError: Maximum call stack size exceeded`. That is a 10 kB payload, `JSON.parse` accepts it without complaint (V8 parses iteratively and did not break at four million levels), and the default `getKey` hashes call arguments — so a small parsed body failed the call inside the cache layer before the wrapped function ever ran. The handler path is not exposed: `http/key.ts` only ever hashes strings.

**Where the stack actually gives out.** Measured on Node 24 (x64, default `--stack-size`), one cold probe per process, binary-searched on nesting depth:

| Shape                         | Cold limit | Warm limit (same process) |
| ----------------------------- | ---------- | ------------------------- |
| array (`ser` → `serObject`)   | 1787       | ~3900                     |
| object (adds `serProperties`) | 1389       | ~3450                     |
| `toJSON` chain                | 1332       | —                         |
| `Set` / `Map`                 | 1787       | ~6100                     |

The two columns are the reason a ceiling beats leaving it alone: the same input overflows at 1389 on a cold call and survives past 3400 once the traversal is optimized, because an interpreted frame is much larger than an optimized one. The limit also scales with the stack — the object shape gives out at 718 with `--stack-size=512`, 354 at 256, and 172 at 128 — and it shrinks with whatever stack the caller already used. So the failure boundary moved with the runtime, the JIT tier, and the call site: one argument could hash on one request and throw on the next.

**Why 128.** It has to fire before the stack does in the worst configuration, not the best one, so the cold column is the one that matters and the ceiling has to sit under 1332 with room for a smaller stack. 128 still fires first at `--stack-size=128`, an eighth of Node's default, which covers a constrained runtime and a deep caller stack at the same time. It is also two orders of magnitude above any plausible key shape: a cache key argument is an id and an options object, and JSON body parsers in the same position cap nesting far lower (`qs` defaults to 5).

**The error is a `RangeError`,** not a new class. It is the type the runtime already threw for this condition, so a consumer that catches `RangeError` keeps working; it needs no new export; and the module is already over its bundle budget. The message names the depth and the fix (`getKey`), because it surfaces on a per-request path where the stack trace points at `hash`, not at the caller's argument.

**`toJSON` counts as a level.** The hook returns a fresh value that `seen` cannot stop, so `{ toJSON: () => ({ toJSON: … }) }` recurses without ever revisiting an object. Passing the current depth into `ser(toJSON.call(value), …)` covers it; leaving `toJSON` uncounted would have left the whole overflow reachable through one branch.

**The `seen` lookup stays ahead of the check.** A back-reference terminates without a frame, so a cycle at the ceiling must return its `#<n>` placeholder rather than be refused.

### Rejected: an iterative rewrite

An explicit-stack traversal removes the limit instead of naming it, and it was rejected on measurement. A prototype covering only the two hot shapes (arrays and plain objects, everything else delegated back to the recursive renderer, so it is a **lower bound** on a complete one) cost 3.9x on `[authority, path]`, 2.7x on a 2-arg `args`, and 2.3x on a 100-deep object. The cost is structural: a post-order machine needs a per-node frame and a per-node parts array, which is exactly the allocation the "concatenate members" and "no closure per call" optimizations below exist to avoid. It would also have to reproduce the cycle semantics — `#<n>` in visit order, the `seen` entry replaced by the completed rendering, a repeated non-cyclic reference still rendered in full — byte for byte across every branch, on a format that has already rotated three times, and it would spend more of a bundle budget that is already exceeded.

### Rejected: leaving it documented

The exposure is real (parsed bodies reach the default `getKey`) and the failure is undiagnosable from the outside: `RangeError: Maximum call stack size exceeded` with a stack full of `ser`/`serObject` says nothing about arguments or `getKey`. The warm/cold split above makes it worse than a plain limit, because it is not reproducible from the input alone.

### What did not change

Everything that renders today renders identically: the ceiling only adds a `depth` argument and a comparison. This was checked two ways against the pre-change implementation, in one process, on the same objects — a 101-value corpus covering every branch (including nesting at 1, 2, 8, 64, 100 and 126 levels) and a 20 000-case differential fuzz whose generator reuses objects to produce repeats and cycles. Zero differences in both. Chains of 127 levels render identically in every recursive branch (array, object, class, `Set`, `Map` key, `Map` value, `toJSON`); 128 is where each throws. The `depth` argument costs nothing measurable at the `hash` level: `[authority, path]` and a 2-arg `args` are within run-to-run noise, and strings still return before traversal. Bundle: +503 raw, +199 min, ~+125 gzip, the same on both platforms in `test/bundle.ts`, so it is shared logic rather than an arm of `#crypto`.

## Performance costs and optimizations

An automatic HTTP key always hashes the authority and path once. It adds one hash for each keyed header and one for an allowlisted cookie subset. Each miss also hashes the body etag. This is a per-request cost, not only a definition-time cost. Measurements on Node 24 and an i7-10700K show this cost per call:

| Input                     | node arm | portable arm | vs. before   |
| ------------------------- | -------- | ------------ | ------------ |
| a header value (60 chars) | 0.58 µs  | 2.1 µs       | 1.1x / 2.4x  |
| `[authority, path]`       | 0.84 µs  | 2.1 µs       | 1.2x / 2.5x  |
| a 2-arg call's `args`     | 1.5 µs   | 2.5 µs       | 1.8x / 2.4x  |
| a 10 kB body (etag)       | 19 µs    | 67 µs        | 1.07x / 1.4x |

The digest dominates small inputs. `crypto.hash` alone takes about 0.5 µs of the Node implementation's 0.58 µs. The serialization choices below provide a combined 1.5–2.5x improvement over a direct version of the same traversal. Do not replace them without accounting for that cost.

- **Do not create a closure per call.** `ser`, `serObject`, and `serProperties` are module-level functions. They pass `seen` explicitly instead of nesting inside `serialize`. The nested form allocated three function objects on every call, whether the value was hashed or not.
- **Return strings before traversal.** Most calls carry strings. A string cannot contain a cycle and does not need the `seen` map.
- **Concatenate members.** `map(...).join(",")` allocates a temporary array. For objects, `Object.entries` also allocates a pair for each key. The code builds the final string only once.
- **Identify plain objects by constructor identity** before the `instanceof` checks. Plain objects cannot match those checks and are the common shape for call arguments and option objects. Every branch added since — `URLSearchParams`, `Headers`, `SharedArrayBuffer` — sits **after** that check, on the class-instance path only. Re-measuring the four rows above after those branches and `serTag` landed showed no change outside run-to-run noise: the strings and arrays that dominate key paths return before any of it.

Bundle cost: the finding 2 and 3 branches add ~640 bytes raw, ~215 minified, and ~70 gzipped to both platforms in `test/bundle.ts`. That is the same code on both rows, so it is shared logic, not an arm of `#crypto`.

The portable implementation directly determines cache-key cost in its runtimes. It allocates scratch buffers once. It reads the message in place and copies only the final one or two padded blocks. It widens short ASCII manually instead of using `TextEncoder`. It emits base64url directly from the alphabet. Compared with its earlier shape, this is 3x faster for a key-sized input and about 1.2x faster for a body-sized input.

Do not replace this with **a faster non-cryptographic hash**. Cache keys and etags include attacker-controlled URL, header, cookie, and body values. A hash with constructible collisions allows cache poisoning. Two crafted URLs with one key can cause one visitor to receive another request's response. Do not trade this security property for digest speed.
