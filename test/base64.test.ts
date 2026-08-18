import { Buffer } from "node:buffer";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  base64ToBytes,
  bufferFromBase64,
  bufferToBase64,
  bytesToBase64,
  nativeFromBase64,
  nativeToBase64,
  portableFromBase64,
  portableToBase64,
} from "../src/base64.ts";

// `src/base64.ts` picks one implementation per runtime, so on Node only the `Buffer` pair is
// ever reached through `bytesToBase64`. The others would ship untested — and the portable
// encoder is the one with a real failure mode, since chunking anywhere but a multiple of three
// pads mid-string and corrupts every body past the chunk size. A stored entry is also readable
// by another runtime, so what matters is not that each pair round trips but that all of them
// agree byte for byte.

const hasNativeCodec =
  typeof Uint8Array.prototype.toBase64 === "function" &&
  typeof Uint8Array.fromBase64 === "function";

/** Bytes that are not valid UTF-8, which is what sends a body down the base64 path. */
function binary(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    // Above 0x7f and never followed by a continuation byte: the payload is invalid UTF-8 as a
    // whole, not merely at its first byte.
    bytes[i] = 0x80 + ((i * 37) % 128);
  }
  return bytes;
}

const encoders: Array<[string, (bytes: Uint8Array) => string]> = [
  ["buffer", bufferToBase64],
  ["native", nativeToBase64],
  ["portable", portableToBase64],
];

const decoders: Array<[string, (base64: string) => Uint8Array]> = [
  ["buffer", bufferFromBase64],
  ["native", nativeFromBase64],
  ["portable", portableFromBase64],
];

// The `native` arm calls methods this Node does not have yet, so it is exercised against
// stand-ins. That covers what the arm actually contains — which method it calls, on what
// receiver — and the rest is the TC39 specification, which pins the alphabet and the padding.
const proto = Uint8Array.prototype as { toBase64?: () => string };
const ctor = Uint8Array as { fromBase64?: (text: string) => Uint8Array };

beforeAll(() => {
  if (hasNativeCodec) {
    return;
  }
  proto.toBase64 = function (this: Uint8Array) {
    return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString("base64");
  };
  ctor.fromBase64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));
});

afterAll(() => {
  if (hasNativeCodec) {
    return;
  }
  delete proto.toBase64;
  delete ctor.fromBase64;
});

describe("base64", () => {
  // Around the 32 766-byte chunk boundary and across every length remainder, because a
  // mid-string pad can only appear where one chunk ends and the next begins.
  const sizes = [0, 1, 2, 3, 4, 255, 32_765, 32_766, 32_767, 65_531, 65_532, 65_533];

  it.each(sizes)("encodes %i bytes identically in every implementation", (size) => {
    const bytes = binary(size);
    // Node's own encoder is the reference: it is not one of the implementations under test.
    const expected = Buffer.from(bytes).toString("base64");

    for (const [name, encode] of encoders) {
      expect(encode(bytes), name).toBe(expected);
    }
  });

  it.each(sizes)("decodes %i bytes identically in every implementation", (size) => {
    const bytes = binary(size);
    const base64 = Buffer.from(bytes).toString("base64");

    for (const [name, decode] of decoders) {
      expect([...decode(base64)], name).toEqual([...bytes]);
    }
  });

  it("round trips every byte value, and the pair this runtime resolved is one of them", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      bytes[i] = i;
    }

    for (const [name, encode] of encoders) {
      const base64 = encode(bytes);
      for (const [decoderName, decode] of decoders) {
        expect([...decode(base64)], `${name} -> ${decoderName}`).toEqual([...bytes]);
      }
    }
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });

  it("encodes a view without its neighbours", () => {
    // The `Buffer` encoder wraps the backing memory rather than copying it, so a view that
    // covers part of a larger buffer must not pull in the rest of it.
    const backing = binary(300);
    const view = backing.subarray(64, 200);

    for (const [name, encode] of encoders) {
      expect(encode(view), name).toBe(Buffer.from(backing.slice(64, 200)).toString("base64"));
    }
  });
});
