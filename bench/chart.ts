// Second stage of the benchmark: JSON in, SVG out.
//
//   node bench/chart.ts bench.json --out=bench/charts
//
// Reads only what `bench/index.ts` wrote, so the charts can be re-rendered without paying
// for another run. One file per chart carries both palettes: the light values ride along as
// presentation attributes and a `<style>` block re-paints them from CSS custom properties.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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

interface BenchFile {
  node: string;
  seed: number;
  load: string;
  hitCosts: HitCost[];
  rows: RunRow[];
  sustained: Array<{ scenario: string; config: string; rps: number }>;
}

const SCENARIOS: Scenario[] = [
  ssrProductPage,
  apiList,
  personalizedDashboard,
  ogImage,
  upstreamProxy,
  markdownRender,
  fanoutAggregate,
];

const META = new Map(SCENARIOS.map((s) => [s.id, s]));

// -- theme ------------------------------------------------------------------------------

/**
 * Two selected palettes, not one flipped.
 *
 * `s1`/`s2` are categorical slots 1 and 2; every other token is chrome or de-emphasis. Both
 * sets pass the lightness band, chroma floor, CVD separation and contrast checks against
 * their own surface.
 */
type Token = "surface" | "ink" | "ink2" | "muted" | "grid" | "axis" | "s1" | "s2" | "deemph";

const LIGHT: Record<Token, string> = {
  surface: "#fcfcfb",
  ink: "#0b0b0b",
  ink2: "#52514e",
  muted: "#898781",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  s1: "#2a78d6",
  s2: "#eb6834",
  deemph: "#a9a7a0",
};

const DARK: Record<Token, string> = {
  surface: "#1a1a19",
  ink: "#ffffff",
  ink2: "#c3c2b7",
  muted: "#898781",
  grid: "#2c2c2a",
  axis: "#383835",
  s1: "#3987e5",
  s2: "#d95926",
  deemph: "#6e6c67",
};

/**
 * Tokens a host page may drive, each with the standalone value as its fallback.
 *
 * Surface and ink are the ones worth handing over: an inlined chart should sit on the
 * page's own plane and ink. The series hues are not offered, because the pair was validated
 * for CVD separation against these two surfaces and a substituted hue is unvalidated.
 * `currentColor` is deliberately not used: its standalone value is black, which is wrong on
 * the dark surface.
 */
const HOOKS: Partial<Record<Token, string>> = {
  surface: "--ocache-chart-surface",
  ink: "--ocache-chart-ink",
  ink2: "--ocache-chart-ink-2",
};

const TOKENS = Object.keys(LIGHT) as Token[];
/** Only these are ever stroked. */
const STROKED: Token[] = ["surface", "grid", "axis"];

const declare = (palette: Record<Token, string>) =>
  TOKENS.map((token) => {
    const hook = HOOKS[token];
    return `--${token}:${hook ? `var(${hook},${palette[token]})` : palette[token]}`;
  }).join(";");

/**
 * Light is the base rule, so no color exists only inside the media query and a renderer
 * that stops at the first rule still gets a complete palette. Explicit ancestor stamps
 * outrank the media query on specificity, in both directions; the class scope keeps the
 * rules off the host page's own elements when the chart is inlined.
 *
 * The token rules sit behind `@supports`, so an engine that understands class selectors but
 * not custom properties skips them and keeps the light presentation attributes, instead of
 * painting every mark with an unresolvable `var()`.
 */
const STYLE = [
  `svg.ocache-chart{${declare(LIGHT)}}`,
  `@media (prefers-color-scheme:dark){svg.ocache-chart{${declare(DARK)}}}`,
  `[data-theme="dark"] svg.ocache-chart,.dark svg.ocache-chart{${declare(DARK)}}`,
  `[data-theme="light"] svg.ocache-chart,.light svg.ocache-chart{${declare(LIGHT)}}`,
  "@supports (--ocache:0){",
  ...TOKENS.map((token) => `.ocache-chart .f-${token}{fill:var(--${token})}`),
  ...STROKED.map((token) => `.ocache-chart .k-${token}{stroke:var(--${token})}`),
  "}",
].join("");

/**
 * Paint attributes for one mark.
 *
 * The literal light value is emitted as a presentation attribute and the class overrides it
 * from CSS. Anything that drops or cannot resolve the stylesheet — a rasterizer, a sanitizer
 * — still renders the light chart rather than a black one.
 */
