import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryStorage } from "../src/index.ts";
import { runLoad } from "../bench/harness/driver.ts";
import { createOrigin } from "../bench/harness/origin.ts";
import { createRng } from "../bench/harness/random.ts";
import { renderScenario } from "../bench/harness/report.ts";
import fanoutAggregate from "../bench/scenarios/fanout-aggregate.ts";
import ogImage from "../bench/scenarios/og-image.ts";

import type { RunRow } from "../bench/harness/run.ts";
import type { ScenarioContext } from "../bench/harness/scenario.ts";

const row = (values: Partial<RunRow>): RunRow =>
  ({
    scenario: "scenario",
    mode: "baseline",
    profile: "-",
    offeredRps: 10,
    achievedRps: 10,
    completed: 10,
    errors: 0,
    shed: 0,
    overloaded: false,
    p50: 1,
    p90: 1,
    p99: 1,
    p999: 1,
    max: 1,
    mean: 1,
    originCalls: 10,
    originPeak: 1,
    originQueuedMs: 0,
    originCallsPerRequest: 1,
    status: { hit: 0, stale: 0, revalidated: 0, miss: 0, bypass: 0, notModified: 0 },
    storage: {
      reads: 0,
      readHits: 0,
      writes: 0,
      deletes: 0,
      readMs: 0,
      writeMs: 0,
      bytesWritten: 0,
      evicted: 0,
    },
    process: { cpuMs: 0, wallMs: 0, loopDelayP99Ms: 0, loopDelayMaxMs: 0 },
    cpuPerRequestMs: 0,
    ...values,
  }) as RunRow;

function context(
  scenario: typeof fanoutAggregate,
  mode: ScenarioContext["mode"],
  rng = createRng(1),
): ScenarioContext {
  const origin = createOrigin(scenario.origin, createRng(2));
  origin.instant = true;
  return {
    mode,
    rng,
    origin,
    storage: createMemoryStorage({ maxBytes: Infinity }),
    base: "/cache",
    waitUntil: () => {},
  };
}

describe("benchmark harness", () => {
  it("drains timed warmup and nested background work before resetting counters", async () => {
    const background: Promise<unknown>[] = [];
    let active = 0;
    let completed = 0;
    let backgroundCompleted = 0;
    let registered = false;
    await runLoad({
      spec: { rps: 1000, warmupMs: 10, durationMs: 10 },
      rng: createRng(1),
      background,
      request: async () => {
        active++;
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        completed++;
        if (!registered) {
          registered = true;
          background.push(
            Promise.resolve().then(() => {
              backgroundCompleted++;
              background.push(Promise.resolve().then(() => backgroundCompleted++));
            }),
          );
        }
        return null;
      },
      onWarmupEnd: () => {
        expect(active).toBe(0);
        expect(background).toHaveLength(0);
        expect(backgroundCompleted).toBe(2);
        expect(completed).toBeGreaterThan(0);
      },
    });
  });

  it("compares ramp rows only at matching offered rates", () => {
    const report = renderScenario(
      {
        id: "scenario",
        title: "Scenario",
        kind: "function",
        summary: "summary",
        expect: "expect",
        origin: { ioMs: 0, cpuMs: 0, concurrency: Infinity },
        payloadBytes: 1,
        keyspace: 1,
        storageProfiles: ["memory"],
        load: { steady: { rps: 1, warmupMs: 0, durationMs: 1 } },
        create: () => async () => null,
      },
      [
        row({ offeredRps: 10, p99: 100, originCalls: 10 }),
        row({ offeredRps: 20, p99: 200, originCalls: 20 }),
        row({ mode: "cached", profile: "memory", offeredRps: 10, p99: 50, originCalls: 2 }),
        row({ mode: "cached", profile: "memory", offeredRps: 20, p99: 50, originCalls: 4 }),
      ],
    );
    expect(report).toContain("| memory | 10 | 2.00x | 8 |");
    expect(report).toContain("| memory | 20 | 4.00x | 16 |");
  });

  it("pairs origin-call charts by offered rate and rejects ramp docs", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocache-bench-test-"));
    try {
      const input = join(dir, "ramp.json");
      const rows = [
        row({ scenario: "markdown-render", offeredRps: 25, originCalls: 10 }),
        row({
          scenario: "markdown-render",
          offeredRps: 50,
          completed: 10,
          originCalls: 20,
          originCallsPerRequest: 2,
        }),
        row({
          scenario: "markdown-render",
          mode: "cached",
          profile: "memory",
          offeredRps: 25,
          originCalls: 2,
          originCallsPerRequest: 0.2,
        }),
        row({
          scenario: "markdown-render",
          mode: "cached",
          profile: "memory",
          offeredRps: 50,
          originCalls: 10,
          originCallsPerRequest: 1,
        }),
      ];
      writeFileSync(
        input,
        JSON.stringify({ node: process.version, seed: 1, load: "ramp", hitCosts: [], rows }),
      );
      execFileSync(process.execPath, ["bench/chart.ts", input, `--out=${dir}`, "--no-landing"]);
      const chart = readFileSync(join(dir, "origin-call-reduction.svg"), "utf8");
      expect(chart).toContain(">80.0%<");
      expect(chart).toContain(">50.0%<");

      const docs = spawnSync(process.execPath, ["bench/docs.ts", input], { encoding: "utf8" });
      expect(docs.status).toBe(1);
      expect(docs.stderr).toContain("requires a steady run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("models three upstream calls and a 6 KiB aggregate", async () => {
    const ctx = context(fanoutAggregate, "baseline");
    await fanoutAggregate.create(ctx)(0);
    expect(ctx.origin.calls).toBe(3);
  });

  it("keeps OG-image traffic RNG consumption equal between modes", async () => {
    const calls: number[] = [];
    for (const mode of ["baseline", "cached"] as const) {
      const source = createRng(1);
      let count = 0;
      const rng = () => {
        count++;
        return source();
      };
      const ctx = context(ogImage, mode, rng);
      const run = ogImage.create(ctx);
      for (let i = 0; i < 20; i++) await run(i);
      calls.push(count);
    }
    expect(calls[0]).toBe(calls[1]);
  });
});
