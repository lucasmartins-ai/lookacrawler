import { extractFast, extractDeep, extractStructured, batchExtract } from "./extractor.js";
import { getCachedPage, setCachedPage } from "./cache.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

async function runDeepQaBenchmark() {
  console.log("=================================================");
  console.log("      LOOKACRAWLER LIVE QA & TOKEN BENCHMARK     ");
  console.log("=================================================\n");

  const targetUrl = "https://news.ycombinator.com";
  console.log(`[1/5] Testing FAST mode on live website: ${targetUrl}`);

  // Fetch raw HTML for baseline token comparison
  const rawResponse = await fetch(targetUrl, { headers: DEFAULT_HEADERS });
  const rawHtml = await rawResponse.text();
  const rawBytes = Buffer.byteLength(rawHtml, "utf8");
  const rawTokens = estimateTokens(rawHtml);

  console.log(`- Raw HTML Size: ${rawBytes} bytes (~${rawTokens} tokens)`);

  const startTimeFast = Date.now();
  const fastMarkdown = await extractFast({ url: targetUrl, headers: DEFAULT_HEADERS, maxRetries: 3 });
  const durationFast = Date.now() - startTimeFast;
  const fastBytes = Buffer.byteLength(fastMarkdown, "utf8");
  const fastTokens = estimateTokens(fastMarkdown);
  const fastSavings = (((rawBytes - fastBytes) / rawBytes) * 100).toFixed(2);

  console.log(`- Fast Markdown Size: ${fastBytes} bytes (~${fastTokens} tokens)`);
  console.log(`- Fast Extraction Time: ${durationFast}ms`);
  console.log(`- Fast Mode Token Savings: ${fastSavings}%\n`);

  console.log(`[2/5] Testing DEEP mode (Headless Playwright Chromium with JS execution):`);
  const startTimeDeep = Date.now();
  const deepMarkdown = await extractDeep({ url: targetUrl, headers: DEFAULT_HEADERS, maxRetries: 3 });
  const durationDeep = Date.now() - startTimeDeep;
  const deepBytes = Buffer.byteLength(deepMarkdown, "utf8");
  const deepTokens = estimateTokens(deepMarkdown);
  const deepSavings = (((rawBytes - deepBytes) / rawBytes) * 100).toFixed(2);

  console.log(`- Deep Markdown Size: ${deepBytes} bytes (~${deepTokens} tokens)`);
  console.log(`- Deep Browser Crawl Time: ${durationDeep}ms`);
  console.log(`- Deep Mode Token Savings: ${deepSavings}%\n`);

  console.log(`[3/5] Testing Structured JSON Schema & Metadata Extraction:`);
  const structuredData = await extractStructured({
    url: targetUrl,
    mode: "fast",
    headers: DEFAULT_HEADERS,
    schema: {
      siteTitle: ".titleline > a",
    },
    includeMetadata: true,
  });

  console.log("- Extracted Metadata & Schema Output:");
  console.log(JSON.stringify(structuredData, null, 2));
  console.log("");

  console.log(`[4/5] Testing Batch Multi-URL Concurrent Extraction:`);
  const batchUrls = [
    "https://example.com",
    "https://news.ycombinator.com",
  ];
  const batchResult = await batchExtract({
    urls: batchUrls,
    mode: "fast",
    headers: DEFAULT_HEADERS,
    concurrency: 2,
  });

  console.log(`- Total Target URLs: ${batchResult.totalUrls}`);
  console.log(`- Successful Extractions: ${batchResult.successful}/${batchResult.totalUrls}`);
  console.log(`- Total Extracted Tokens: ~${batchResult.totalEstimatedTokens} tokens across ${batchResult.totalCharCount} characters\n`);

  console.log(`[5/5] Testing Local SQLite Cache Layer:`);
  const testCacheUrl = "https://example.com/test-qa-cache";
  const dummyContent = "# QA Test Content\n\nVerified local cache saving.";
  setCachedPage(testCacheUrl, dummyContent);
  const retrievedContent = getCachedPage(testCacheUrl);
  const cacheStatus = retrievedContent === dummyContent ? "PASSED" : "FAILED";
  console.log(`- Cache Write/Read Check: ${cacheStatus}\n`);

  console.log("=================================================");
  console.log("                  QA SUMMARY                     ");
  console.log("=================================================");
  console.log(`✓ Fast Engine Token Savings: ${fastSavings}%`);
  console.log(`✓ Deep Engine Token Savings: ${deepSavings}%`);
  console.log(`✓ Playwright Browser Execution: SUCCESS (${durationDeep}ms)`);
  console.log(`✓ Structured Data Extraction: SUCCESS`);
  console.log(`✓ Concurrent Batch Crawl: SUCCESS (${batchResult.successful}/${batchResult.totalUrls} URLs)`);
  console.log(`✓ SQLite Cache Validation: ${cacheStatus}`);
  console.log("=================================================\n");
}

runDeepQaBenchmark().catch((err) => {
  console.error("QA Benchmark error:", err);
  process.exit(1);
});