function paint(fill?: Token, stroke?: Token): string {
  const attrs: string[] = [];
  const classes: string[] = [];
  if (fill) {
    attrs.push(`fill="${LIGHT[fill]}"`);
    classes.push(`f-${fill}`);
  }
  if (stroke) {
    attrs.push(`stroke="${LIGHT[stroke]}"`);
    classes.push(`k-${stroke}`);
  }
  return `${attrs.join(" ")} class="${classes.join(" ")}"`;
}

const FONT = "system-ui, -apple-system, &quot;Segoe UI&quot;, Roboto, Helvetica, Arial, sans-serif";

const WIDTH = 800;

// -- primitives -------------------------------------------------------------------------

const esc = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const n = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2));

/** Character-width estimate; label placement has to fit before anything is drawn. */
const est = (value: string, size: number) => value.length * size * 0.58;

function truncate(value: string, size: number, max: number): string {
  if (est(value, size) <= max) return value;
  const keep = Math.max(1, Math.floor(max / (size * 0.58)) - 1);
  return `${value.slice(0, keep)}…`;
}

function wrap(value: string, size: number, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of value.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && est(next, size) > max) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

interface TextStyle {
  fill: Token;
  size?: number;
  anchor?: "start" | "middle" | "end";
  weight?: number;
}

function text(x: number, y: number, value: string, style: TextStyle): string {
  const anchor = style.anchor && style.anchor !== "start" ? ` text-anchor="${style.anchor}"` : "";
  const weight = style.weight ? ` font-weight="${style.weight}"` : "";
  return (
    `<text x="${n(x)}" y="${n(y)}" font-size="${style.size ?? 11}" ` +
    `${paint(style.fill)}${anchor}${weight}>${esc(value)}</text>`
  );
}

function line(x1: number, y1: number, x2: number, y2: number, stroke: Token, width = 1): string {
  return (
    `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" ` +
    `${paint(undefined, stroke)} stroke-width="${width}"/>`
  );
}

/** Bar with a 4px rounded data-end and a square baseline end. */
function bar(x: number, y: number, w: number, h: number, fill: Token): string {
  if (w <= 0.4) return "";
  const r = Math.min(4, w, h / 2);
  return (
    `<path d="M${n(x)},${n(y)} H${n(x + w - r)} A${r},${r} 0 0 1 ${n(x + w)},${n(y + r)} ` +
    `V${n(y + h - r)} A${r},${r} 0 0 1 ${n(x + w - r)},${n(y + h)} H${n(x)} Z" ${paint(fill)}/>`
  );
}

/** Dot with a 2px surface ring, so overlapping marks stay separate. */
function dot(x: number, y: number, fill: Token, r = 4.5): string {
  return `<circle cx="${n(x)}" cy="${n(y)}" r="${r}" ${paint(fill, "surface")} stroke-width="2"/>`;
}

function legend(x: number, y: number, items: Array<[string, Token]>): string {
  const out: string[] = [];
  let cursor = x;
  for (const [label, token] of items) {
    out.push(`<circle cx="${n(cursor + 4)}" cy="${n(y - 4)}" r="4" ${paint(token)}/>`);
    out.push(text(cursor + 14, y, label, { fill: "ink2", size: 11 }));
    cursor += 14 + est(label, 11) + 18;
  }
  return out.join("");
}

function svgDoc(height: number, title: string, desc: string, body: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${n(height)}" `,
    `viewBox="0 0 ${WIDTH} ${n(height)}" font-family="${FONT}" role="img" class="ocache-chart">`,
    `<title>${esc(title)}</title><desc>${esc(desc)}</desc>`,
    `<style>${STYLE}</style>`,
    `<rect width="${WIDTH}" height="${n(height)}" ${paint("surface")}/>`,
    body,
    "</svg>\n",
  ].join("");
}

/** Title plus wrapped subtitle; returns the markup and the y the plot may start at. */
function header(title: string, subtitle: string): { svg: string; y: number } {
  const out = [text(16, 26, title, { fill: "ink", size: 15, weight: 600 })];
  let y = 26;
  for (const part of wrap(subtitle, 11, WIDTH - 32)) {
    y += 16;
    out.push(text(16, y, part, { fill: "ink2", size: 11 }));
  }
  return { svg: out.join(""), y: y + 10 };
}

// -- scales -----------------------------------------------------------------------------

function decade(value: number, direction: "floor" | "ceil"): number {
  return 10 ** Math[direction](Math.log10(value));
}

function logScale(min: number, max: number, x0: number, x1: number): (v: number) => number {
  const span = Math.log10(max) - Math.log10(min);
  return (v) => x0 + ((Math.log10(Math.max(v, min)) - Math.log10(min)) / span) * (x1 - x0);
}

