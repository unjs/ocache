// `ohash`'s `hash()`, re-composed from its two halves so the SHA-256 half can be swapped.
//
// `ohash.hash(x)` is exactly `digest(serialize(x))`, and it is the digest that costs bundle
// size: on a `platform: neutral` build ohash accounts for ~36% of shipped gzip and roughly
// two thirds of *that* is its JS SHA-256, not its serializer. `ohash/crypto` already carries a
// `node` export condition resolving to native `node:crypto`, so Node consumers never ship the
// JS implementation — only edge/worker/browser builds pay for it. `#crypto` (see the `imports`
// map in `package.json`) mirrors that condition one level up: `node` → `ohash/crypto`,
// `default` → `src/crypto.ts`. Node keeps the native digest it already had, everything else
// gets a compact one, and neither is worse off than before.
//
// The serializer is deliberately *not* touched. A hand-rolled one measures smaller still, but
// dropping its `$Set`/`$Map`/`$RegExp` cases makes every `Set` serialize to `Set{}` — so
// `cachedFunction` called with two different `Set`s returns the wrong cached value — and it
// would invalidate every stored `integrity` on upgrade.

import { serialize } from "ohash";

import { digest } from "#crypto";

/**
 * Hashes any value to a base64url string, byte-for-byte identical to `ohash`'s `hash()`.
 *
 * Cache keys and `integrity` values are built from this, so its output is a compatibility
 * surface: a change here silently invalidates (or worse, collides) every entry in every
 * store. `test/hash.test.ts` pins it against `node:crypto` and against literal expected values.
 */
export function hash(input: unknown): string {
  return digest(serialize(input));
}
