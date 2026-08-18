// The `default` arm of the `#crypto` subpath import (see package.json `imports`): a portable
// sha256 for every runtime that resolves without the `node` condition — browsers, workers,
// edge bundles. Its counterpart is `./digest.node.mjs`.
//
// Both arms return the same 43 base64url characters for the same input, so a cache key never
// depends on which one a consumer resolved: a persistent backend written by a Node process and
// read by a worker has to agree. `test/hash.test.ts` holds this file against `node:crypto`
// across every message-padding boundary.
//
// Why a JS implementation and not WebCrypto: `crypto.subtle.digest` is async, and `hash()` is
// called synchronously at definition time (`resolveName`, `integrity`) and from plain string
// composition (`escapeKeySegment`). See `.agents/hash.md`.
//
// Plain `.mjs`, shipped as-is rather than built from `src/`: the condition has to be resolved by
// the *consumer's* bundler or runtime, so both arms must exist as real files in the package.
//
// Unlike the node arm this one *is* the cost of a cache key on its runtime — a per-request etag
// over a response body runs through it — so the scratch buffers below are allocated once and the
// message is read in place. Nothing here calls out, so no second `digest` can be in flight
// against them: JS is single-threaded per realm, and a worker gets its own module copy.

/**
 * Both forms hash the same bytes: a string is UTF-8 encoded, a `Uint8Array` is hashed as given.
 * Bytes skip `encode` rather than adding a branch to it — a response body arrives here already
 * encoded, and copying it into a second array is the one cost this path exists to avoid.
 *
 * @param {string | Uint8Array} data
 * @returns {string} sha256 of `data`, base64url, unpadded.
 */
export function digest(data) {
  return sha256(typeof data === "string" ? encode(data) : data);
}

// Round constants: the first 32 bits of the fractional parts of the cube roots of the first 64
// primes (FIPS 180-4 §4.2.2). Verbatim from the spec.
const K = new Uint32Array([
  0x42_8a_2f_98, 0x71_37_44_91, 0xb5_c0_fb_cf, 0xe9_b5_db_a5, 0x39_56_c2_5b, 0x59_f1_11_f1,
  0x92_3f_82_a4, 0xab_1c_5e_d5, 0xd8_07_aa_98, 0x12_83_5b_01, 0x24_31_85_be, 0x55_0c_7d_c3,
  0x72_be_5d_74, 0x80_de_b1_fe, 0x9b_dc_06_a7, 0xc1_9b_f1_74, 0xe4_9b_69_c1, 0xef_be_47_86,
  0x0f_c1_9d_c6, 0x24_0c_a1_cc, 0x2d_e9_2c_6f, 0x4a_74_84_aa, 0x5c_b0_a9_dc, 0x76_f9_88_da,
  0x98_3e_51_52, 0xa8_31_c6_6d, 0xb0_03_27_c8, 0xbf_59_7f_c7, 0xc6_e0_0b_f3, 0xd5_a7_91_47,
  0x06_ca_63_51, 0x14_29_29_67, 0x27_b7_0a_85, 0x2e_1b_21_38, 0x4d_2c_6d_fc, 0x53_38_0d_13,
  0x65_0a_73_54, 0x76_6a_0a_bb, 0x81_c2_c9_2e, 0x92_72_2c_85, 0xa2_bf_e8_a1, 0xa8_1a_66_4b,
  0xc2_4b_8b_70, 0xc7_6c_51_a3, 0xd1_92_e8_19, 0xd6_99_06_24, 0xf4_0e_35_85, 0x10_6a_a0_70,
  0x19_a4_c1_16, 0x1e_37_6c_08, 0x27_48_77_4c, 0x34_b0_bc_b5, 0x39_1c_0c_b3, 0x4e_d8_aa_4a,
  0x5b_9c_ca_4f, 0x68_2e_6f_f3, 0x74_8f_82_ee, 0x78_a5_63_6f, 0x84_c8_78_14, 0x8c_c7_02_08,
  0x90_be_ff_fa, 0xa4_50_6c_eb, 0xbe_f9_a3_f7, 0xc6_71_78_f2,
]);

const encoder = /* @__PURE__ */ new TextEncoder();

// The hash state (§6.2.2's `H`), the message schedule, and the one or two padded final blocks.
const h = new Uint32Array(8);
const w = new Uint32Array(64);
const tail = new Uint8Array(128);
const tailView = /* @__PURE__ */ new DataView(tail.buffer);

// UTF-8 bytes of `text`. A short all-ASCII string — which every key component is — is cheaper to
// widen by hand than to hand to `TextEncoder`, whose fixed cost dominates at that size (3x on a
// key-sized input); past it the native encoder wins, and a non-ASCII code unit hands off to it.
/**
 * @param {string} text
 * @returns {Uint8Array}
 */
