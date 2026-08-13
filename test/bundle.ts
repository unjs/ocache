/**
 * Bundle-size probe.
 *
 * Builds a *minimal but realistic* consumer of ocache — a `fetch(Request) => Response`
 * entry backed by `defineCachedHandler` — with rolldown, then reports and asserts the
 * shipped size (raw / minified / minified+gzip).
 *
 * Built **twice**, because ocache does not ship one size. `#crypto` (the `imports` map in
 * `package.json`) resolves to native `node:crypto` under the `node` condition and to the
 * compact `src/crypto.ts` otherwise, so a Node consumer ships no SHA-256 at all while an
 * edge/worker/browser one ships ~1.1 kB gzip of it. Measuring only `neutral` would let a
 * change that quietly drags `node:crypto` out of a Node bundle (or bakes it into an edge
 * one) pass unnoticed — which is exactly the failure mode this wiring exists to avoid, so
 * both platforms carry budgets and the probe asserts which one uses the native digest.
 *
 * The bundle is written to a fresh temp dir (path printed at the end) rather than into
 * the repo: the unminified output is meant to be handed to auditor agents ("what actually
 * survives tree-shaking into a consumer's bundle?"), which wants a readable file on disk,
 * not a build artifact under version control.
 *
 * Run: `pnpm bundle` (or `node test/bundle.ts`). The temp dir is never auto-removed; set
 * `OUT=<dir>` to build into a specific directory instead.
 */

import assert from "node:assert";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, constants as zlibConstants } from "node:zlib";

import { rolldown } from "rolldown";

// --- Size budgets (bytes), per platform ---
//
// Ceilings, not targets: they exist to catch an accidental blow-up (a fat dependency, a
// tree-shaking regression), so they sit comfortably above the current numbers. Tighten
// them when a deliberate size win lands.
//
// `raw` keeps every JSDoc block (rolldown drops `//` line comments but not `/** */`), so it
// is part size and part prose budget — this codebase documents its decisions in-place, and a
// documented internal helper costs `raw` far more than it costs a consumer (the response-side
// `Cache-Control` opt-out fix: ~7 kB raw for ~1.1 kB min / ~0.4 kB gzip, most of it the RFC
// rationale on the new `Cache-Control`/`Vary` predicates). The numbers that describe what is
// actually downloaded are `min`/`minGzip`; keep those tight and let `raw` follow — 48_000
// left it at 99% used, which is a tripwire on the next JSDoc paragraph, not a ceiling.
//
// All six sit at 95-97% of budget after the compact digest landed (finding 18.2), which is
// the intended shape: enough room for a paragraph of rationale, not enough for a dependency.
// `node` sits ~1 kB gzip under `neutral` for exactly one reason and it should stay that way:
// it ships no SHA-256. Its `raw` budget is the *tighter* of the two — same code, less of it.
const BUDGETS = {
  neutral: { raw: 50_000, min: 19_500, minGzip: 7800 },
  node: { raw: 47_500, min: 18_000, minGzip: 6800 },
} as const;

type Sizes = { raw: number; min: number; minGzip: number };

/**
 * The two resolutions ocache ships under.
 *
 * `neutral` needs `ocache-source` because `#crypto`'s non-Node branch points at
 * `./dist/crypto.mjs` — the published artifact — and this probe deliberately builds from
 * `src`. The condition is repo-private (no bundler enables it on its own) and exists purely
 * so the probe can measure the same code the published branch contains without a build step.
 */
const PLATFORMS = [
  { name: "neutral", platform: "neutral", conditions: ["ocache-source"], native: false },
  { name: "node", platform: "node", conditions: [], native: true },
] as const;

// Absolute so the generated entry can live anywhere and still resolve ocache from source.
const OCACHE_SRC = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The consumer under test: a single fetchable handler, nothing else.
 *
 * Deliberately narrow — it touches `defineCachedHandler` only, so whatever `cache.ts`,
 * `storage.ts` or `ohash` code shows up in the output is code a real HTTP consumer
 * genuinely pulls in, not code the fixture asked for.
 */
const ENTRY_SOURCE = /* ts */ `
import { defineCachedHandler } from ${JSON.stringify(OCACHE_SRC)};

const handler = defineCachedHandler(
  (event) => new Response(\`hello \${event.url?.pathname}\`, {
    headers: { "content-type": "text/plain" },
  }),
  { maxAge: 60, swr: true, staleMaxAge: 600 },
);

export function fetch(req: Request): Promise<Response> {
  return handler({ req, url: new URL(req.url) }) as Promise<Response>;
}
`;

