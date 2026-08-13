// Compact SHA-256 → base64url, the `default` half of the `#crypto` condition in
// `package.json`'s `imports` map (the `node` half resolves to `ohash/crypto`, which is
// native `node:crypto`). Only edge/worker/browser/bundler-neutral consumers ever load this
// file; Node consumers never see a byte of it. See `src/hash.ts` for why it exists at all.
//
// Byte-identical to `node:crypto`'s `createHash("sha256").digest("base64url")` — and so to
// what `ohash.hash()` produced before — for every input: cache keys, `integrity` values and
// weak etags are unchanged, and nothing in an existing store is invalidated. The one
// deliberate divergence from ohash's own JS fallback is an improvement: it encodes UTF-8 via
// `unescape(encodeURIComponent(s))`, which *throws* on a lone surrogate, while this uses
// `TextEncoder` and therefore substitutes U+FFFD exactly as `node:crypto` does. An input that
// used to hash on Node and throw on the edge now hashes the same on both.

// The 64 round constants (RFC 6234 §5.1: the fractional parts of the cube roots of the first
// 64 primes), carried as base64 rather than as a JS array literal — 344 source characters
// against ~700, and it minifies and gzips as one opaque blob. Deliberately *not* derived from
// the primes at load time, which is smaller still: `Math.cbrt` is spec'd as
// implementation-approximated, so a platform whose approximation differs by one ulp would
// silently produce a wrong table and therefore wrong hashes on every key in the store. A
// constant can't drift.
const K = /* @__PURE__ */ (() => {
  const bin = atob(
    "QoovmHE3RJG1wPvP6bXbpTlWwltZ8RHxkj+CpKscXtXYB6qYEoNbASQxhb5VDH3Dcr5ddIDesf6b3AanwZvxdOSbacHvvkeGD8GdxiQMocwt6SxvSnSEqlywqdx2+YjamD5RUqgxxm2wAyfIv1l/x8bgC/PVp5FHBspjURQpKWcntwqFLhshOE0sbfxTOA0TZQpzVHZqCruBwskuknIshaK/6KGoGmZLwkuLcMdsUaPRkugZ1pkGJPQONYUQaqBwGaTBFh43bAgnSHdMNLC8tTkcDLNO2KpKW5zKT2gub/N0j4LueKVjb4TIeBSMxwIIkL7/+qRQbOu++aP3xnF48g==",
  );
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    k[i] =
      (bin.charCodeAt(i * 4) << 24) |
      (bin.charCodeAt(i * 4 + 1) << 16) |
      (bin.charCodeAt(i * 4 + 2) << 8) |
      bin.charCodeAt(i * 4 + 3);
  }
  return k;
})();

// base64url (RFC 4648 §5): the standard alphabet with `+/` replaced by `-_`, and no padding —
// what `node:crypto`'s `"base64url"` encoding emits, which is what the output must match.
const base64url = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// The message schedule, hoisted out of `digest` because it is 256 bytes reallocated on every
// block otherwise. Safe as shared state: `digest` is straight-line synchronous code with no
// await and no callback, so no second call can interleave with one in progress.
const W = /* @__PURE__ */ new Uint32Array(64);

const encoder = /* @__PURE__ */ new TextEncoder();

/**
 * Hashes a string with SHA-256 and encodes the digest as base64url.
 *
 * Mirrors `ohash/crypto`'s `digest` — same signature, same output — so the two are
 * interchangeable behind the `#crypto` import condition.
 */
export function digest(message: string): string {
  const bytes = encoder.encode(message);
  const len = bytes.length;

  // Padded length: the message, a `0x80` byte, zeroes, and a 64-bit big-endian bit count,
  // rounded up to whole 64-byte blocks. `Uint8Array` is zero-filled, so only the two
  // non-zero parts are written — and of the 8 length bytes only the low 5 can be non-zero,
  // since `len` is a JS array length and `len * 8` therefore fits in 35 bits.
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  buf[total - 5] = len >>> 29;
  buf[total - 4] = len >>> 21;
  buf[total - 3] = len >>> 13;
  buf[total - 2] = len >>> 5;
  buf[total - 1] = len << 3;

  // Initial hash values (RFC 6234 §6.1: fractional parts of the square roots of the first 8
  // primes). Eight constants, so spelled out rather than base64'd.
  const H = new Uint32Array([
    0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab,
    0x5be0_cd19,
  ]);

  for (let p = 0; p < total; p += 64) {
    for (let i = 0, j = p; i < 16; i++, j += 4) {
      W[i] = (buf[j]! << 24) | (buf[j + 1]! << 16) | (buf[j + 2]! << 8) | buf[j + 3]!;
    }
    // Message schedule expansion. The additions can exceed 2^32; the `Uint32Array` store
    // truncates them modulo 2^32, which is the arithmetic the spec asks for.
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15]!;
      const y = W[i - 2]!;
      W[i] =
        W[i - 16]! +
        (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) +
        W[i - 7]! +
        (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10));
    }

    // Compression. Every intermediate sum is at most five values below 2^32 — under 2^35, so
    // exactly representable as a double — and `| 0` then truncates it to a signed 32-bit int.
    let a = H[0]!;
    let b = H[1]!;
    let c = H[2]!;
    let d = H[3]!;
    let e = H[4]!;
    let f = H[5]!;
    let g = H[6]!;
    let h = H[7]!;
    for (let i = 0; i < 64; i++) {
      const t1 =
        (h +
          (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) +
          ((e & f) ^ (~e & g)) +
          K[i]! +
          W[i]!) |
        0;
      const t2 =
        ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) +
          ((a & b) ^ (a & c) ^ (b & c))) |
        0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }

    H[0] = H[0]! + a;
    H[1] = H[1]! + b;
    H[2] = H[2]! + c;
    H[3] = H[3]! + d;
    H[4] = H[4]! + e;
    H[5] = H[5]! + f;
    H[6] = H[6]! + g;
    H[7] = H[7]! + h;
  }

  // 8 words → 32 big-endian bytes → 43 base64url characters. 32 isn't a multiple of 3, so the
  // last group reads one byte past the end and treats it as zero — the padding bits — which
  // makes its 4th character pure padding; `slice` drops it, leaving exactly the unpadded
  // encoding `node:crypto` produces.
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const w = H[i]!;
    out[i * 4] = w >>> 24;
    out[i * 4 + 1] = w >>> 16;
    out[i * 4 + 2] = w >>> 8;
    out[i * 4 + 3] = w;
  }
  let encoded = "";
  for (let i = 0; i < 32; i += 3) {
    const n = (out[i]! << 16) | (out[i + 1]! << 8) | (out[i + 2] ?? 0);
    encoded +=
      base64url[(n >>> 18) & 63]! +
      base64url[(n >>> 12) & 63]! +
      base64url[(n >>> 6) & 63]! +
      base64url[n & 63]!;
  }
  return encoded.slice(0, 43);
}