/** Linear ticks on a 1/2/2.5/5 step, starting at zero. */
function ticks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const mag = 10 ** Math.floor(Math.log10(max / count));
  const step = ([1, 2, 2.5, 5, 10].find((m) => mag * m >= max / count) ?? 10) * mag;
  const out: number[] = [];
  for (let i = 0; i * step <= max * 1.000_001 || i === 0; i++) out.push(i * step);
  if (out[out.length - 1]! < max) out.push(out.length * step);
  return out;
}

// -- formatting -------------------------------------------------------------------------

/** Same convention as the markdown report, so the two agree digit for digit. */
const ms = (value: number) => (value >= 100 ? value.toFixed(0) : value.toFixed(2));
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/** Row label matching the markdown report's `config` column. */
function configLabel(row: RunRow): string {
  if (row.mode === "baseline") return "no cache";
  return `${row.mode === "tiered" ? "tiered mem+" : ""}${row.profile}`;
}

/** A ramp run repeats each config across offered rates, so the rate joins the label. */
function rowLabels(rows: RunRow[]): string[] {
  const labels = rows.map((row) => configLabel(row));
  const repeated = labels.some((label, i) => labels.indexOf(label) !== i);
  return repeated ? rows.map((row, i) => `${labels[i]} @ ${row.offeredRps} rps`) : labels;
}

/** Label column wide enough for the longest label, within bounds the plot can afford. */
const labelWidth = (labels: string[]) =>
  Math.min(260, Math.max(96, ...labels.map((label) => est(label, 11) + 4)));

/** `sustained[]` carries the driver's own `mode/profile` label; align it with the rest. */
function sustainedLabel(config: string): string {
  if (config === "baseline") return "no cache";
  if (config.startsWith("cached/")) return config.slice("cached/".length);
  if (config.startsWith("tiered/")) return `tiered mem+${config.slice("tiered/".length)}`;
  return config;
}

const kib = (bytes: number) => `${Math.round(bytes / 1024)} KiB`;

/** Tick and rate labels: no float noise from the tick step, thousands separated. */
const amount = (value: number) => Number(value.toFixed(6)).toLocaleString("en-US");

// -- chart: latency per scenario --------------------------------------------------------

const ROW_H = 26;
const PLOT_X1 = 640;
const CPU_X = 788;

/**
 * p50 to p99 as a dumbbell on a log axis.
 *
 * The set spans four decades, so a linear axis collapses every cached row onto the same
 * pixel. A dumbbell also avoids the bar-on-a-log-axis problem: there is no baseline to
 * grow from, only two marks and the distance between them.
 */
function latencyChart(id: string, rows: RunRow[]): string {
  const values = rows.flatMap((r) => [r.p50, r.p99]).filter((v) => v > 0);
  if (values.length === 0) return "";

  const meta = META.get(id);
  const labels = rowLabels(rows);
  const plotX0 = labelWidth(labels) + 28;
  const min = decade(Math.min(...values), "floor");
  const max = Math.max(decade(Math.max(...values), "ceil"), min * 10);
  const x = logScale(min, max, plotX0, PLOT_X1);

  const head = header(
    meta ? `${meta.title} · ${id}` : id,
    meta
      ? `${meta.summary}. Response latency for each configuration, from the median (p50) to the slowest 1% of requests (p99).`
      : "Response latency for each configuration, from the median (p50) to the slowest 1% of requests (p99).",
  );
  const out = [head.svg];
  out.push(
    legend(16, head.y + 12, [
      ["p50", "s1"],
      ["p99", "s2"],
    ]),
  );
  out.push(text(CPU_X, head.y + 12, "cpu/req (ms)", { fill: "muted", size: 10, anchor: "end" }));

  const top = head.y + 24;
  const bottom = top + rows.length * ROW_H;

  for (let v = min; v <= max; v *= 10) {
    out.push(line(x(v), top - 4, x(v), bottom, "grid"));
    out.push(text(x(v), bottom + 15, tickLabel(v), { fill: "muted", size: 10, anchor: "middle" }));
  }
  out.push(line(plotX0, bottom, PLOT_X1, bottom, "axis"));
  out.push(text(plotX0, bottom + 31, "latency in ms · log scale", { fill: "muted", size: 10 }));

  rows.forEach((row, i) => {
    const y = top + i * ROW_H + ROW_H / 2;
    const label = labels[i] + (row.overloaded ? " ⚠" : "");
    const baseline = row.mode === "baseline";
    out.push(
      text(plotX0 - 12, y + 4, truncate(label, 11, plotX0 - 28), {
        fill: baseline ? "ink" : "ink2",
        size: 11,
        anchor: "end",
        weight: baseline ? 600 : undefined,
      }),
    );
    out.push(line(x(row.p50), y, x(row.p99), y, "grid", 2));
    out.push(dot(x(row.p50), y, "s1"));
    out.push(dot(x(row.p99), y, "s2"));

    const p99Text = ms(row.p99);
    out.push(text(x(row.p99) + 9, y + 4, p99Text, { fill: "ink2", size: 11 }));

    // p50 sits left of its own dot; against the axis floor it moves above the connector.
    const p50Text = ms(row.p50);
    const width = est(p50Text, 11);
    if (x(row.p50) - 9 - width >= plotX0 - 4) {
      out.push(text(x(row.p50) - 9, y + 4, p50Text, { fill: "ink2", size: 11, anchor: "end" }));
    } else if (x(row.p99) - x(row.p50) > width + 24) {
      out.push(text(x(row.p50) + 9, y - 3, p50Text, { fill: "ink2", size: 11 }));
    }

    out.push(
      text(CPU_X, y + 4, row.cpuPerRequestMs.toFixed(3), {
        fill: "ink2",
        size: 11,
        anchor: "end",
      }),
    );
  });

  return svgDoc(
    bottom + 46,
    `${id} latency`,
    `Median (p50) and slowest-1% (p99) response latency for every configuration of ${id} on a log scale, with main-thread CPU per request beside each row.`,
    out.join(""),
  );
}

