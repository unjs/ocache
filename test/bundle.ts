/**
 * Bundle-size probe.
 *
 * Builds a *minimal but realistic* consumer of ocache — a `fetch(Request) => Response`
 * entry backed by `defineCachedHandler` — with rolldown, then reports and asserts the
 * shipped size (raw / minified / minified+gzip).
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

// --- Size budgets (bytes) ---
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
// left it at 99% used, which is a tripwire on the next JSDoc paragraph, not a ceiling, and
// 50_000 was back at 99% by the time `resolverTimeout` (finding 03) added ~670 bytes of raw
// code for ~330 min / ~140 gzip. Raised rather than trimmed: `min`/`minGzip` both still have
// room, and the alternative was to buy `raw` back out of the prose that documents the
// decisions — which is the wrong thing to spend first.
const BUDGETS = {
  raw: 52_000,
  min: 21_000,
  minGzip: 8500,
} as const;

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
  await mkdir(outDir, { recursive: true });

  const entry = join(outDir, "entry.ts");
  await writeFile(entry, ENTRY_SOURCE);

  const bundle = await rolldown({
    input: entry,
    cwd: REPO_ROOT, // so `ohash` resolves from the repo's node_modules
    platform: "neutral", // web-standard target: no node builtins, no polyfills
    treeshake: true,
  });

  // One bundle, two writes: `minify` is an *output* option, so both artifacts come from
  // the same module graph and the raw/min pair is guaranteed comparable.
  const [raw, min] = await Promise.all([
    write(bundle, outDir, "bundle.mjs", false),
    write(bundle, outDir, "bundle.min.mjs", true),
  ]);
  await bundle.close();

  const minGzip = gzipSync(min, { level: zlibConstants.Z_BEST_COMPRESSION });
  await writeFile(join(outDir, "bundle.min.mjs.gz"), minGzip);

  const sizes = { raw: raw.length, min: min.length, minGzip: minGzip.length };

  report(sizes, outDir);
  await verify(outDir);

  for (const [name, size] of Object.entries(sizes)) {
    const budget = BUDGETS[name as keyof typeof BUDGETS];
    assert(
      size <= budget,
      `${name} bundle is ${fmt(size)}, over its ${fmt(budget)} budget (+${fmt(size - budget)})`,
    );
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

function report(sizes: Record<keyof typeof BUDGETS, number>, dir: string): void {
  console.table(
    Object.fromEntries(
      Object.entries(sizes).map(([name, size]) => {
        const budget = BUDGETS[name as keyof typeof BUDGETS];
        return [
          name,
          { bytes: size, size: fmt(size), budget: fmt(budget), used: pct(size, budget) },
        ];
      }),
    ),
  );
  console.log(`\nbundle written to: ${dir}`);
  console.log(`  unminified (for auditing): ${join(dir, "bundle.mjs")}`);
}

function fmt(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} kB`;
}

function pct(size: number, budget: number): string {
  return `${Math.round((size / budget) * 100)}%`;
}

await main();
