// Docs: @docs/5.handler.md

import type { HTTPEvent } from "../types.ts";

/** A live body handed to the request whose resolution is producing it. */
export interface StreamedResponse {
  body: ReadableStream<Uint8Array>;
  init: ResponseInit;
}

// The serve path registers interest before the resolution starts, and `serialize` hands the
// live body back through it. This is a channel keyed by event, like `resolveSignal` in
// `cache.ts`: the resolver receives only the caller's arguments, so neither direction can be
// an argument. Allocated on the first streaming handler.
let listeners: WeakMap<HTTPEvent, (streamed: StreamedResponse | undefined) => void> | undefined;

/** Serve path: wait for the live body of the resolution this request may lead. */
export function openStreamChannel(event: HTTPEvent): Promise<StreamedResponse | undefined> {
  return new Promise((resolve) => {
    (listeners ??= new WeakMap()).set(event, resolve);
  });
}

/**
 * Serve path: stop listening.
 *
 * Call this once the request is served another way. A published stream nothing reads would
 * queue the whole body in its controller, which is the retention the buffering limit exists
 * to bound.
 */
export function closeStreamChannel(event: HTTPEvent): void {
  const listener = listeners?.get(event);
  if (listener) {
    listeners!.delete(event);
    listener(undefined);
  }
}

/** `serialize`: the listener for this resolution, taken once. */
export function takeStreamListener(
  event: HTTPEvent,
): ((streamed: StreamedResponse | undefined) => void) | undefined {
  const listener = listeners?.get(event);
  if (listener) {
    listeners!.delete(event);
  }
  return listener;
}

/** A body being written to as it is read. */
export interface StreamSink {
  readonly body: ReadableStream<Uint8Array>;
  push(chunk: Uint8Array): void;
  close(): void;
  error(reason: unknown): void;
}

/**
 * Creates a body the fill writes into.
 *
 * The sink has no `pull`: the fill drives it. A slow consumer must not stall the fill and a
 * cancelled one must not end it, because the entry is still being written — the same rule
 * that keeps a caller's `AbortSignal` out of a shared resolution. Every operation is a no-op
 * once the stream is closed, errored, or cancelled.
 */
export function createStreamSink(): StreamSink {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      controller = undefined;
    },
  });
  return {
    body,
    push(chunk) {
      try {
        controller?.enqueue(chunk);
      } catch {
        // The consumer is gone. The fill continues.
        controller = undefined;
      }
    },
    close() {
      const c = controller;
      controller = undefined;
      try {
        c?.close();
      } catch {
        // Already closed or cancelled.
      }
    },
    error(reason) {
      const c = controller;
      controller = undefined;
      try {
        c?.error(reason);
      } catch {
        // Already closed or cancelled.
      }
    },
  };
}