function tickLabel(value: number): string {
  if (value >= 1) return String(value);
  return value.toFixed(Math.ceil(-Math.log10(value)));
}

// -- chart: origin-call reduction ------------------------------------------------------

/**
 * One bar per cached configuration, grouped by scenario.
 *
 * Magnitude against a fixed 0-100% domain, so one hue is the whole encoding; baseline rows
 * are excluded because their reduction is zero by construction.
 */
function originReduction(baseline: RunRow, cached: RunRow): number {
  return baseline.originCallsPerRequest === 0
    ? 0
    : Math.max(0, 1 - cached.originCallsPerRequest / baseline.originCallsPerRequest);
}

function offloadChart(rows: RunRow[]): string {
  const baselines = new Map(
    rows
      .filter((row) => row.mode === "baseline")
      .map((row) => [`${row.scenario}:${row.offeredRps}`, row]),
  );
  const cached = rows.filter(
    (row) => row.mode !== "baseline" && baselines.has(`${row.scenario}:${row.offeredRps}`),
  );
  if (cached.length === 0) return "";

  const groups = groupByScenario(cached).map(
    ([id, groupRows]) => [id, groupRows, rowLabels(groupRows)] as const,
  );
  const x0 = labelWidth(groups.flatMap(([, , labels]) => labels)) + 28;
  const x1 = 660;
  const head = header(
    "Origin-call reduction",
    "Reduction in origin invocations per admitted request against the matching no-cache row, including deduplication and background refreshes. This — not the speedup — maps to origin work. The no-cache rows are left out.",
  );
  const out = [head.svg];

  const top = head.y + 22;
  for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
    const x = x0 + tick * (x1 - x0);
    out.push(text(x, top - 8, `${tick * 100}%`, { fill: "muted", size: 10, anchor: "middle" }));
  }

  let y = top;
  const rules: string[] = [];
  for (const [id, groupRows, labels] of groups) {
    out.push(text(16, y + 11, id, { fill: "ink", size: 11, weight: 600 }));
    y += 18;
    for (const [i, row] of groupRows.entries()) {
      out.push(
        text(x0 - 12, y + 11, truncate(labels[i]!, 11, x0 - 28), {
          fill: "ink2",
          size: 11,
          anchor: "end",
        }),
      );
      const baseline = baselines.get(`${row.scenario}:${row.offeredRps}`)!;
      const reduction = originReduction(baseline, row);
      const w = reduction * (x1 - x0);
      out.push(bar(x0, y, w, 14, "s1"));
      out.push(text(x0 + w + 8, y + 11, pct(reduction), { fill: "ink2", size: 11 }));
      y += 20;
    }
    y += 8;
  }
  const bottom = y - 8;
  // The chart is tall, so the scale is repeated at the far end of it.
  for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
    const x = x0 + tick * (x1 - x0);
    rules.push(line(x, top - 4, x, bottom, tick === 0 ? "axis" : "grid"));
    out.push(text(x, bottom + 15, `${tick * 100}%`, { fill: "muted", size: 10, anchor: "middle" }));
  }
  out.push(text(x0, bottom + 31, "origin-call reduction", { fill: "muted", size: 10 }));

  return svgDoc(
    bottom + 44,
    "Origin-call reduction",
    "Reduction in origin invocations per admitted measured request for each scenario and storage backend.",
    out[0] + rules.join("") + out.slice(1).join(""),
  );
}

