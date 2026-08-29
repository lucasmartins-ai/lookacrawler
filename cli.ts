#!/usr/bin/env bun

const VERSION = "1.0.0";

function showHelp() {
  console.log(`
LookaCrawler CLI v${VERSION}
Token-optimized web crawler & LLM extraction tool.

Usage:
  lookacrawler <command> [options]

Commands:
  extract <url>               Extract token-optimized Markdown from a URL.
  batch <url1> <url2>...     Batch extract content from multiple URLs concurrently.
  structured <url>           Extract metadata and CSS-selector schema JSON from a URL.
  serve                       Start the MCP server (stdio or SSE HTTP transport).
  --help, -h                  Show this help text.
  --version, -v               Show version number.

Options for 'extract':
  --mode <fast|deep>          Extraction mode: fast (fetch) or deep (Playwright browser). Default: fast
  --selector <css>            CSS selector to target specific DOM element.
  --proxy <url>               HTTP/SOCKS5 proxy URL.
  --max-retries <n>           Maximum retry attempts (default: 3).
  --json                      Output formatted JSON response with statistics.
  --jina-format               Output Jina Reader-compatible metadata headers.
  --no-cache                  Bypass local SQLite cache.

Options for 'batch':
  --mode <fast|deep>          Extraction mode (default: fast).
  --concurrency <n>           Parallel worker limit (default: 3).
  --selector <css>            CSS selector filter.

Options for 'structured':
  --schema '<json>'           Key-value map of property names to CSS selectors.
  --no-metadata               Exclude OpenGraph / publication metadata.
  --mode <fast|deep>          Extraction mode (default: fast).

Options for 'serve':
  --transport <stdio|sse>     MCP server transport (default: stdio).
  --port <number>             Port for SSE server (default: 3000).

Examples:
  lookacrawler extract https://news.ycombinator.com --mode fast
  lookacrawler extract https://example.com --mode deep --selector "main"
  lookacrawler batch https://example.com https://news.ycombinator.com --concurrency 2
  lookacrawler structured https://example.com --schema '{"title":"h1","link":"a"}'
  lookacrawler serve --transport sse --port 3000
`);
}

async function runCli() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`v${VERSION}`);
    process.exit(0);
  }

  const command = args[0];

  if (command === "serve") {
    // Forward to index.ts server
    await import("./index.js");
    return;
  }

  if (command === "extract") {
    const urls = args.filter((arg) => !arg.startsWith("-") && arg !== "extract");
    if (urls.length === 0) {
      console.error("Error: Missing target URL for 'extract' command.");
      process.exit(1);
    }
    const url = urls[0];

    const modeArg = getOption(args, "--mode") || "fast";
    const mode = modeArg === "deep" ? "deep" : "fast";
    const selector = getOption(args, "--selector") || getOption(args, "--css-selector");
    const proxy = getOption(args, "--proxy");
    const maxRetries = getOption(args, "--max-retries") ? parseInt(getOption(args, "--max-retries")!, 10) : 3;
    const isJson = args.includes("--json");
    const jinaFormat = args.includes("--jina-format");
    const noCache = args.includes("--no-cache");
    const { extractFast, extractDeep } = await import("./extractor.js");
    const { buildCacheKey, getCachedPage, setCachedPage } = await import("./cache.js");
    const { validateTargetUrl } = await import("./security.js");

    const cacheKey = buildCacheKey({ url, mode, cssSelector: selector });
    if (!noCache && !proxy) {
      const cached = getCachedPage(cacheKey);
      if (cached !== null) {
        if (isJson) {
          console.log(JSON.stringify({ url, mode, cached: true, content: cached }, null, 2));
        } else {
          console.log(jinaFormat ? (await import("./jina-format.js")).formatJinaReader(url, cached) : cached);
        }
        return;
      }
    }

    try {
      await validateTargetUrl(url);
      const markdown = mode === "deep"
        ? await extractDeep({ url, cssSelector: selector, proxy, maxRetries })
        : await extractFast({ url, cssSelector: selector, proxy, maxRetries });

      if (!noCache && !proxy) {
        setCachedPage(cacheKey, markdown);
      }

      if (isJson) {
        console.log(JSON.stringify({ url, mode, cached: false, content: markdown, byteLength: Buffer.byteLength(markdown, "utf8") }, null, 2));
      } else {
        console.log(jinaFormat ? (await import("./jina-format.js")).formatJinaReader(url, markdown) : markdown);
      }
    } catch (err: any) {
      console.error(`Extraction error: ${err.message || err}`);
      process.exit(1);
    }
    return;
  }

  if (command === "batch") {
    const { batchExtract } = await import("./extractor.js");
    const urls = args.filter((arg) => !arg.startsWith("-") && arg !== "batch");
    if (urls.length === 0) {
      console.error("Error: Missing target URLs for 'batch' command.");
      process.exit(1);
    }

    const modeArg = getOption(args, "--mode") || "fast";
    const mode = modeArg === "deep" ? "deep" : "fast";
    const concurrency = getOption(args, "--concurrency") ? parseInt(getOption(args, "--concurrency")!, 10) : 3;
    const selector = getOption(args, "--selector");

    try {
      const result = await batchExtract({ urls, mode, concurrency, cssSelector: selector });
      console.log(JSON.stringify(result, null, 2));
    } catch (err: any) {
      console.error(`Batch extraction error: ${err.message || err}`);
      process.exit(1);
    }
    return;
  }

  if (command === "structured") {
    const { extractStructured } = await import("./extractor.js");
    const urls = args.filter((arg) => !arg.startsWith("-") && arg !== "structured");
    if (urls.length === 0) {
      console.error("Error: Missing target URL for 'structured' command.");
      process.exit(1);
    }
    const url = urls[0];

    const modeArg = getOption(args, "--mode") || "fast";
    const mode = modeArg === "deep" ? "deep" : "fast";
    const rawSchema = getOption(args, "--schema");
    let schema: Record<string, string> | undefined;
    if (rawSchema) {
      try {
        schema = JSON.parse(rawSchema);
      } catch {
        console.error("Error: Invalid JSON schema string.");
        process.exit(1);
      }
    }
    const includeMetadata = !args.includes("--no-metadata");

    try {
      const result = await extractStructured({ url, mode, schema, includeMetadata });
      console.log(JSON.stringify(result, null, 2));
    } catch (err: any) {
      console.error(`Structured extraction error: ${err.message || err}`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown command: ${command}. Use --help for usage details.`);
  process.exit(1);
}

function getOption(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] && !args[i + 1].startsWith("-")) {
      return args[i + 1];
    }
    if (args[i].startsWith(`${flag}=`)) {
      return args[i].slice(flag.length + 1);
    }
  }
  return undefined;
}

runCli();
