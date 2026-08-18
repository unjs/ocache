// ocache benchmark harness.
//
//   node bench/index.ts                          all scenarios, steady load
//   node bench/index.ts ssr-product-page         one scenario
//   node bench/index.ts --load=ramp              capacity: highest rate each config sustains
//   node bench/index.ts --load=burst             cold-cache stampede (scenarios that define it)
//   node bench/index.ts --profiles=memory,sql    override the storage sweep
//   node bench/index.ts --json=out.json --md=out.md
//
// Both files default to `bench/results/<load>.{json,md}`, which is where the chart and docs
// stages read from. `--md=-` prints the report to stdout instead of writing it.
//
// Every configuration runs against the same seed, the same key sequence and the same
// offered arrival times. The only difference between a baseline row and a cached row is
// whether ocache is in the request path.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { measureHitCost } from "./harness/calibrate.ts";
import { renderBreakEven, renderScenario } from "./harness/report.ts";
import { runOnce, runRamp } from "./harness/run.ts";
import { PROFILES } from "./harness/storage.ts";

import apiList from "./scenarios/api-list.ts";
import fanoutAggregate from "./scenarios/fanout-aggregate.ts";
import markdownRender from "./scenarios/markdown-render.ts";
import ogImage from "./scenarios/og-image.ts";
import personalizedDashboard from "./scenarios/personalized-dashboard.ts";
import ssrProductPage from "./scenarios/ssr-product-page.ts";
import upstreamProxy from "./scenarios/upstream-proxy.ts";

import type { HitCost } from "./harness/calibrate.ts";
import type { RunRow } from "./harness/run.ts";
import type { Scenario } from "./harness/scenario.ts";
import type { ProfileName } from "./harness/storage.ts";

const RESULTS = join(dirname(fileURLToPath(import.meta.url)), "results");

const SCENARIOS: Scenario[] = [
  ssrProductPage,
  apiList,
  personalizedDashboard,
  ogImage,
  upstreamProxy,
  markdownRender,
  fanoutAggregate,
];

function parseArgs(argv: string[]) {
  const ids: string[] = [];
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [key, value = "true"] = arg.slice(2).split("=", 2);
      flags.set(key!, value);
    } else {
      ids.push(arg);
    }
  }
  return { ids, flags };
}

const { ids, flags } = parseArgs(process.argv.slice(2));

if (flags.has("list")) {
  for (const scenario of SCENARIOS) {
    console.log(`${scenario.id.padEnd(24)} ${scenario.kind.padEnd(9)} ${scenario.summary}`);
  }
  process.exit(0);
}

const selected = ids.length > 0 ? SCENARIOS.filter((s) => ids.includes(s.id)) : SCENARIOS;
if (selected.length === 0) {
  console.error(`No scenario matched ${ids.join(", ")}. Use --list.`);
  process.exit(1);
}

const seed = Number(flags.get("seed") ?? 1);
const load = (flags.get("load") ?? "steady") as "steady" | "burst" | "ramp";
const durationOverride = flags.has("duration") ? Number(flags.get("duration")) : undefined;
const profileOverride = flags.get("profiles")?.split(",") as ProfileName[] | undefined;
const p99Budget = Number(flags.get("p99") ?? 1000);
/** Prewarm requests per run; `--prewarm=0` measures a cold cache instead. */
const prewarmFor = (keyspace: number) =>
  flags.has("prewarm") ? Number(flags.get("prewarm")) : keyspace * 3;

const started = Date.now();
const sections: string[] = [];
const allRows: RunRow[] = [];
const sustained: Array<{ scenario: string; config: string; rps: number }> = [];

console.error(`ocache bench · seed ${seed} · load ${load} · node ${process.version}\n`);

// Measure the hit path before any load exists to distort it.
const payloads = [...new Set(selected.map((s) => s.payloadBytes))].sort((a, b) => a - b);
const hitCosts: HitCost[] = [];
for (const bytes of payloads) {
  process.stderr.write(`  calibrating hit path @ ${(bytes / 1024).toFixed(0)} KiB `);
  const cost = await measureHitCost(bytes);
  hitCosts.push(cost);
  console.error(
    `→ handler +${cost.handlerAddedUs.toFixed(1)} us, function +${cost.functionAddedUs.toFixed(1)} us`,
  );
}
console.error("");

