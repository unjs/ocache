/**
 * Bundle-size probe.
 *
 * Builds a *minimal but realistic* consumer of ocache — a `fetch(Request) => Response`
 * entry backed by `defineCachedHandler` — with rolldown, then reports and asserts the
 * shipped size (raw / minified / minified+gzip). Once per target platform: what a worker
 * consumer downloads and what a server consumer does differ by the `#crypto` arm they resolve.
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
// left it at 99% used, which is a tripwire on the next JSDoc paragraph, not a ceiling.
//
// 50_000 ran out on `maxResolveTime` (finding 03), and only just: the baseline was already
// 49_867 raw / 20_162 min / 8_077 gzip — 100% of `raw` before this change existed — and the
// deadline adds ~700 raw / ~330 min / ~135 gzip on top, for 50_563 / 20_495 / 8_212. All of
// that is *code*: rolldown strips `//` comments and erases type-only JSDoc, so there is no
// prose to trim it out of, and buying `raw` back out of the comments that document the
// decisions is the wrong thing to spend first. `min`/`minGzip` still fit their unchanged
// ceilings (98% / 97%), which is the pair that describes what a consumer downloads.
//
// Dropping `ohash` for `src/hash.ts` then bought back far more than it spent — 16_278 min /
// 6_261 gzip, i.e. -4.2 kB min and -2.0 kB gzip, since ocache asks for a fraction of what ohash
// serializes. The portable sha256 that followed (for runtimes with no `node:crypto`) spent ~1.8
// kB min / ~1.1 kB gzip of that back — but only for consumers who actually need it, which is
// what the `#crypto` conditional import buys and what the two rows below measure.
//
// The ceilings then went unbumped through 43 commits of feature work (the body-size limit, the
// 304 validator echo, the resolution deadline, native binary storage), and by the time the core
// binary codec landed the neutral bundle sat at 125% of `min` and 122% of `minGzip`. A ceiling
// nothing can pass says nothing about the next change, so both rows are re-based here on the
// measured numbers — neutral 58_338 / 23_788 / 9_503, node 54_162 / 21_539 / 8_115 — with ~5%
// of headroom: one small feature's worth of `min`, a few JSDoc paragraphs' worth of `raw`.
//
// The codec itself is ~1.8 kB raw, ~590 B min, ~185 B gzip of that. The consumer measured below
// is a *handler*, which already pulled `src/base64.ts` in through `http/entry.ts`, so that delta
// is the codec alone; a function-only consumer now reaches the same three encoders through
// `cache.ts` and `hash.ts` and pays for them once.
//
// Both platforms are built, because the whole point of resolving the digest through a condition
// is that the two answers differ, and a regression that inlined the portable sha256 everywhere
// would be invisible in a single row. The gap between them *is* `lib/digest.mjs`.
const PLATFORMS = {
  // A worker/browser consumer: `#crypto` resolves to `lib/digest.mjs` and it is inlined.
  neutral: "web-standard target — no node builtins, no polyfills; portable sha256 inlined",
  // A server consumer: the `node` condition sends `#crypto` to `node:crypto`, which stays
  // external, so the portable sha256 never enters the graph at all.
  node: "node target — `#crypto` resolves to the external `node:crypto`",
} as const;

type Platform = keyof typeof PLATFORMS;
type SizeName = "raw" | "min" | "minGzip";

// Re-based again at `composeStorage`, on 61_292 / 24_721 / 9_799 neutral and 57_116 / 22_470 /
// 8_406 node. The measurement is unchanged by that feature — a layered stack is a backend a
// handler-only consumer never names, so it tree-shakes out whole and both platforms measured
// byte-identical with and without it — the ceilings had simply been reached again: `raw` was
// already 0.3 kB over on both platforms and every other row sat at 98-100%. Same ~5% headroom
// as the last re-base, on all six rows rather than only the two that were failing, so the next
// change measures against a tripwire instead of tripping on arrival.
//
// Re-based again at opt-in response streaming, measured against the numbers above: +4.88 kB
// raw, +1.49 kB min, +0.45 kB gzip on both platforms (61_288 / 24_721 / 9_799 neutral and
// 57_112 / 22_470 / 8_406 node became 66_172 / 26_212 / 10_261 and 61_996 / 23_962 / 8_858).
// That is the one row of this table a consumer cannot opt out of: `stream.ts` and the
// streaming arm of `http/entry.ts` are reached through a runtime flag, so they stay in the
// graph of a handler that never sets `stream`. `raw` carries the rest — the option's JSDoc and
// the comments on the fill/serve split. Same ~5% headroom on all six rows.
const BUDGETS: Record<Platform, Record<SizeName, number>> = {
  neutral: { raw: 69_500, min: 27_500, minGzip: 10_800 },
  node: { raw: 65_000, min: 25_200, minGzip: 9300 },
};

// Absolute so the generated entry can live anywhere and still resolve ocache from source.
const OCACHE_SRC = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The consumer under test: a single fetchable handler, nothing else.
 *
 * Deliberately narrow — it touches `defineCachedHandler` only, so whatever `cache.ts`,
 * `storage.ts` or `hash.ts` code shows up in the output is code a real HTTP consumer
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

  const failures: string[] = [];
  for (const platform of Object.keys(BUDGETS) as Platform[]) {
    const sizes = await build(entry, outDir, platform);
    report(platform, sizes, outDir);
    await verify(outDir, platform);

    for (const [name, size] of Object.entries(sizes)) {
      const budget = BUDGETS[platform][name as SizeName];
      if (size > budget) {
        failures.push(
          `${platform} ${name} bundle is ${fmt(size)}, over its ${fmt(budget)} budget (+${fmt(size - budget)})`,
        );
      }
    }
  }
  console.log(`\nbundles written to: ${outDir}`);
  // Both platforms are reported before anything throws: one over budget is usually a change both
  // are carrying, and seeing the pair is what tells you whether it landed in shared code or in
  // one arm of `#crypto`.
  assert(failures.length === 0, failures.join("\n"));
}

/** Builds one platform variant and returns its three sizes. */
async function build(
  entry: string,
  outDir: string,
  platform: Platform,
): Promise<Record<SizeName, number>> {
  const bundle = await rolldown({
    input: entry,
    cwd: REPO_ROOT, // resolve from the repo, not the temp dir (ocache has no runtime deps of its own)
    platform,
    treeshake: true,
  });

  // One bundle, two writes: `minify` is an *output* option, so both artifacts come from
  // the same module graph and the raw/min pair is guaranteed comparable.
  const [raw, min] = await Promise.all([
    write(bundle, outDir, `bundle.${platform}.mjs`, false),
    write(bundle, outDir, `bundle.${platform}.min.mjs`, true),
  ]);
  await bundle.close();

  const minGzip = gzipSync(min, { level: zlibConstants.Z_BEST_COMPRESSION });
  await writeFile(join(outDir, `bundle.${platform}.min.mjs.gz`), minGzip);

  return { raw: raw.length, min: min.length, minGzip: minGzip.length };
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
async function verify(dir: string, platform: Platform): Promise<void> {
  const { fetch } = (await import(join(dir, `bundle.${platform}.mjs`))) as {
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

function report(platform: Platform, sizes: Record<SizeName, number>, dir: string): void {
  console.log(`\n${platform}: ${PLATFORMS[platform]}`);
  console.table(
    Object.fromEntries(
      Object.entries(sizes).map(([name, size]) => {
        const budget = BUDGETS[platform][name as SizeName];
        return [
          name,
          { bytes: size, size: fmt(size), budget: fmt(budget), used: pct(size, budget) },
        ];
      }),
    ),
  );
  console.log(`  unminified (for auditing): ${join(dir, `bundle.${platform}.mjs`)}`);
}

function fmt(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} kB`;
}

function pct(size: number, budget: number): string {
  return `${Math.round((size / budget) * 100)}%`;
}

await main();
