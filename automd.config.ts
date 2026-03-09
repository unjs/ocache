import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineGenerator, type Config } from "automd";
import { loadJSDocs, renderJSDocsMarkdown } from "docs4ts";

export default <Config>{
  generators: {
    docs4ts: defineGenerator({
      name: "docs4ts",
      async generate({ args, config }) {
        const src = args.src || "./src/index";
        const entry = resolveEntry(resolve(config.dir, src));
        const entries = await loadJSDocs(entry);
        const contents = renderJSDocsMarkdown(entries);
        return { contents };
      },
    }),
  },
};

function resolveEntry(path: string): string {
  if (existsSync(path)) return path;
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"]) {
    if (existsSync(path + ext)) return path + ext;
  }
  return path;
}