for (const scenario of selected) {
  const profiles = profileOverride ?? scenario.storageProfiles;
  const spec = {
    ...(load === "burst" ? (scenario.load.burst ?? scenario.load.steady) : scenario.load.steady),
  };
  if (durationOverride) spec.durationMs = durationOverride;

  const configs: Array<{ mode: "baseline" | "cached" | "tiered"; profile: ProfileName }> = [
    { mode: "baseline", profile: profiles[0]! },
    ...profiles.map((profile) => ({ mode: "cached" as const, profile })),
    ...(scenario.tiers
      ? profiles
          .filter((p) => p !== "memory")
          .map((profile) => ({ mode: "tiered" as const, profile }))
      : []),
  ];

  const rows: RunRow[] = [];
  for (const config of configs) {
    const label = config.mode === "baseline" ? "baseline" : `${config.mode}/${config.profile}`;
    if (load === "ramp") {
      const steps = scenario.load.ramp ?? [spec.rps];
      process.stderr.write(`  ${scenario.id} ${label} ramp `);
      const result = await runRamp(scenario, config.mode, config.profile, {
        seed,
        steps,
        p99BudgetMs: p99Budget,
        durationMs: durationOverride ?? 5000,
        prewarm: prewarmFor(scenario.keyspace),
      });
      sustained.push({ scenario: scenario.id, config: label, rps: result.sustainedRps });
      rows.push(...result.rows);
      console.error(`→ ${result.sustainedRps} rps sustained`);
    } else {
      process.stderr.write(`  ${scenario.id} ${label} @ ${spec.rps} rps `);
      const row = await runOnce(scenario, config.mode, config.profile, {
        seed,
        spec,
        // A burst run is about a cold cache, so it never prewarms.
        prewarm: load === "burst" ? 0 : prewarmFor(scenario.keyspace),
      });
      rows.push(row);
      console.error(
        `→ p50 ${row.p50.toFixed(1)}ms p99 ${row.p99.toFixed(1)}ms · ` +
          `${row.originCalls} origin calls${row.overloaded ? " · OVERLOADED" : ""}`,
      );
    }
  }
  allRows.push(...rows);
  sections.push(renderScenario(scenario, rows));
}

if (sustained.length > 0) {
  const lines = [
    "### Sustained capacity",
    "",
    "| scenario | config | max rps within p99 budget |",
    "|---|---|--:|",
  ];
  for (const entry of sustained) {
    lines.push(`| ${entry.scenario} | ${entry.config} | ${entry.rps} |`);
  }
  sections.unshift(lines.join("\n") + "\n");
}

const markdown = [
  "# ocache benchmark",
  "",
  `Node ${process.version} · seed ${seed} · load \`${load}\` · ${((Date.now() - started) / 1000).toFixed(0)}s`,
  "",
  "Storage profiles are simulated round trips (lognormal, fitted to p50/p99) plus the",
  "JSON encode/decode a remote client library performs on the caller's thread:",
  "",
  "| profile | read p50/p99 | write p50/p99 | models |",
  "|---|--:|--:|---|",
  ...Object.entries(PROFILES).map(
    ([name, p]) =>
      `| \`${name}\` | ${p.readP50}/${p.readP99} ms | ${p.writeP50}/${p.writeP99} ms | ${p.note} |`,
  ),
  "",
  ...sections,
  renderBreakEven(hitCosts),
].join("\n");

/** `--md=-` prints the report; anything else is a path, defaulting to `results/<load>.md`. */
const mdFlag = flags.get("md");
if (mdFlag === "-") {
  console.log(`\n${markdown}`);
} else {
  const mdPath = mdFlag ? resolve(mdFlag) : join(RESULTS, `${load}.md`);
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, markdown);
  console.error(`\nwrote ${mdPath}`);
}

const jsonFlag = flags.get("json");
const jsonPath = jsonFlag ? resolve(jsonFlag) : join(RESULTS, `${load}.json`);
mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(
  jsonPath,
  JSON.stringify(
    { node: process.version, seed, load, hitCosts, rows: allRows, sustained },
    undefined,
    2,
  ),
);
console.error(`wrote ${jsonPath}`);
