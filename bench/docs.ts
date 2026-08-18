// Third stage of the benchmark: JSON in, documentation page out.
//
//   node bench/docs.ts bench/results/steady.json
//
// Renders the charts through `bench/chart.ts`, inlines them, and fills the placeholders in
// `bench/docs.md` from the same JSON. The page is the only output: the charts live inside it
// rather than beside it. The prose lives in the template; every number on the page is
// substituted here, so a run on other hardware keeps the page true.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROFILES } from "./harness/storage.ts";

import type { HitCost } from "./harness/calibrate.ts";
import type { RunRow } from "./harness/run.ts";

interface BenchFile {
  node: string;
  seed: number;
  load: string;
  hitCosts: HitCost[];
  rows: RunRow[];
  sustained: Array<{ scenario: string; config: string; rps: number }>;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "bench/docs.md");
const CHART_STAGE = join(ROOT, "bench/chart.ts");
const PAGE = join(ROOT, "docs/docs/11.benchmarks.md");

// -- formatting -------------------------------------------------------------------------

/** Same conventions as the markdown report, so the page and the report agree digit for digit. */
const ms = (value: number) => (value >= 100 ? value.toFixed(0) : value.toFixed(2));
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const us = (value: number) => value.toFixed(1);
const cpu = (value: number) => value.toFixed(3);
const ratio = (value: number) => `${value.toFixed(2)}x`;
const kib = (bytes: number) => `${(bytes / 1024).toFixed(0)} KiB`;
const count = (value: number) => value.toLocaleString("en-US");

/** One value when the ends agree once formatted, `lo-hi` when they do not. */
function span(values: number[], format: (value: number) => string): string {
  const lo = format(Math.min(...values));
  const hi = format(Math.max(...values));
  return lo === hi ? lo : `${lo}–${hi}`;
}

const width = (value: string) => [...value].length;

type Align = "left" | "right";

/** Padded the way oxfmt pads, so the generated page needs no reformatting. */
function table(headers: string[], aligns: Align[], rows: string[][]): string {
  const widths = headers.map((header, i) =>
    Math.max(3, width(header), ...rows.map((row) => width(row[i] ?? ""))),
  );
  const pad = (value: string, i: number) => {
    const fill = " ".repeat(widths[i]! - width(value));
    return aligns[i] === "right" ? fill + value : value + fill;
  };
  const line = (cells: string[]) => `| ${cells.map((c, i) => pad(c, i)).join(" | ")} |`;
  const rule = widths.map((w, i) =>
    aligns[i] === "right" ? `${"-".repeat(w - 1)}:` : "-".repeat(w),
  );
  return [line(headers), `| ${rule.join(" | ")} |`, ...rows.map((row) => line(row))].join("\n");
}

// -- data -------------------------------------------------------------------------------

interface Group {
  id: string;
  baseline: RunRow | undefined;
  cached: RunRow[];
}

function groupByScenario(rows: RunRow[]): Group[] {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    let group = groups.get(row.scenario);
    if (!group) {
      group = { id: row.scenario, baseline: undefined, cached: [] };
      groups.set(row.scenario, group);
    }
    if (row.mode === "baseline") group.baseline = row;
    else group.cached.push(row);
  }
  return [...groups.values()];
}

/** p99 improvement of one cached row over its own scenario's baseline. */
function speedup(group: Group, row: RunRow): number {
  return group.baseline && row.offeredRps === group.baseline.offeredRps && row.p99 > 0
    ? group.baseline.p99 / row.p99
    : 0;
}

