// The contract every scenario implements.
//
// A scenario builds one runnable closure per (mode, storage profile) so that baseline and
// cached runs are separate processes' worth of fresh state, yet share a seed: given the
// same seed both modes see the identical key sequence, which is what makes the comparison
// a comparison.

import type { HTTPEvent, ServerRequest } from "../../src/types.ts";
import type { Origin, OriginSpec } from "./origin.ts";
import type { Rng } from "./random.ts";
import type { ProfileName } from "./storage.ts";
import type { LoadSpec } from "./driver.ts";
import type { StorageInterface } from "../../src/index.ts";

/**
 * `tiered` is `cached` with the scenario's `tiers` prefixes in front of the profiled
 * backend, so the two can be compared on one storage profile.
 */
export type Mode = "baseline" | "cached" | "tiered";

export interface ScenarioContext {
  mode: Mode;
  rng: Rng;
  origin: Origin;
  /** Backend for this run. Present for `baseline` too, where it stays unused. */
  storage: StorageInterface;
  /** Base prefixes for this run: one prefix, or the scenario's tiers in `tiered` mode. */
  base: string | string[];
  /** Collects background work so SWR revalidation is counted, not dropped. */
  waitUntil: (promise: Promise<unknown>) => void;
}

/** Returns the `x-cache` status of the served response, or `null` when there is none. */
export type ScenarioRunner = (index: number) => Promise<string | null | undefined>;

export interface Scenario {
  id: string;
  title: string;
  kind: "handler" | "function";
  /** One line on what real workload this stands for. */
  summary: string;
  /** What the result is expected to demonstrate, printed with the table. */
  expect: string;
  origin: OriginSpec;
  /** Approximate stored payload, for the storage payload-latency term. */
  payloadBytes: number;
  /** Distinct cache keys in the working set. */
  keyspace: number;
  storageProfiles: ProfileName[];
  /**
   * Base prefixes for an extra `tiered` run, fastest first.
   *
   * Set this to add a memory-over-backend comparison. ocache reads tiers in order and
   * stops at the first hit; a miss writes every tier.
   */
  tiers?: [string, ...string[]];
  load: { steady: LoadSpec; burst?: LoadSpec; ramp?: number[] };
  /** Ceilings for the backing memory store; sized to hold the working set by default. */
  memory?: { maxBytes?: number; maxSize?: number };
  create(ctx: ScenarioContext): ScenarioRunner;
}

/** Builds an event whose request carries the driver's `waitUntil`. */
export function makeEvent(
  url: string,
  init: { headers?: Record<string, string>; method?: string } | undefined,
  waitUntil: (promise: Promise<unknown>) => void,
): HTTPEvent {
  const req = new Request(url, {
    method: init?.method ?? "GET",
    headers: init?.headers,
  }) as ServerRequest;
  req.waitUntil = waitUntil;
  return { req, url: new URL(url) };
}

/** Deterministic filler of a given size; built once and sliced, not rebuilt per call. */
export function filler(bytes: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 <>/="';
  let out = "";
  for (let i = 0; out.length < bytes; i++) {
    out += alphabet[(i * 7) % alphabet.length];
    if (i % 79 === 0) out += "\n";
  }
  return out.slice(0, bytes);
}

/** Deterministic bytes that are not valid UTF-8, to exercise the base64 storage path. */
export function binaryFiller(bytes: number, seed: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < bytes; i++) {
    x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0;
    // Keep the high bit set so the run never decodes as UTF-8.
    out[i] = 0x80 | (x & 0x7f);
  }
  return out;
}