async function main(): Promise<void> {
  const outDir = process.env.OUT || (await mkdtemp(join(tmpdir(), "ocache-bundle-")));

  const measured: { name: keyof typeof BUDGETS; sizes: Sizes }[] = [];

  for (const target of PLATFORMS) {
    const dir = join(outDir, target.name);
    await mkdir(dir, { recursive: true });

    const entry = join(dir, "entry.ts");
    await writeFile(entry, ENTRY_SOURCE);

    const bundle = await rolldown({
      input: entry,
      cwd: REPO_ROOT, // so `ohash` resolves from the repo's node_modules
      platform: target.platform, // "neutral" = web-standard: no node builtins, no polyfills
      resolve: target.conditions.length > 0 ? { conditionNames: [...target.conditions] } : {},
      treeshake: true,
    });

    // One bundle, two writes: `minify` is an *output* option, so both artifacts come from
    // the same module graph and the raw/min pair is guaranteed comparable.
    const [raw, min] = await Promise.all([
      write(bundle, dir, "bundle.mjs", false),
      write(bundle, dir, "bundle.min.mjs", true),
    ]);
    await bundle.close();

    const minGzip = gzipSync(min, { level: zlibConstants.Z_BEST_COMPRESSION });
    await writeFile(join(dir, "bundle.min.mjs.gz"), minGzip);

    const sizes: Sizes = { raw: raw.length, min: min.length, minGzip: minGzip.length };

    // The whole point of the `#crypto` condition: exactly one of these bundles reaches for
    // the platform's own SHA-256. Asserted, not merely reported, because the two failure
    // directions are equally bad — a Node consumer re-shipping the JS digest it never needed,
    // or an edge bundle carrying a `node:crypto` import it cannot resolve.
    // Checked against the *minified* output: `raw` keeps comments, and the source prose
    // about this very mechanism mentions `node:crypto` by name.
    const native = min.includes("node:crypto");
    assert.equal(
      native,
      target.native,
      `${target.name} bundle ${native ? "uses" : "does not use"} node:crypto; expected the opposite`,
    );

    await verify(dir);
    measured.push({ name: target.name, sizes });
  }

  // Report before asserting: a blown budget is most useful alongside the numbers it blew.
  report(measured, outDir);

  for (const { name, sizes } of measured) {
    for (const [metric, size] of Object.entries(sizes)) {
      const budget = BUDGETS[name][metric as keyof Sizes];
      assert(
        size <= budget,
        `${name}/${metric} bundle is ${fmt(size)}, over its ${fmt(budget)} budget (+${fmt(size - budget)})`,
      );
    }
  }
}

/** Writes one output variant and returns its bytes. */
async function write(
  bundle: Awaited<ReturnType<typeof rolldown>>,
  dir: string,
  file: string,
  minify: boolean,
): Promise<Buffer> {
  await bundle.write({ dir, entryFileNames: file, format: "esm", minify });
  return readFile(join(dir, file));
}

/**
 * Smoke test: import the unminified bundle and drive it as a real fetch handler, so a
 * size number can never be reported for a bundle that does not actually work (e.g. one
 * tree-shaken past the point of correctness).
 */
async function verify(dir: string): Promise<void> {
  const { fetch } = (await import(join(dir, "bundle.mjs"))) as {
    fetch: (req: Request) => Promise<Response>;
  };

  const miss = await fetch(new Request("http://localhost/hello"));
  assert.equal(miss.status, 200);
  assert.equal(await miss.text(), "hello /hello");

  const hit = await fetch(new Request("http://localhost/hello"));
  assert.equal(await hit.text(), "hello /hello");
  assert.equal(hit.headers.get("x-cache"), "HIT");
  assert.ok(hit.headers.get("etag"), "expected the cached response to carry an etag");
}

function report(measured: { name: keyof typeof BUDGETS; sizes: Sizes }[], dir: string): void {
  console.table(
    Object.fromEntries(
      measured.flatMap(({ name, sizes }) =>
        Object.entries(sizes).map(([metric, size]) => {
          const budget = BUDGETS[name][metric as keyof Sizes];
          return [
            `${name}/${metric}`,
            { bytes: size, size: fmt(size), budget: fmt(budget), used: pct(size, budget) },
          ];
        }),
      ),
    ),
  );
  console.log(`\nbundles written to: ${dir}`);
  for (const { name } of measured) {
    console.log(`  unminified (for auditing): ${join(dir, name, "bundle.mjs")}`);
  }
}

function fmt(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} kB`;
}

function pct(size: number, budget: number): string {
  return `${Math.round((size / budget) * 100)}%`;
}

await main();