function originReduction(group: Group, row: RunRow): number {
  const baseline = group.baseline?.originCallsPerRequest ?? 0;
  return baseline === 0 ? 0 : Math.max(0, 1 - row.originCallsPerRequest / baseline);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Profiles this run actually exercised, in the order the profile table declares them. */
function usedProfiles(rows: RunRow[]): Array<[string, (typeof PROFILES)[keyof typeof PROFILES]]> {
  const seen = new Set<string>(rows.map((row) => row.profile));
  return Object.entries(PROFILES).filter(([name]) => seen.has(name));
}

/** Largest overhead measured on the hit path, in milliseconds — the break-even term. */
function overheadMs(costs: HitCost[]): number {
  return costs.length === 0 ? 0 : Math.max(...costs.map((c) => c.handlerAddedUs)) / 1000;
}

function values(data: BenchFile): Record<string, string> {
  const groups = groupByScenario(data.rows);
  const cached = groups.flatMap((group) => group.cached.map((row) => ({ group, row })));
  if (cached.length === 0) throw new Error("no cached rows: nothing to report");

  const speedups = cached.map(({ group, row }) => speedup(group, row));
  const best = cached[speedups.indexOf(Math.max(...speedups))]!;
  // Least helped: the scenario whose best configuration gains least.
  const perScenario = groups
    .filter((group) => group.cached.length > 0)
    .map((group) => ({ group, best: Math.max(...group.cached.map((row) => speedup(group, row))) }));
  const worst = perScenario.reduce((a, b) => (b.best < a.best ? b : a));

  // Heaviest main-thread cost the cache removed, which is the capacity story.
  const drops = groups
    .filter((group) => group.baseline && group.cached.length > 0)
    .map((group) => ({
      group,
      baseline: group.baseline!.cpuPerRequestMs,
      cached: Math.min(...group.cached.map((row) => row.cpuPerRequestMs)),
    }));
  const drop = drops.reduce((a, b) => (b.baseline - b.cached > a.baseline - a.cached ? b : a));

  const costs = data.hitCosts ?? [];
  const payloads = costs.map((c) => c.payloadBytes);

  return {
    node: data.node,
    seed: String(data.seed),
    load: data.load,
    "scenario-count": String(groups.length),
    "config-count": String(cached.length),
    "measured-requests": count(data.rows.reduce((sum, row) => sum + row.completed, 0)),
    "profile-list": usedProfiles(data.rows)
      .map(([name]) => `\`${name}\``)
      .join(", "),

    "speedup-min": ratio(Math.min(...speedups)),
    "speedup-max": ratio(Math.max(...speedups)),
    "speedup-median": ratio(median(speedups)),
    "offload-min": pct(Math.min(...cached.map(({ group, row }) => originReduction(group, row)))),
    "offload-max": pct(Math.max(...cached.map(({ group, row }) => originReduction(group, row)))),
    "top-scenario": best.group.id,
    "top-speedup": ratio(Math.max(...speedups)),
    "worst-scenario": worst.group.id,
    "worst-speedup": ratio(worst.best),
    "worst-offload": pct(
      Math.max(...worst.group.cached.map((row) => originReduction(worst.group, row))),
    ),

    "cpu-top-scenario": drop.group.id,
    "cpu-top-baseline": cpu(drop.baseline),
    "cpu-top-cached": cpu(drop.cached),

    "hit-payload-min": kib(Math.min(...payloads)),
    "hit-payload-max": kib(Math.max(...payloads)),
    "handler-added-min": us(Math.min(...costs.map((c) => c.handlerAddedUs))),
    "handler-added-max": us(Math.max(...costs.map((c) => c.handlerAddedUs))),
    "function-added-min": us(Math.min(...costs.map((c) => c.functionAddedUs))),
    "function-added-max": us(Math.max(...costs.map((c) => c.functionAddedUs))),
    "breakeven-overhead": overheadMs(costs).toFixed(2),
  };
}

function tables(data: BenchFile): Record<string, string> {
  const groups = groupByScenario(data.rows).filter(
    (group) => group.baseline && group.cached.length > 0,
  );

  const scenarios = table(
    [
      "scenario",
      "offered rps",
      "no-cache p99 (ms)",
      "cached p99 (ms)",
      "p99 vs no cache",
      "origin-call reduction",
    ],
    ["left", "right", "right", "right", "right", "right"],
    groups.map((group) => [
      `\`${group.id}\``,
      String(group.baseline!.offeredRps),
      ms(group.baseline!.p99),
      span(
        group.cached.map((row) => row.p99),
        ms,
      ),
      span(
        group.cached.map((row) => speedup(group, row)),
        ratio,
      ),
      span(
        group.cached.map((row) => originReduction(group, row)),
        pct,
      ),
    ]),
  );

  const hitCost = table(
    [
      "payload",
      "handler direct (µs)",
      "handler cached (µs)",
      "handler adds (µs)",
      "function adds (µs)",
    ],
    ["right", "right", "right", "right", "right"],
    (data.hitCosts ?? []).map((cost) => [
      kib(cost.payloadBytes),
      us(cost.handlerBaselineUs),
      us(cost.handlerCachedUs),
      `**+${us(cost.handlerAddedUs)}**`,
      `**+${us(cost.functionAddedUs)}**`,
    ]),
  );

  const added = overheadMs(data.hitCosts ?? []);
  const breakEven = table(
    ["backend", "read p50 (ms)", "read p99 (ms)", "a handler pays off above (ms)", "models"],
    ["left", "right", "right", "right", "left"],
    usedProfiles(data.rows).map(([name, profile]) => [
      `\`${name}\``,
      String(profile.readP50),
      String(profile.readP99),
      (profile.readP50 + added).toFixed(2),
      profile.note,
    ]),
  );

  return { scenarios, "hit-cost": hitCost, "break-even": breakEven };
}

// -- charts -----------------------------------------------------------------------------

/**
 * Runs the chart stage into a scratch directory and returns each chart's SVG.
 *
 * `chart.ts` is a script, not a module: it reads `process.argv`, writes files and calls
 * `process.exit`. Spawning it keeps the contract at the documented command line instead of
 * depending on how its top level happens to be written. `--no-landing` holds this stage to
 * its own output: the site's landing SVG belongs to the chart stage, not to this one.
 */
function renderCharts(input: string): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "ocache-bench-docs-"));
  try {
    execFileSync(process.execPath, [CHART_STAGE, input, `--out=${dir}`, "--no-landing"], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    const charts = new Map<string, string>();
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".svg")) continue;
      charts.set(file.slice(0, -".svg".length), readFileSync(join(dir, file), "utf8"));
    }
    return charts;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Report order — summary, overview, capacity, one per scenario, hit path — then anything new. */
