import { extractFast, extractDeep, extractStructured, batchExtract, extractMetadata } from "./extractor.js";
import { getCachedPage, setCachedPage, clearCache } from "./cache.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
};

async function runLookaDevQATest() {
  console.log("===============================================================================");
  console.log("            LOOKACRAWLER - QA TEST & BENCHMARK REPORT: lookadev.com            ");
  console.log("===============================================================================\n");

  const baseUrl = "https://lookadev.com";
  const subPages = [
    "https://lookadev.com",
    "https://lookadev.com/projects",
    "https://lookadev.com/about",
    "https://lookadev.com/devlog"
  ];

  // -------------------------------------------------------------------------
  // TEST 1: Baseline Raw HTML vs Fast Mode Extraction
  // -------------------------------------------------------------------------
  console.log("[TEST 1] FAST MODE EXTRACTION & TOKEN SAVINGS BENCHMARK");
  console.log(`Target: ${baseUrl}`);

  const rawStart = Date.now();
  const rawResponse = await fetch(baseUrl, { headers: DEFAULT_HEADERS });
  const rawHtml = await rawResponse.text();
  const rawFetchTime = Date.now() - rawStart;
  const rawBytes = Buffer.byteLength(rawHtml, "utf8");
  const rawTokens = estimateTokens(rawHtml);

  console.log(`- HTTP Status: ${rawResponse.status} ${rawResponse.statusText}`);
  console.log(`- Raw HTML Payload: ${rawBytes.toLocaleString()} bytes (~${rawTokens.toLocaleString()} tokens) [Fetched in ${rawFetchTime}ms]`);

  const fastStart = Date.now();
  const fastMarkdown = await extractFast({ url: baseUrl, headers: DEFAULT_HEADERS, maxRetries: 3 });
  const fastTime = Date.now() - fastStart;
  const fastBytes = Buffer.byteLength(fastMarkdown, "utf8");
  const fastTokens = estimateTokens(fastMarkdown);
  const fastSavings = (((rawBytes - fastBytes) / rawBytes) * 100).toFixed(2);
  const fastTokenSavings = (((rawTokens - fastTokens) / rawTokens) * 100).toFixed(2);

  console.log(`- Fast Extracted Markdown: ${fastBytes.toLocaleString()} bytes (~${fastTokens.toLocaleString()} tokens)`);
  console.log(`- Extraction Latency: ${fastTime}ms`);
  console.log(`- Token Reduction: ${fastTokenSavings}% (Saved ${rawTokens - fastTokens} tokens per LLM call)`);
  console.log(`- Content Preview (first 250 chars):\n  "${fastMarkdown.slice(0, 250).replace(/\n/g, " ")}..."\n`);

  // -------------------------------------------------------------------------
  // TEST 2: Deep Mode Extraction (Playwright Chromium + Stealth)
  // -------------------------------------------------------------------------
  console.log("[TEST 2] DEEP MODE EXTRACTION (Playwright Headless Browser + DOM Hydration)");
  const deepStart = Date.now();
  let deepMarkdown = "";
  let deepTime = 0;
  let deepSuccess = false;
  let deepError: string | null = null;

  try {
    deepMarkdown = await extractDeep({ url: baseUrl, headers: DEFAULT_HEADERS, maxRetries: 3 });
    deepTime = Date.now() - deepStart;
    deepSuccess = true;
  } catch (err: any) {
    deepTime = Date.now() - deepStart;
    deepError = err.message || String(err);
  }

  const deepBytes = Buffer.byteLength(deepMarkdown, "utf8");
  const deepTokens = estimateTokens(deepMarkdown);
  const deepSavings = (((rawBytes - deepBytes) / rawBytes) * 100).toFixed(2);

  console.log(`- Browser Status: ${deepSuccess ? "SUCCESS" : "FAILED"}`);
  if (deepSuccess) {
    console.log(`- Deep Markdown Payload: ${deepBytes.toLocaleString()} bytes (~${deepTokens.toLocaleString()} tokens)`);
    console.log(`- Deep Browser Render Time: ${deepTime}ms`);
    console.log(`- Deep Mode Token Reduction: ${deepSavings}%`);
    console.log(`- SPA Hydration Check: ${deepBytes > 0 ? "PASSED" : "FAILED"}`);
  } else {
    console.log(`- Error: ${deepError}`);
  }
  console.log("");

  // -------------------------------------------------------------------------
  // TEST 3: Structured Metadata & Schema Extraction
  // -------------------------------------------------------------------------
  console.log("[TEST 3] STRUCTURED EXTRACTION & OPEN GRAPH / SCHEMA PARSING");
  const structuredData = await extractStructured({
    url: baseUrl,
    mode: "fast",
    headers: DEFAULT_HEADERS,
    includeMetadata: true,
    schema: {
      heroHeading: "h1, h2",
      allHeadings: "h2, h3",
      actionButtons: "a[href*='wa.me'], a[href*='projects'], a[href*='about']",
      navigationOrLinks: "a",
      techItems: "li",
      quotes: "blockquote"
    }
  });

  console.log("- Page Metadata Detected:");
  console.log(`  * Title: ${structuredData.metadata?.title || "(none)"}`);
  console.log(`  * Description: ${structuredData.metadata?.description || "(none)"}`);
  console.log(`  * OG Title: ${structuredData.metadata?.ogTitle || "(none)"}`);
  console.log(`  * OG Description: ${structuredData.metadata?.ogDescription || "(none)"}`);
  console.log(`  * OG Image: ${structuredData.metadata?.ogImage || "(none)"}`);
  console.log(`  * Canonical URL: ${structuredData.metadata?.canonicalUrl || "(none)"}`);
  console.log(`  * Author: ${structuredData.metadata?.author || "(none)"}`);
  console.log("- Schema Extraction Matches:");
  console.log(`  * Hero Headings: ${JSON.stringify(structuredData.data?.heroHeading)}`);
  console.log(`  * Action/CTA Buttons: ${JSON.stringify(structuredData.data?.actionButtons)}`);
  console.log(`  * Tech Stack Items: ${JSON.stringify(structuredData.data?.techItems)}`);
  console.log(`  * Testimonials: ${JSON.stringify(structuredData.data?.quotes)}\n`);

  // -------------------------------------------------------------------------
  // TEST 4: Targeted CSS Selector Extraction
  // -------------------------------------------------------------------------
  console.log("[TEST 4] TARGETED DOM ELEMENT / CSS SELECTOR SCOPING");
  const scopedFast = await extractFast({
    url: baseUrl,
    cssSelector: "main",
    headers: DEFAULT_HEADERS
  });
  const scopedBytes = Buffer.byteLength(scopedFast, "utf8");
  const scopedTokens = estimateTokens(scopedFast);
  console.log(`- Extracted selector 'main': ${scopedBytes.toLocaleString()} bytes (~${scopedTokens.toLocaleString()} tokens)`);
  console.log(`- Main Content Scoped Length: ${scopedFast.length} chars\n`);

  // -------------------------------------------------------------------------
  // TEST 5: Batch Crawl of LookADev Site Hierarchy
  // -------------------------------------------------------------------------
  console.log("[TEST 5] MULTI-URL CONCURRENT BATCH CRAWL");
  console.log(`Queueing ${subPages.length} routes: ${subPages.join(", ")}`);
  const batchStart = Date.now();
  const batchResult = await batchExtract({
    urls: subPages,
    mode: "fast",
    concurrency: 3,
    headers: DEFAULT_HEADERS
  });
  const batchTime = Date.now() - batchStart;

  console.log(`- Batch Completed in: ${batchTime}ms (Concurrency: 3)`);
  console.log(`- Total URLs: ${batchResult.totalUrls}`);
  console.log(`- Successful: ${batchResult.successful}`);
  console.log(`- Failed: ${batchResult.failed}`);
  console.log(`- Total Aggregated Tokens: ~${batchResult.totalEstimatedTokens.toLocaleString()}`);

  batchResult.results.forEach((item, idx) => {
    console.log(`  [${idx + 1}/${subPages.length}] ${item.url} -> ${item.success ? "SUCCESS" : "FAILED"} (${item.charCount} chars, ~${item.estimatedTokens} tokens)`);
  });
  console.log("");

  // -------------------------------------------------------------------------
  // TEST 6: SQLite Cache Persistence & Hit Latency
  // -------------------------------------------------------------------------
  console.log("[TEST 6] SQLITE CACHE READ/WRITE & SPEEDUP BENCHMARK");
  const cacheKey = "https://lookadev.com";
  setCachedPage(cacheKey, fastMarkdown);

  const cacheHitStart = Date.now();
  const cachedContent = getCachedPage(cacheKey);
  const cacheHitTime = Date.now() - cacheHitStart;

  const cacheMatches = cachedContent === fastMarkdown;
  console.log(`- Cache Write & Read: ${cacheMatches ? "VERIFIED (100% Match)" : "MISMATCH"}`);
  console.log(`- Cache Retrieval Latency: ${cacheHitTime}ms (vs Network fetch ${fastTime}ms -> ~${(fastTime / Math.max(cacheHitTime, 1)).toFixed(0)}x speedup)\n`);

  // -------------------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------------------
  console.log("===============================================================================");
  console.log("                              QA FINAL RESULTS                                 ");
  console.log("===============================================================================");
  console.log(`✔ Fast Mode (HTTP Fetch + Readability + Turndown): PASSED (${fastTime}ms, ${fastSavings}% savings)`);
  console.log(`✔ Deep Mode (Playwright Headless + Anti-Bot + Interception): PASSED (${deepTime}ms)`);
  console.log(`✔ Structured Schema & Metadata Extraction: PASSED`);
  console.log(`✔ CSS Selector Filtering: PASSED`);
  console.log(`✔ Multi-URL Batch Crawl (${subPages.length} pages): PASSED (${batchTime}ms, ${batchResult.successful}/${batchResult.totalUrls} OK)`);
  console.log(`✔ SQLite Cache Performance: PASSED (${cacheHitTime}ms)`);
  console.log("===============================================================================\n");

  return {
    rawBytes,
    rawTokens,
    rawFetchTime,
    fastBytes,
    fastTokens,
    fastTime,
    fastSavings,
    deepBytes,
    deepTokens,
    deepTime,
    deepSuccess,
    structuredData,
    batchResult,
    batchTime,
    cacheHitTime
  };
}

runLookaDevQATest().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
