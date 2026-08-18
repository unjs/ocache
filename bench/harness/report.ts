// Markdown tables plus the two derived numbers the raw rows do not show:
// the speedup against the scenario's own baseline, and the origin cost at which caching
// through a given backend stops paying for itself.

import { PROFILES } from "./storage.ts";

import type { HitCost } from "./calibrate.ts";
import type { RunRow } from "./run.ts";
import type { Scenario } from "./scenario.ts";

const ms = (value: number) => (value >= 100 ? value.toFixed(0) : value.toFixed(2));

export function renderScenario(scenario: Scenario, rows: RunRow[]): string {
  const baselines = new Map(
    rows.filter((row) => row.mode === "baseline").map((row) => [row.offeredRps, row]),
  );
  const out: string[] = [];
  out.push(`### ${scenario.title} \`${scenario.id}\``);
  out.push("");
  out.push(`${scenario.summary}.`);
  out.push("");
  out.push(
    `Origin: ${scenario.origin.ioMs} ms I/O + ${scenario.origin.cpuMs} ms CPU, ` +
      `concurrency ${scenario.origin.concurrency === Infinity ? "unbounded" : scenario.origin.concurrency}. ` +
      `${scenario.keyspace} keys, ~${(scenario.payloadBytes / 1024).toFixed(0)} KiB payload.`,
  );
  out.push("");
  out.push(
    "| config | offered | achieved | rejected | p50 | p90 | p99 | p99.9 | origin calls/req | hit/stale/miss/304 | cpu/req | loop p99 |",
  );
  out.push("|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|");
  for (const row of rows) {
    const label =
      row.mode === "baseline"
        ? "**no cache**"
        : `${row.mode === "tiered" ? "tiered mem+" : ""}${row.profile}`;
    out.push(
      `| ${label} | ${row.offeredRps} | ${row.achievedRps.toFixed(0)}${row.overloaded ? " ⚠" : ""} ` +
        `| ${row.shed} | ${ms(row.p50)} | ${ms(row.p90)} | ${ms(row.p99)} | ${ms(row.p999)} ` +
        `| ${row.originCallsPerRequest.toFixed(3)} ` +
        `| ${scenario.kind === "function" ? "-" : `${row.status.hit}/${row.status.stale}/${row.status.miss}/${row.status.notModified}`} ` +
        `| ${row.cpuPerRequestMs.toFixed(3)} | ${ms(row.process.loopDelayP99Ms)} |`,
    );
  }
  out.push("");

  if (baselines.size > 0) {
    out.push(
      "| config | offered | p99 vs no cache | raw origin call difference | storage reads | blocked on reads | storage writes | bytes written |",
    );
    out.push("|---|--:|--:|--:|--:|--:|--:|--:|");
    for (const row of rows) {
      if (row.mode === "baseline") continue;
      const baseline = baselines.get(row.offeredRps);
      if (!baseline) continue;
      const speedup = row.p99 > 0 ? baseline.p99 / row.p99 : 0;
      out.push(
        `| ${row.mode === "tiered" ? "tiered mem+" : ""}${row.profile} ` +
          `| ${row.offeredRps} | ${speedup.toFixed(2)}x | ${baseline.originCalls - row.originCalls} ` +
          `| ${row.storage.reads} | ${ms(row.storage.readMs)} | ${row.storage.writes} ` +
          `| ${(row.storage.bytesWritten / 1024 / 1024).toFixed(1)} MiB |`,
      );
    }
    out.push("");
  }

  out.push(
    "> `blocked on reads` is wall time, so it includes event-loop queueing behind the scenario's own CPU, not just backend latency.",
  );
  if (scenario.kind === "function") {
    out.push(">");
    out.push(
      "> A cached function has no response header to report a status through, so read `origin calls/req` instead. SWR shows up as a p50 that stays at storage latency while origin calls continue in the background.",
    );
  }
  out.push(">");
  out.push(`> ${scenario.expect}`);
  out.push("");
  return out.join("\n");
}

/**
 * Origin cost at which a cache hit through each backend breaks even.
 *
 * A hit costs one storage read plus the CPU ocache adds on the hit path, measured by
 * `measureHitCost` with no load in the way. Below this line the cache is a loss: the
 * request would have been answered sooner by calling the handler.
 */
export function renderBreakEven(costs: HitCost[]): string {
  const out: string[] = [];
  out.push("### Break-even");
  out.push("");
  out.push("Measured hit-path cost, sequential, memory storage, no competing load:");
  out.push("");
  out.push(
    "| payload | handler direct | handler cached | ocache adds | function direct | function cached | ocache adds |",
  );
  out.push("|--:|--:|--:|--:|--:|--:|--:|");
  for (const cost of costs) {
    out.push(
      `| ${(cost.payloadBytes / 1024).toFixed(0)} KiB | ${cost.handlerBaselineUs.toFixed(1)} us ` +
        `| ${cost.handlerCachedUs.toFixed(1)} us | **+${cost.handlerAddedUs.toFixed(1)} us** ` +
        `| ${cost.functionBaselineUs.toFixed(1)} us | ${cost.functionCachedUs.toFixed(1)} us ` +
        `| **+${cost.functionAddedUs.toFixed(1)} us** |`,
    );
  }
  out.push("");
  // The hit path does not copy the body, so this cost is near flat in payload size.
  const added = costs.length > 0 ? Math.max(...costs.map((c) => c.handlerAddedUs)) / 1000 : 0;
  out.push("Adding each backend's median read gives the origin cost a handler must exceed:");
  out.push("");
  out.push("| backend | read p50 | read p99 | a handler pays off above |");
  out.push("|---|--:|--:|--:|");
  for (const [name, profile] of Object.entries(PROFILES)) {
    out.push(
      `| \`${name}\` | ${profile.readP50} ms | ${profile.readP99} ms ` +
        `| ${(profile.readP50 + added).toFixed(2)} ms |`,
    );
  }
  out.push("");
  out.push(
    "> Uses the largest measured overhead. A handler cheaper than its row is faster without a cache. This is the library's own cost only: a remote backend also decodes the body, which does scale with payload.",
  );
  out.push("");
  return out.join("\n");
}