function groupByScenario(rows: RunRow[]): Array<[string, RunRow[]]> {
  const groups = new Map<string, RunRow[]>();
  for (const row of rows) {
    const list = groups.get(row.scenario);
    if (list) list.push(row);
    else groups.set(row.scenario, [row]);
  }
  return [...groups];
}

// -- chart: hit-path cost ---------------------------------------------------------------

/** What a hit adds per call, handler against function, by payload size. */
function hitCostChart(costs: HitCost[]): string {
  if (costs.length === 0) return "";
  const x0 = 96;
  const x1 = 660;
  const scale = ticks(Math.max(...costs.flatMap((c) => [c.handlerAddedUs, c.functionAddedUs])));
  const max = scale[scale.length - 1]!;

  const head = header(
    "Hit-path cost",
    "Extra microseconds a cache hit costs compared to calling the origin directly: hashing the key, validating and decoding the entry, and — for handlers — building a Response. Measured against in-memory storage with nothing else running.",
  );
  const out = [head.svg];
  out.push(
    legend(16, head.y + 12, [
      ["handler", "s1"],
      ["function", "s2"],
    ]),
  );

  const top = head.y + 24;
  const bottom = top + costs.length * 38;
  for (const tick of scale) {
    const x = x0 + (tick / max) * (x1 - x0);
    out.push(line(x, top - 4, x, bottom, tick === 0 ? "axis" : "grid"));
    out.push(text(x, bottom + 15, amount(tick), { fill: "muted", size: 10, anchor: "middle" }));
  }
  out.push(text(x0, bottom + 31, "microseconds added per hit", { fill: "muted", size: 10 }));

  costs.forEach((cost, i) => {
    const y = top + i * 38;
    out.push(
      text(x0 - 12, y + 22, kib(cost.payloadBytes), { fill: "ink2", size: 11, anchor: "end" }),
    );
    const series: Array<[number, Token]> = [
      [cost.handlerAddedUs, "s1"],
      [cost.functionAddedUs, "s2"],
    ];
    series.forEach(([value, token], j) => {
      const w = (Math.max(value, 0) / max) * (x1 - x0);
      const barY = y + 4 + j * 14;
      out.push(bar(x0, barY, w, 12, token));
      out.push(text(x0 + w + 8, barY + 10, `${value.toFixed(1)} us`, { fill: "ink2", size: 10 }));
    });
  });

  return svgDoc(
    bottom + 46,
    "Hit-path cost",
    "Extra microseconds a cache hit adds per call, cached handler versus cached function, across payload sizes.",
    out.join(""),
  );
}

// -- chart: sustained capacity ----------------------------------------------------------

/** Highest offered rate each configuration held within the p99 budget; ramp runs only. */
function sustainedChart(entries: BenchFile["sustained"]): string {
  if (entries.length === 0) return "";
  const x0 = labelWidth(entries.map((entry) => sustainedLabel(entry.config))) + 28;
  const x1 = 660;
  const scale = ticks(Math.max(...entries.map((e) => e.rps)));
  const max = scale[scale.length - 1]!;

  const head = header(
    "Sustained capacity",
    "The highest request rate each configuration handled while keeping p99 latency within budget and never falling behind arrivals. In a ramp run this — not the speedup — is the real capacity figure.",
  );
  const out = [head.svg];
  out.push(
    legend(16, head.y + 12, [
      ["no cache", "deemph"],
      ["with ocache", "s1"],
    ]),
  );

  const groups = new Map<string, BenchFile["sustained"]>();
  for (const entry of entries) {
    const list = groups.get(entry.scenario);
    if (list) list.push(entry);
    else groups.set(entry.scenario, [entry]);
  }

  const top = head.y + 36;
  let y = top;
  const marks: string[] = [];
  for (const [id, groupEntries] of groups) {
    marks.push(text(16, y + 11, id, { fill: "ink", size: 11, weight: 600 }));
    y += 18;
    for (const entry of groupEntries) {
      const label = sustainedLabel(entry.config);
      const isBaseline = entry.config === "baseline";
      marks.push(
        text(x0 - 12, y + 11, truncate(label, 11, x0 - 28), {
          fill: isBaseline ? "ink" : "ink2",
          size: 11,
          anchor: "end",
          weight: isBaseline ? 600 : undefined,
        }),
      );
      const w = (entry.rps / max) * (x1 - x0);
      marks.push(bar(x0, y, w, 14, isBaseline ? "deemph" : "s1"));
      marks.push(text(x0 + w + 8, y + 11, amount(entry.rps), { fill: "ink2", size: 11 }));
      y += 20;
    }
    y += 8;
  }
  const bottom = y - 8;

  for (const tick of scale) {
    const x = x0 + (tick / max) * (x1 - x0);
    out.push(line(x, top - 4, x, bottom, tick === 0 ? "axis" : "grid"));
    out.push(text(x, top - 10, amount(tick), { fill: "muted", size: 10, anchor: "middle" }));
    out.push(text(x, bottom + 15, amount(tick), { fill: "muted", size: 10, anchor: "middle" }));
  }
  out.push(...marks);
  out.push(text(x0, bottom + 31, "sustained rps", { fill: "muted", size: 10 }));

  return svgDoc(
    bottom + 44,
    "Sustained capacity",
    "The highest request rate each configuration handled while keeping p99 latency within budget.",
    out.join(""),
  );
}

