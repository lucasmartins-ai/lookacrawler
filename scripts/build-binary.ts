/**
 * Single-file binary: `bun scripts/build-binary.ts <bun-target> [outfile]`,
 * e.g. bun-darwin-arm64 or bun-linux-x64. Playwright stays external (deep mode
 * loads it on first use and says how to install it when it is missing).
 */
import { join } from "node:path";

const target = process.argv[2] || "bun-darwin-arm64";
const outfile = process.argv[3] || join("dist", `lookacrawler-${target.replace(/^bun-/, "")}`);

// css-tree (via jsdom's cssstyle) loads its data with createRequire("../data/*.json")
// at runtime, which the compiled binary cannot resolve. Its dist build inlines that data.
const cssTreeDist: import("bun").BunPlugin = {
  name: "css-tree-dist",
  setup(build) {
    build.onResolve({ filter: /^css-tree$/ }, () => ({ path: require.resolve("css-tree/dist/csstree.esm.js") }));
  },
};

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "cli.ts")],
  compile: { target: target as any, outfile },
  external: ["playwright", "playwright-core"],
  plugins: [cssTreeDist],
  // minify: --version 0.19 s / 85 MB -> 0.14 s / 70 MB. bytecode: true breaks extract
  // ("Expected CommonJS module to have a function wrapper"), so it stays off.
  minify: true,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${outfile}`);
