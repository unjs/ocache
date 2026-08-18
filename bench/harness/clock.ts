// Sub-millisecond delays without blocking the event loop.
//
// `setTimeout` floors at ~1ms with timer-queue jitter, so it cannot model a 0.12ms
// storage round trip. One pump drains a due-list against `performance.now()`: it uses
// `setTimeout` while the next deadline is far and `setImmediate` when it is near, which
// reaches ~50-150us resolution.
//
// The pump competes with the workload for the loop on purpose. A scenario that burns CPU
// makes every pending delay overshoot, exactly as a real overloaded server does.

type Waiter = { at: number; resolve: () => void };

const heap: Waiter[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let immediate: ReturnType<typeof setImmediate> | undefined;
// Deadline the pending timer was armed for. A waiter that arrives with an earlier
// deadline has to re-arm it, or it waits behind an unrelated later one.
let armedFor = Infinity;

/** Loop iterations spent inside the pump, for harness-overhead accounting. */
export let pumpTicks = 0;

function up(i: number) {
  const node = heap[i]!;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent]!.at <= node.at) break;
    heap[i] = heap[parent]!;
    i = parent;
  }
  heap[i] = node;
}

function down(i: number) {
  const node = heap[i]!;
  const half = heap.length >> 1;
  while (i < half) {
    let child = i * 2 + 1;
    const right = child + 1;
    if (right < heap.length && heap[right]!.at < heap[child]!.at) child = right;
    if (heap[child]!.at >= node.at) break;
    heap[i] = heap[child]!;
    i = child;
  }
  heap[i] = node;
}

function push(waiter: Waiter) {
  heap.push(waiter);
  up(heap.length - 1);
}

function pop(): Waiter {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    down(0);
  }
  return top;
}

function pump() {
  timer = undefined;
  immediate = undefined;
  armedFor = Infinity;
  pumpTicks++;
  const now = performance.now();
  while (heap.length > 0 && heap[0]!.at <= now) {
    pop().resolve();
  }
  schedule();
}

function schedule() {
  if (heap.length === 0 || immediate !== undefined) return;
  const at = heap[0]!.at;
  if (timer !== undefined) {
    // Already covered by a timer that fires no later than this deadline.
    if (at >= armedFor) return;
    clearTimeout(timer);
    timer = undefined;
    armedFor = Infinity;
  }
  const delta = at - performance.now();
  if (delta > 2) {
    // Wake early and let the immediate path cover the remainder. The timer stays
    // referenced: it is the harness heartbeat, and a scenario with no real I/O has
    // nothing else holding the loop open.
    armedFor = at;
    timer = setTimeout(pump, delta - 1.5);
  } else {
    immediate = setImmediate(pump);
  }
}

/** Resolves after `ms`, yielding the loop. A non-positive delay still yields once. */
export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    push({ at: performance.now() + Math.max(ms, 0), resolve });
    schedule();
  });
}

/** Burns `ms` of real CPU on the main thread, blocking the loop like a render would. */
export function burnCpu(ms: number): void {
  if (ms <= 0) return;
  const end = performance.now() + ms;
  let x = 1;
  do {
    // Batch the work so `performance.now()` is not the thing being measured.
    for (let i = 0; i < 2000; i++) x = (Math.imul(x, 48_271) + i) >>> 0;
  } while (performance.now() < end);
  if (x === -1) throw new Error("unreachable");
}

/** Drains any delay still pending, for teardown. */
export async function settle(limitMs = 5000): Promise<void> {
  const deadline = performance.now() + limitMs;
  // The loop's own delay is in the heap while it awaits, so one entry means empty.
  while (heap.length > 1 && performance.now() < deadline) {
    await delay(1);
  }
}