// -- chart: combined summary ------------------------------------------------------------

const SUMMARY_ROW_H = 24;
const SUMMARY_X1 = 556;
/** Fixed columns to the right of the plot: speedup, then origin-call reduction. */
const SPEEDUP_X = 664;
const OFFLOAD_X0 = 676;
const OFFLOAD_W = 66;
const OFFLOAD_X = 788;

interface Pair {
  title: string;
  baseline: RunRow;
  cached: RunRow;
  speedup: number;
}

/**
 * One baseline and one cached row per scenario, at a rate both of them were offered.
 *
 * A ramp run repeats a scenario across offered rates, and the lowest one is the only rate
 * every configuration was asked to serve; pairing anything higher would put a cached row
 * against a baseline that was already behind. The cached side prefers `memory` so the row
 * shows what the cache costs rather than what a simulated backend costs — every other chart
 * carries the backend sweep.
 */
function pairScenarios(rows: RunRow[]): Pair[] {
  const pairs: Pair[] = [];
  for (const [id, group] of groupByScenario(rows)) {
    const baseline = group
      .filter((row) => row.mode === "baseline")
      .sort((a, b) => a.offeredRps - b.offeredRps)[0];
    if (!baseline) continue;
    const rest = group.filter(
      (row) => row.mode !== "baseline" && row.offeredRps === baseline.offeredRps,
    );
    const cached =
      rest.find((row) => row.mode === "cached" && row.profile === "memory") ??
      rest.find((row) => row.mode === "cached") ??
      rest[0];
    if (!cached || baseline.p99 <= 0 || cached.p99 <= 0) continue;
    pairs.push({
      title: META.get(id)?.title ?? id,
      baseline,
      cached,
      speedup: baseline.p99 / cached.p99,
    });
  }
  return pairs.sort((a, b) => b.speedup - a.speedup);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Multiplier at a stable width: a decimal below 100x, a separated integer above it. */
const times = (value: number) => `${value >= 100 ? amount(Math.round(value)) : value.toFixed(1)}x`;

/** Big number over a caption, spread across the full width. */
function statStrip(y: number, items: Array<[string, string]>): string {
  const out: string[] = [];
  const step = (WIDTH - 32) / items.length;
  items.forEach(([value, caption], i) => {
    const x = 16 + i * step;
    out.push(text(x, y, value, { fill: "ink", size: 21, weight: 600 }));
    out.push(text(x, y + 15, truncate(caption, 10, step - 14), { fill: "muted", size: 10 }));
  });
  return out.join("");
}

/**
 * The whole run in one compact figure, for a page with room for exactly one.
 *
 * Not a fourth view of the same data: it drops every configuration but one per scenario, so
 * the only comparison left is the one a reader who has never seen the harness can act on —
 * the same workload with ocache and without it. Rows are ranked by speedup instead of kept
 * in run order, because the spread across workloads is the point; the headline numbers are
 * medians, never the best row, and the last of them is what a hit costs.
 */
function combinedChart(data: BenchFile): string {
  const pairs = pairScenarios(data.rows);
  if (pairs.length === 0) return "";

  const x0 = Math.min(236, labelWidth(pairs.map((pair) => pair.title)) + 32);
  const values = pairs.flatMap((pair) => [pair.cached.p99, pair.baseline.p99]);
  const min = decade(Math.min(...values), "floor");
  const max = Math.max(decade(Math.max(...values), "ceil"), min * 10);
  const x = logScale(min, max, x0, SUMMARY_X1);

  const profiles = [...new Set(pairs.map((pair) => pair.cached.profile))].join(", ");
  const head = header(
    "ocache under load",
    `${pairs.length} workload${pairs.length === 1 ? "" : "s"}, each run twice at the same offered rate: once through ocache on ${profiles} storage, once with no cache in the path. Both runs use the same seed, so the only difference between the two marks on a row is the cache.`,
  );

  const strip: Array<[string, string]> = [
    [times(median(pairs.map((pair) => pair.speedup))), "median p99 latency improvement"],
    [
      `${Math.round(
        median(pairs.map((pair) => originReduction(pair.baseline, pair.cached))) * 100,
      )}%`,
      "median origin-call reduction",
    ],
  ];
  // A share, not a multiplier: two of these numbers are percentages already, and a
  // multiplier next to them would read as "2.2x the CPU".
  const cpu = pairs
    .filter((pair) => pair.baseline.cpuPerRequestMs > 0)
    .map((pair) => pair.cached.cpuPerRequestMs / pair.baseline.cpuPerRequestMs);
  if (cpu.length > 0) {
    strip.push([`-${Math.round((1 - median(cpu)) * 100)}%`, "median CPU per request"]);
  }
  const added = (data.hitCosts ?? [])
    .map((cost) => cost.handlerAddedUs)
    .filter((value) => value > 0);
  if (added.length > 0) {
    strip.push([`+${median(added).toFixed(0)} µs`, "median cost of one cache hit"]);
  }

  const out = [head.svg];
  const stripY = head.y + 28;
  out.push(statStrip(stripY, strip));

  const top = stripY + 42;
  const bottom = top + pairs.length * SUMMARY_ROW_H;

  out.push(
    legend(16, top - 10, [
      ["no cache", "deemph"],
      ["with ocache", "s1"],
    ]),
  );
  out.push(text(SPEEDUP_X, top - 10, "faster", { fill: "muted", size: 10, anchor: "end" }));
  out.push(
    text(OFFLOAD_X, top - 10, "origin-call reduction", { fill: "muted", size: 10, anchor: "end" }),
  );

  for (let v = min; v <= max; v *= 10) {
    out.push(line(x(v), top - 4, x(v), bottom, "grid"));
    out.push(
      text(x(v), bottom + 15, v >= 1 ? amount(v) : tickLabel(v), {
        fill: "muted",
        size: 10,
        anchor: "middle",
      }),
    );
  }
  out.push(line(x0, bottom, SUMMARY_X1, bottom, "axis"));

  pairs.forEach((pair, i) => {
    const y = top + i * SUMMARY_ROW_H + SUMMARY_ROW_H / 2;
    out.push(
      text(x0 - 12, y + 4, truncate(pair.title, 11, x0 - 28), {
        fill: "ink2",
        size: 11,
        anchor: "end",
      }),
    );
    out.push(line(x(pair.cached.p99), y, x(pair.baseline.p99), y, "grid", 2));
    out.push(dot(x(pair.baseline.p99), y, "deemph", 4));
    out.push(dot(x(pair.cached.p99), y, "s1", 4));

    // The cached mark is the smaller value, so its label goes into the empty side.
    const cached = ms(pair.cached.p99);
    if (x(pair.cached.p99) - 8 - est(cached, 10) >= x0 - 4) {
      out.push(
        text(x(pair.cached.p99) - 8, y + 3.5, cached, { fill: "ink2", size: 10, anchor: "end" }),
      );
    }
    out.push(
      text(x(pair.baseline.p99) + 8, y + 3.5, ms(pair.baseline.p99), { fill: "ink2", size: 10 }),
    );

    out.push(
      text(SPEEDUP_X, y + 4, times(pair.speedup), {
        fill: "ink",
        size: 11,
        weight: 600,
        anchor: "end",
      }),
    );
    // The domain is fixed at 0-100%, so the gap is meaningful too.
    const reduction = originReduction(pair.baseline, pair.cached);
    out.push(bar(OFFLOAD_X0, y - 5, OFFLOAD_W, 10, "grid"));
    out.push(bar(OFFLOAD_X0, y - 5, OFFLOAD_W * reduction, 10, "s2"));
    out.push(
      text(OFFLOAD_X, y + 4, `${Math.round(reduction * 100)}%`, {
        fill: "ink2",
        size: 11,
        anchor: "end",
      }),
    );
  });

  out.push(text(x0, bottom + 31, "p99 latency in ms · log scale", { fill: "muted", size: 10 }));
  out.push(
    text(OFFLOAD_X, bottom + 31, `Node ${data.node} · seed ${data.seed} · ${data.load} load`, {
      fill: "muted",
      size: 10,
      anchor: "end",
    }),
  );

  return svgDoc(
    bottom + 44,
    "ocache under load",
    `p99 latency with and without ocache for ${pairs.length} workloads, origin-call reduction against each no-cache baseline, and the medians across all of them.`,
    out.join(""),
  );
}

// -- output -----------------------------------------------------------------------------

const { input, outDir, landing } = parseArgs(process.argv.slice(2));
if (!input) {
  console.error(
    "usage: node bench/chart.ts <input.json> [--out=dir] [--landing=file|--no-landing]",
  );
  process.exit(1);
}

const data = JSON.parse(readFileSync(input, "utf8")) as BenchFile;
for (const row of data.rows ?? []) {
  if (!Number.isFinite(row.originCallsPerRequest)) {
    row.originCallsPerRequest = row.completed === 0 ? 0 : row.originCalls / row.completed;
  }
}
if (!Array.isArray(data.rows) || data.rows.length === 0) {
  console.error(`${input} has no rows`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

interface Emitted {
  name: string;
  caption: string;
  alt: string;
}
const emitted: Emitted[] = [];

/** Writes one chart and records it for `index.md`; an empty render means it had no data. */
function emit(name: string, caption: string, alt: string, render: () => string): void {
  const svg = render();
  if (svg === "") return;
  writeFileSync(join(outDir, `${name}.svg`), svg);
  emitted.push({ name, caption, alt });
}

const combined = combinedChart(data);

emit(
  "combined",
  "The whole run in one figure: p99 latency with and without ocache, origin-call reduction, and medians across every workload.",
  "ocache under load: p99 latency with and without cache, and origin-call reduction, per workload",
  () => combined,
);

emit(
  "origin-call-reduction",
  "Reduction in origin invocations per admitted measured request, for each scenario and storage backend.",
  "Origin-call reduction per scenario and storage backend",
  () => offloadChart(data.rows),
);

emit(
  "sustained",
  "The highest request rate each configuration handled while keeping p99 latency within budget.",
  "Sustained requests per second for each scenario and configuration",
  () => sustainedChart(data.sustained ?? []),
);

for (const [id, rows] of groupByScenario(data.rows)) {
  emit(
    `latency-${id}`,
    `\`${id}\` — p50 to p99 latency for every configuration on a log axis, with main-thread CPU per request beside each row.`,
    `${id}: p50 and p99 latency for every configuration`,
    () => latencyChart(id, rows),
  );
}

emit(
  "hit-cost",
  "Extra microseconds a cache hit adds per call, cached handler versus cached function, across payload sizes.",
  "Extra microseconds per cache hit by payload size",
  () => hitCostChart(data.hitCosts ?? []),
);

// The landing copy is the same file under the name the site links to, so a page can embed
// it without knowing which run produced it.
if (landing) {
  if (combined === "")
    console.error(`no scenario has both a baseline and a cached row: skipping ${landing}`);
  else {
    mkdirSync(dirname(landing), { recursive: true });
    writeFileSync(landing, combined);
    console.error(`wrote ${landing}`);
  }
}

const index = [
  "# ocache benchmark charts",
  "",
  `Rendered from \`${basename(input)}\` — Node ${data.node} · seed ${data.seed} · load \`${data.load}\`.`,
  "Each chart is a single file that carries both light and dark palettes and follows the",
  "reader's colour scheme; the full numbers behind them are in the markdown report from the",
  "same run.",
  "",
  "Viewed as an image, a chart follows the operating system's `prefers-color-scheme`, which is",
  "not the same setting as a site's own light/dark toggle. Inlined into a page, it follows a",
  "`data-theme` or `dark` class on any ancestor instead.",
  "",
];
for (const chart of emitted) {
  index.push(
    `<img alt="${chart.alt}" src="${chart.name}.svg" width="${WIDTH}">`,
    "",
    chart.caption,
    "",
  );
}
writeFileSync(join(outDir, "index.md"), index.join("\n"));

console.error(`wrote ${emitted.length} svg files and index.md to ${outDir}`);

function parseArgs(argv: string[]): { input?: string; outDir: string; landing?: string } {
  let input: string | undefined;
  let outDir = "bench/charts";
  // The docs site links this path, so it is a default rather than a flag to remember.
  let landing: string | undefined = "docs/.docs/public/bench.svg";
  for (const arg of argv) {
    if (arg.startsWith("--out=")) outDir = arg.slice("--out=".length);
    else if (arg === "--no-landing") landing = undefined;
    else if (arg.startsWith("--landing=")) landing = arg.slice("--landing=".length) || undefined;
    else if (!arg.startsWith("--")) input ??= arg;
  }
  return { input, outDir, landing };
}