function chartOrder(data: BenchFile, charts: Map<string, string>): string[] {
  const wanted = [
    "combined",
    "origin-call-reduction",
    "sustained",
    ...groupByScenario(data.rows).map((group) => `latency-${group.id}`),
    "hit-cost",
  ];
  const ordered = wanted.filter((name) => charts.has(name));
  const rest = [...charts.keys()].filter((name) => !ordered.includes(name)).sort();
  return [...ordered, ...rest];
}

/** Charts that reached the page, for the closing line. */
const inlined = new Set<string>();

/**
 * The root `<svg>` sized from its own `viewBox` instead of from the pixel width the chart stage
 * drew it at, so a chart takes the width of the page column and scales down with it. `max-width`
 * comes from the `viewBox` rather than from a repeated constant, and holds a chart to its drawn
 * size on a wide page: stretching a chart past the width its labels were laid out for buys
 * nothing.
 */
function responsive(svg: string): string {
  return svg.replace(/^<svg\b[^>]*>/, (tag) => {
    const drawn = /viewBox="0 0 (\d+(?:\.\d+)?)/.exec(tag)?.[1];
    if (!drawn) throw new Error("chart svg has no viewBox to size from");
    const style = `width:100%;height:auto;max-width:${drawn}px`;
    return tag
      .replaceAll(/\s(?:width|height)="[^"]*"/g, "")
      .replace(/^<svg\b/, `<svg style="${style}"`);
  });
}

/**
 * A chart inlined into the page rather than linked as an image.
 *
 * Each SVG carries both palettes: `prefers-color-scheme` when it is fetched on its own, an
 * ancestor `.dark` or `[data-theme]` when it is part of a document. Only an inlined chart can
 * see the site's own theme class, and undocs renders the site dark by default, so a linked
 * image would show a light chart on a dark page. The wrapper keeps the chart a block of its
 * own and stays a scroll container for anything the page puts beside it.
 */
function figure(name: string, svg: string): string {
  inlined.add(name);
  return `<div style="max-width:100%;overflow-x:auto">\n${responsive(svg.trim())}\n</div>`;
}

// -- output -----------------------------------------------------------------------------

const input = resolve(process.argv[2] ?? join(ROOT, "bench/results/steady.json"));
const data = JSON.parse(readFileSync(input, "utf8")) as BenchFile;
for (const row of data.rows ?? []) {
  if (!Number.isFinite(row.originCallsPerRequest)) {
    row.originCallsPerRequest = row.completed === 0 ? 0 : row.originCalls / row.completed;
  }
}
if (data.load !== "steady") {
  console.error(`bench:docs requires a steady run, received ${data.load}`);
  process.exit(1);
}
if (!Array.isArray(data.rows) || data.rows.length === 0) {
  console.error(`${input} has no rows`);
  process.exit(1);
}

const charts = renderCharts(input);
const order = chartOrder(data, charts);

const substitutions = { value: values(data), table: tables(data) };

const template = readFileSync(TEMPLATE, "utf8").replaceAll(/<!-- bench:docs[\s\S]*?-->\n*/g, "");
const page = template.replaceAll(/\{\{(\w+):([^}]+)\}\}/g, (_match, kind: string, key: string) => {
  switch (kind) {
    case "value":
    case "table": {
      const found = substitutions[kind as "value" | "table"][key];
      if (found === undefined) throw new Error(`unknown {{${kind}:${key}}}`);
      return found;
    }
    case "chart": {
      const svg = charts.get(key);
      if (svg === undefined) throw new Error(`this run produced no chart named ${key}`);
      return figure(key, svg);
    }
    case "charts": {
      const matched = order.filter((name) => name.startsWith(key));
      if (matched.length === 0) throw new Error(`no chart name starts with ${key}`);
      return matched.map((name) => figure(name, charts.get(name)!)).join("\n\n");
    }
    default: {
      throw new Error(`unknown placeholder kind ${kind}`);
    }
  }
});

const left = page.match(/\{\{[^}]*\}\}/);
if (left) throw new Error(`unsubstituted placeholder ${left[0]}`);

writeFileSync(PAGE, page.endsWith("\n") ? page : `${page}\n`);
console.error(`wrote ${PAGE} with ${inlined.size} of ${order.length} charts inlined`);
