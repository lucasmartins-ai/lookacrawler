import { extractFast } from "./extractor.js";

/**
 * Real-page token benchmark: raw HTML vs LookaCrawler fast-mode Markdown.
 * Run: LOOKACRAWLER_DB_PATH=:memory: bun benchmark-live.ts [url ...]
 * Tokens are estimated as chars/4 for both sides. Measures size only, not
 * content fidelity — spot-check the Markdown before quoting a number.
 */
const URLS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "https://en.wikipedia.org/wiki/Web_crawler",
      "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching",
      "https://bun.sh/docs/test/writing",
      "https://github.com/modelcontextprotocol/typescript-sdk",
      "https://news.ycombinator.com/",
      "https://www.bbc.com/news",
      "https://react.dev/learn",
      "https://docs.python.org/3/tutorial/classes.html",
    ];

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const savings: number[] = [];

for (const url of URLS) {
  try {
    const raw = await (await fetch(url, { headers: { "User-Agent": UA } })).text();
    const md = await extractFast({ url, maxRetries: 1 });
    // An empty result is an extraction failure, not 100% savings.
    if (md.trim().length < 200) throw new Error(`near-empty output (${md.trim().length} chars)`);
    const pct = (1 - md.length / raw.length) * 100;
    savings.push(pct);
    console.log(`${pct.toFixed(1).padStart(5)}%  ${Math.ceil(raw.length / 4)} → ${Math.ceil(md.length / 4)} tokens  ${url}`);
  } catch (err: any) {
    console.log(`  FAIL  ${url}: ${err.message}`);
  }
}

const sorted = [...savings].sort((a, b) => a - b);
const mid = Math.floor(sorted.length / 2);
const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
console.log(`\n${savings.length}/${URLS.length} pages · min ${sorted[0]?.toFixed(1)}% · median ${median.toFixed(1)}% · max ${sorted.at(-1)?.toFixed(1)}%`);