function encode(text) {
  const length = text.length;
  if (length > 256) {
    return encoder.encode(text);
  }
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    const code = text.charCodeAt(index);
    if (code > 0x7f) {
      return encoder.encode(text);
    }
    bytes[index] = code;
  }
  return bytes;
}

// SHA-256 (FIPS 180-4), as base64url. A straight transcription of §6.2 — the one thing here with
// no room for a judgement call, since its output is a storage format shared with `node:crypto`.
// The message is read in place; only the final one or two blocks are copied into `tail` to carry
// the padding, so a large body is neither duplicated nor mutated (it also hashes response bodies).
/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function sha256(bytes) {
  h[0] = 0x6a_09_e6_67;
  h[1] = 0xbb_67_ae_85;
  h[2] = 0x3c_6e_f3_72;
  h[3] = 0xa5_4f_f5_3a;
  h[4] = 0x51_0e_52_7f;
  h[5] = 0x9b_05_68_8c;
  h[6] = 0x1f_83_d9_ab;
  h[7] = 0x5b_e0_cd_19;

  const length = bytes.length;
  const whole = length & ~63;
  if (whole > 0) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, whole);
    for (let offset = 0; offset < whole; offset += 64) {
      compress(view, offset);
    }
  }

  // `1` bit, then zeros, then the 64-bit big-endian *bit* length in the final 8 bytes — which
  // needs a second block whenever the remainder no longer leaves room for both.
  const rest = length - whole;
  const padded = rest + 9 > 64 ? 128 : 64;
  tail.fill(0, 0, padded);
  tail.set(bytes.subarray(whole), 0);
  tail[rest] = 0x80;
  const bits = length * 8;
  tailView.setUint32(padded - 8, Math.floor(bits / 0x1_00_00_00_00));
  tailView.setUint32(padded - 4, bits >>> 0);
  for (let offset = 0; offset < padded; offset += 64) {
    compress(tailView, offset);
  }

  return base64url();
}

// One block of §6.2.2, folded into `h`. Intermediate sums exceed 32 bits but stay well under
// `2 ** 53`, so the `| 0` (and the implicit `Uint32Array` coercion) recovers the low 32 bits
// exactly. The rotations are written out rather than called: that is 384 calls per block.
/**
 * @param {DataView} view
 * @param {number} offset
 */
function compress(view, offset) {
  for (let t = 0; t < 16; t++) {
    w[t] = view.getUint32(offset + t * 4);
  }
  for (let t = 16; t < 64; t++) {
    const x = w[t - 15];
    const y = w[t - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
  }

  // The eight working variables of §6.2.2 (`h` is taken by the state array, hence `i`).
  let a = h[0];
  let b = h[1];
  let c = h[2];
  let d = h[3];
  let e = h[4];
  let f = h[5];
  let g = h[6];
  let i = h[7];
  for (let t = 0; t < 64; t++) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const temp1 = (i + s1 + ch + K[t] + w[t]) | 0;
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    i = g;
    g = f;
    f = e;
    e = (d + temp1) | 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + s0 + maj) | 0;
  }
  h[0] += a;
  h[1] += b;
  h[2] += c;
  h[3] += d;
  h[4] += e;
  h[5] += f;
  h[6] += g;
  h[7] += i;
}

// Padding is stripped, matching Node's `base64url`.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const output = new Uint8Array(32);
const outputView = /* @__PURE__ */ new DataView(output.buffer);

// Ten whole 3-byte groups and a 2-byte remainder, straight from the alphabet rather than through
// `btoa` — which costs a binary string to build first and a second pass to translate `+/` and
// strip the `=` padding.
/**
 * @returns {string}
 */
function base64url() {
  for (let t = 0; t < 8; t++) {
    outputView.setUint32(t * 4, h[t]);
  }
  let out = "";
  for (let index = 0; index < 30; index += 3) {
    const group = (output[index] << 16) | (output[index + 1] << 8) | output[index + 2];
    out +=
      ALPHABET[group >>> 18] +
      ALPHABET[(group >>> 12) & 63] +
      ALPHABET[(group >>> 6) & 63] +
      ALPHABET[group & 63];
  }
  // The last two bytes are 16 bits, so the third character carries four of them and no fourth
  // character (the `=` of a padded encoding) follows.
  const rest = (output[30] << 8) | output[31];
  return out + ALPHABET[rest >>> 10] + ALPHABET[(rest >>> 4) & 63] + ALPHABET[(rest << 2) & 63];
}
