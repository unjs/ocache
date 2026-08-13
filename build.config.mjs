import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  // `src/crypto.ts` is a second entry, not a chunk of the first: `#crypto` (see `imports` in
  // `package.json`) must stay an unresolved specifier in `dist/index.mjs` so the *consumer's*
  // resolver picks the branch — `node` → native `node:crypto` via `ohash/crypto`, anything
  // else → `dist/crypto.mjs`. Letting the build resolve it would bake this machine's answer
  // (always `node`) into the published bundle and ship `node:crypto` to every edge consumer.
  entries: [
    { type: "bundle", input: "./src/index.ts", rolldown: { external: [/^#/] } },
    { type: "bundle", input: "./src/crypto.ts" },
  ],
});
