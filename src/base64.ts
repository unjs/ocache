// Docs: @docs/5.handler.md

// Base64 is how `http/entry.ts` keeps a non-UTF-8 response body intact through a backend that
// serializes entries as JSON, so this conversion runs on **every store and every hit** of a
// binary entry. What it costs is decided by the runtime, and the spread of the three
// implementations below is 45x at 64 KiB, so the choice is made once here rather than probed
// per call. See `.agents/http/response.md`.
//
// All three produce the same bytes for the same input. They have to: an entry written by a Node
// process and read by a worker must round trip through a shared persistent backend unchanged.
// `test/base64.test.ts` holds them against each other over the chunk boundary and every
// remainder.

// Node and Bun expose `Buffer` as a global; Deno and most workers do not, and take the next arm.
// It is read off `globalThis` rather than named as a free identifier because several bundlers
// inject a Buffer polyfill into a browser build when they see the bare name, which costs a worker
// consumer far more than the fallback below.
const NodeBuffer = globalThis.Buffer as typeof globalThis.Buffer | undefined;

// The TC39 base64 methods (Chrome 133, Firefox 133, Safari 18.2, Deno 2.4, Node 25) — the fast
// path for a runtime with no `Buffer`. Both are required together: the pair has always shipped together,
// and a half-supported runtime is better served by one implementation than by two.
const hasNativeCodec =
  typeof Uint8Array.prototype.toBase64 === "function" &&
  typeof Uint8Array.fromBase64 === "function";

/** Encodes bytes as standard padded base64. */
export const bytesToBase64: (bytes: Uint8Array) => string = NodeBuffer
  ? bufferToBase64
  : hasNativeCodec
    ? nativeToBase64
    : portableToBase64;

/** Decodes standard padded base64 to the bytes it encodes. */
export const base64ToBytes: (base64: string) => Uint8Array = NodeBuffer
  ? bufferFromBase64
  : hasNativeCodec
    ? nativeFromBase64
    : portableFromBase64;

// The implementations are exported so `test/base64.test.ts` can hold them against each other on
// one runtime. Nothing else may call them: only the two bindings above know what this runtime
// supports.
//
// Each carries `#__NO_SIDE_EFFECTS__`: none of them touches anything outside its arguments, so a
// bundler may drop a call whose result goes unused. The module has no top-level call to annotate
// with `@__PURE__` — the two branches above read a global and two `typeof`s, and nothing else
// runs at load.

/** @internal 11.7 µs for 64 KiB, against 537 µs for the portable encoder. */
/*#__NO_SIDE_EFFECTS__*/
export function bufferToBase64(bytes: Uint8Array): string {
  // Wrap the backing memory; `Buffer.from(bytes)` would copy it first.
  return NodeBuffer!.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** @internal */
/*#__NO_SIDE_EFFECTS__*/
export function bufferFromBase64(base64: string): Uint8Array {
  const buffer = NodeBuffer!.from(base64, "base64");
  // Hand back a plain view, not the `Buffer`: a `createResponse` hook sees a decoded body, and
  // it must be the same shape on every runtime.
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** @internal */
/*#__NO_SIDE_EFFECTS__*/
export function nativeToBase64(bytes: Uint8Array): string {
  return bytes.toBase64();
}

/** @internal */
/*#__NO_SIDE_EFFECTS__*/
export function nativeFromBase64(base64: string): Uint8Array {
  return Uint8Array.fromBase64(base64);
}

// A multiple of 3, so every chunk ends on a base64 quantum: chunking at a non-multiple pads
// mid-string and produces a value nothing can decode.
const CHUNK = 32_766;

/** @internal Last resort: `btoa` over a binary string built one byte at a time. */
/*#__NO_SIDE_EFFECTS__*/
export function portableToBase64(bytes: Uint8Array): string {
  // One `String.fromCharCode` per byte rather than one spread per chunk. Spreading a chunk into
  // the argument list was the entire cost of the encoder this replaced — 2212 µs for 64 KiB
  // against 537 µs here — and none of it was `btoa`.
  let base64 = "";
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, bytes.length);
    let binary = "";
    for (let i = start; i < end; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    base64 += btoa(binary);
  }
  return base64;
}

/** @internal */
/*#__NO_SIDE_EFFECTS__*/
export function portableFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
