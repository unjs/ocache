# `storage.ts` — the built-in memory backend

`StorageInterface` provides minimal `get` and `set` operations. `set` accepts an optional TTL in seconds. A nullish value deletes the entry instead of storing unused data.

## Two ceilings, LRU-evicted in one loop

The backend defaults to `maxSize` of 10 000 entries and `maxBytes` of 100 MB (finding 14.1). Both limits apply because they control different resources. `maxSize` limits entry count, not memory. Retained bytes equal `maxSize × whatever an entry weighs`, and HTTP clients can influence entry size. Measurements with 10 000 documents of 1 MB each produced 10 GB of RSS. The cache uses external and large-object memory, so the operating system **kills the process for OOM instead of throwing a catchable `RangeError`**. A write cannot degrade gracefully after that point.

This became a release blocker after finding 14.3 was rejected. `{ swr: true, maxAge: N }` has an expiry but no storage TTL. See `.agents/cache.md`. Backend capacity is the **only** bound for these entries, so the built-in backend must enforce one. `Infinity`, `0`, and negative values disable either limit. A `get` updates recency when either limit is active.

## The running total is a correctness obligation

Use a running byte total. Recomputing the total would take O(cache) work for every write. Every removal path must update the total. `set`, including overwrite, nullish-value deletion, the TTL `setTimeout` callback, and lazy expiration in `get` must call `deleteEntry`. This is the only function that releases bytes. The one `map.set` in `set` is the only operation that charges bytes.

A leaked charge does not remove the budget. It makes the backend silently approach **evicting everything**. Tests must cover accounting for each removal path. The LRU update in `get` intentionally uses raw `map.delete` and `map.set`. It moves the same entry and its existing charge. It is not a charged deletion followed by insertion.

## An entry larger than the whole budget is refused

Reject an entry larger than the complete budget. Also remove any previous value for its key. Storing the entry while permanently over budget is not valid. Evicting all other entries cannot make an oversized entry fit. It would instead create the single-request cache-flush denial of service from finding 14.2. Removing the previous value follows the requested `set`. Serving that old value afterward would falsely report what is cached. The next read misses and resolves again. The eviction loop checks for an empty map, so it always terminates.

## Measuring an entry

- `sizeOf(value, key)` replaces the built-in estimate. It owns the **entire** per-entry charge, including the key. Do not add another charge. Call it only when `maxBytes` is active. If it throws or returns a value that is not a finite, non-negative number, use the built-in estimate. The budget may become approximate but must never treat the value as free. When the built-in estimate itself throws, there is no lower fallback that is not free, so `set` **refuses the entry**, exactly as it refuses an oversized one, and drops any previous value for the key. Charging only the key and entry overhead was the earlier behavior; one throwing getter or proxy trap then bought unlimited retained bytes for about 100 of them. `sizeOf` remains the escape hatch for a value whose properties throw.
- The built-in estimate uses a **depth-limited, cycle-safe structural traversal**. Do not use `JSON.stringify(value).length`. That operation throws for cycles and BigInt, omits non-JSON values, and allocates a second copy of a potentially large body. The traversal allocates only its `seen` set and reads each string's `length` once. The common `CacheEntry<ResponseCacheEntry>` shape has depth 3 and costs only a few property reads. `seen` charges an object once, so cycles stop and shared subtrees are not counted twice. The depth limit of 8 prevents stack overflow. It can undercount deeper values; use `sizeOf` when that matters. Charge `ArrayBuffer` and `SharedArrayBuffer` by `byteLength`, and charge a **view by the `byteLength` of its backing buffer**. Walking indices would require O(n) reads and give the wrong size. A view's own `byteLength` is the wrong number in the unsafe direction: `new Uint8Array(buffer, 0, 1)` keeps all of `buffer` alive while costing one byte, so a 64 MB retention fit in a 1-byte charge. The buffer goes into `seen`, so several views over one buffer are charged once. This overcharges a pooled `Buffer` (Node shares an 8 KB pool below 4 KB); overcounting is the safe direction, and `src/http/entry.ts` builds bodies as exact-size arrays, from `res.arrayBuffer()` or from concatenated stream chunks. Iterate `Map` and `Set`; `Object.keys` would assign them a dangerous zero cost. Host objects with no own enumerable properties, such as `Response`, are also undercounted. For this reason, the HTTP layer stores a serialized entry, not a live response.
- Charge strings at **2 bytes per UTF-16 code unit**, which is the upper bound. Engines may store latin1-only strings with one byte per character, so this can charge an ASCII body up to 2× its actual string storage. Overcounting is safe. Undercounting would make the budget ineffective. Measure keys the same way and include them in the entry. The finding's second measurement used `10 000 × 8 KB` attacker-selected paths with trivial values. It reached 93 MB heap and 296 MB RSS in 6 s. Almost all of that size was in keys.

## Storing bytes is declared, not detected

`binary` states that a value returns with its byte views intact, including views nested inside an entry — what actually reaches `set` is a `CacheEntry<ResponseCacheEntry>`, not a bare body. `createMemoryStorage` declares it because a `Map` holds the value by reference. `http/entry.ts` then stores a binary response body as a `Uint8Array` rather than base64 text, and derives a body ceiling of `maxEntryBytes / 2` instead of `maxEntryBytes / (8/3)`. See `.agents/http/response.md`.

A backend that serializes entries must leave it unset, and this cannot be inferred: JSON turns a view into `{"0":255,...}`, which is a plain object by the time anything could inspect it. Probing the backend with a test write was rejected — it writes to the consumer's store as a side effect and fails silently on exactly the backends it would need to catch. `validateEntry` is the safety net: a body that is neither a string nor a byte view is rejected on read, so a wrong declaration costs hits, never correctness.

Holding values by reference is also why nothing may mutate a stored body. A declaring backend hands the same view to every hit, where base64 decoding allocated a fresh array each time.

A serializing backend can still declare it by carrying the bytes itself. `docs/3.storage.md` shows the unstorage form: take the body out of the JSON, append it as bytes, and write the pair through `setItemRaw`. Verified against the `fs` driver — its raw path is native (`writeFile`/`readFile`), but it moves **one byte payload**, so handing an entry object straight to `setItemRaw` throws `ERR_INVALID_ARG_TYPE`. That is the distinction to keep: the flag asks whether _this backend, as adapted_, returns views intact, not whether the underlying store can hold bytes at all.

## The ceiling is declared, not private

`maxEntryBytes` publishes the active `maxBytes` on the instance. It is `undefined` when the budget is disabled, and a custom backend that enforces nothing declares nothing. This exists because refusing an entry is the **last** possible moment to protect memory: the HTTP layer has to build the value before `set` can measure it, so it derives its own body limit from this number and refuses an oversized body while it is still reading the stream. See `.agents/http/response.md`. Keep the two in one declaration; a second constant would drift from a configured budget.

## `resolveStorage` and the absence of a global

`StorageOption` is `StorageInterface | (() => StorageInterface)`. The factory supports late binding when a handler is defined during module load but its backend is configured during server startup. `resolveStorage(...optsList)` reads `optsList[0].storage`. It calls a factory, or creates a fresh `createMemoryStorage()` when unset. It writes the resolved instance to every options object in the list.

**Do not use global storage.** `useStorage()` and `setStorage()` are removed, not deprecated. The module-level slot made the last `setStorage()` call affect every consumer in the process. Two independent applications could each create a handler and storage but still share one backend. They then served each other's cached response bodies, as in h3#1524 finding #2. Per-instance defaults prevent key collisions between default stores. To share storage, pass the same `storage` explicitly.
