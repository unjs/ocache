# `src/hash.ts` — cache keys and integrity

`hash(input)` = base64url(sha256(`serialize(input)`)). Every storage key and `integrity` field uses this function. Uses include the `anon_<hash>` value in `resolveName`, `escapeKeySegment`, the default `getKey(...args)`, `integrity`, the `_hashedPath`, header, and cookie components in `http/key.ts`, and the body etag in `http/entry.ts`.

This code replaced the `ohash` dependency, so ocache now has no runtime dependencies. The output has the same general shape as ohash: sha256, base64url, function source text, and sorted object entries. It is **not** byte-compatible. An upgrade changes every key and integrity value once. ocache does not find entries from an older version. This causes one cold read, not a found entry that fails integrity validation. Adding the length prefix described below rotated the keys a second time, with the same one-time effect.

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
- **Type-tagged branches.** Examples include `'3:str`, `1n`, `Set[…]`, `Map{…}`, `Ctor{…}`, and `Uint8Array[…]`. Values of different types must not have the same rendering. Every length-prefixed form carries a tag ahead of the prefix (`Function'…`, `Symbol'…`, `URL'…`, `RegExp'…`, `Error'…`), so a value never reads as a plain string of the same text.
- **Length-prefixed text.** Anything that embeds caller-supplied text goes through `serString`, which renders `'<code units>:<text>`: a string, an object key, a `Map` key, a symbol description, function source, and the `RegExp`/`URL`/`Error` text. **This is a security property, not formatting.** Without the prefix, text that spells out the `,`, `:`, `}`, or `]` between members moves a boundary — `["alice','scope", "doc"]` and `["alice", "scope','doc"]` rendered identically, and cache keys are built from exactly this kind of chosen input (URLs, header values, cookie names and values, call arguments). One caller could then land on another caller's entry, which is cache poisoning and cross-input disclosure. With the prefix, a reader consumes the declared number of code units, so no chosen text can imitate a separator. Never embed text without it. The cost is one `.length` read, which does not change the measurements below.
- **Order-independent members.** Sort object, `Map`, and `Set` entries. `{a, b}` and `{b, a}` must share an entry. Object keys are unique and already provide a total order. `Map` entries are sorted as complete rendered `key:value` pairs. Rendered `Map` and `Set` members provide a total order, including for object keys. Use bare `sort()`. Its default string comparator uses code-unit order by definition. Never use `localeCompare`.
- **Cycles terminate** as `#<n>` in visit order. Replace the `seen` entry with the completed rendering. A repeated reference that is not cyclic must still render in full.
- **Functions render as source text** with line breaks collapsed. Equal source produces equal hashes across restarts. This makes `anon_<hash>` names and `integrity` usable with persistent backends. Reindentation alone does not make entries cold. The cost is that equal source with different closed-over values is indistinguishable. This limitation appears in the `resolveName` documentation, `.agents/cache.md`, and the guides. Pass an explicit `name` in this case.
- **Typed arrays render element values, not bytes.** Raw bytes would make an `Int32Array` key depend on machine endianness. `DataView` has no `join`, so it is the only view rendered as bytes.
- **Use `toJSON` when a class provides it.** Own enumerable properties omit private fields and getters. Without `toJSON`, distinct instances could both render as `Ctor{}`.

Any change to these rules changes every persisted key. Treat this rendering as a storage format.

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
- **Identify plain objects by constructor identity** before the `instanceof` checks. Plain objects cannot match those checks and are the common shape for call arguments and option objects.

The portable implementation directly determines cache-key cost in its runtimes. It allocates scratch buffers once. It reads the message in place and copies only the final one or two padded blocks. It widens short ASCII manually instead of using `TextEncoder`. It emits base64url directly from the alphabet. Compared with its earlier shape, this is 3x faster for a key-sized input and about 1.2x faster for a body-sized input.

Do not replace this with **a faster non-cryptographic hash**. Cache keys and etags include attacker-controlled URL, header, cookie, and body values. A hash with constructible collisions allows cache poisoning. Two crafted URLs with one key can cause one visitor to receive another request's response. Do not trade this security property for digest speed.
