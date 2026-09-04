#!/usr/bin/env bun
import { formatJinaReader } from "./jina-format.js";

import { writeFile } from "fs/promises";

const VERSION = "1.0.0";

function showHelp() {
  console.log(`
LookaCrawler CLI v${VERSION}
Token-optimized web crawler & LLM extraction tool.

Usage:
  lookacrawler <command> [options]

Commands:
  extract <url>               Extract token-optimized Markdown from a URL.
  map <url>                   Discover domain URLs via robots.txt, sitemaps, and links.
  crawl <url>                 Recursively crawl pages within domain boundaries.
  batch <url1> <url2>...     Batch extract content from multiple URLs concurrently.
  structured <url>           Extract metadata and CSS-selector schema JSON from a URL.
  serve                       Start the MCP server (stdio or SSE HTTP transport).
  --help, -h                  Show this help text.
  --version, -v               Show version number.

Options for 'extract':
  --mode <fast|deep>          Extraction mode: fast (fetch) or deep (Playwright browser). Default: fast
  --selector <css>            CSS selector to target specific DOM element.
  --link-format <fmt>         Link format: inline, references, or strip (default: inline)
  --image-mode <mode>         Image mode: markdown, alt_only, or ignore (default: markdown)
  --output, -o <file>         Write output directly to a file instead of stdout.
  --proxy <url>               HTTP/SOCKS5 proxy URL.
  --max-retries <n>           Maximum retry attempts (default: 3).
  --json                      Output formatted JSON response with statistics.
  --jina-format               Output Jina Reader-compatible metadata headers.
  --no-cache                  Bypass local SQLite cache.

Options for 'map':
  --max-urls <n>              Maximum discovered URLs to return (default: 1000).
  --include <pattern>         Regex filter: only URLs matching pattern.
  --exclude <pattern>         Regex filter: ignore URLs matching pattern.
  --output, -o <file>         Write JSON output to a file.

Options for 'crawl':
  --max-depth <n>             Maximum crawl recursion depth (default: 2).
  --max-pages <n>             Maximum pages to crawl (default: 10).
  --mode <fast|deep>          Extraction mode: fast or deep (default: fast).
  --link-format <fmt>         Link format: inline, references, or strip (default: inline)
  --image-mode <mode>         Image mode: markdown, alt_only, or ignore (default: markdown)
  --concurrency <n>           Parallel page crawl concurrency limit (default: 3).
  --include <pattern>         Regex filter for allowed URLs.
  --exclude <pattern>         Regex filter for forbidden URLs.
  --output, -o <file>         Write JSON output to a file.

Options for 'batch':
  --mode <fast|deep>          Extraction mode (default: fast).
  --concurrency <n>           Parallel worker limit (default: 3).
  --selector <css>            CSS selector filter.
  --output, -o <file>         Write JSON output to a file.

Options for 'structured':
  --schema '<json>'           Key-value map of property names to CSS selectors.
  --no-metadata               Exclude OpenGraph / publication metadata.
  --mode <fast|deep>          Extraction mode (default: fast).
  --output, -o <file>         Write JSON output to a file.

Options for 'serve':
  --transport <stdio|sse>     MCP server transport (default: stdio).
  --port <number>             Port for SSE server (default: 3000).

Examples:
  lookacrawler extract https://news.ycombinator.com --mode fast
  lookacrawler extract https://example.com --link-format references --image-mode alt_only
  lookacrawler map https://example.com --max-urls 500
  lookacrawler crawl https://example.com --max-depth 2 --max-pages 10 --link-format references
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

  const positionalUrls = getPositionalArgs(args, command);

  if (command === "extract") {
    if (positionalUrls.length === 0) {
      console.error("Error: Missing target URL for 'extract' command.");
      process.exit(1);
    }
    const url = positionalUrls[0];

    const modeArg = getOption(args, "--mode") || "fast";
    const mode = modeArg === "deep" ? "deep" : "fast";
    const selector = getOption(args, "--selector") || getOption(args, "--css-selector");
    const linkFormat = (getOption(args, "--link-format") as "inline" | "references" | "strip") || "inline";
    const imageMode = (getOption(args, "--image-mode") as "markdown" | "alt_only" | "ignore") || "markdown";
    const outputFile = getOption(args, "--output") || getOption(args, "-o");
    const proxy = getOption(args, "--proxy");
    const maxRetries = getOption(args, "--max-retries") ? parseInt(getOption(args, "--max-retries")!, 10) : 3;
    const isJson = args.includes("--json");
    const jinaFormat = args.includes("--jina-format");
    const noCache = args.includes("--no-cache");
    const { extractFast, extractDeep } = await import("./extractor.js");
    const { buildCacheKey, getCachedPage, setCachedPage } = await import("./cache.js");
    const { validateTargetUrl } = await import("./security.js");

    const cacheKey = buildCacheKey({ url, mode, cssSelector: selector, linkFormat, imageMode });
    if (!noCache && !proxy) {
      const cached = getCachedPage(cacheKey);
      if (cached !== null) {
        if (outputFile) {
          await writeFile(outputFile, isJson ? JSON.stringify({ url, mode, cached: true, content: cached }, null, 2) : cached, "utf8");
          console.log(`Output saved to ${outputFile}`);
        } else if (isJson) {
          console.log(JSON.stringify({ url, mode, cached: true, content: cached }, null, 2));
        } else {
          console.log(jinaFormat ? formatJinaReader(url, cached) : cached);
        }
        return;
      }
    }

    try {
      await validateTargetUrl(url);
      const markdown = mode === "deep"
        ? await extractDeep({ url, cssSelector: selector, proxy, maxRetries, linkFormat, imageMode })
        : await extractFast({ url, cssSelector: selector, proxy, maxRetries, linkFormat, imageMode });

      if (!noCache && !proxy) {
        setCachedPage(cacheKey, markdown);
      }

      if (outputFile) {
        await writeFile(outputFile, isJson ? JSON.stringify({ url, mode, cached: false, content: markdown, byteLength: Buffer.byteLength(markdown, "utf8") }, null, 2) : markdown, "utf8");
        console.log(`Output saved to ${outputFile}`);
      } else if (isJson) {
        console.log(JSON.stringify({ url, mode, cached: false, content: markdown, byteLength: Buffer.byteLength(markdown, "utf8") }, null, 2));
      } else {
        console.log(jinaFormat ? formatJinaReader(url, markdown) : markdown);
      }
    } catch (err: any) {
      console.error(`Extraction error: ${err.message || err}`);
      process.exit(1);
    }
    return;
  }

  if (command === "map") {
    const { mapWebsite } = await import("./crawler.js");
    if (positionalUrls.length === 0) {
      console.error("Error: Missing target URL for 'map' command.");
      process.exit(1);
    }
    const url = positionalUrls[0];
    const maxUrls = getOption(args, "--max-urls") ? parseInt(getOption(args, "--max-urls")!, 10) : 1000;
    const includePattern = getOption(args, "--include");
    const excludePattern = getOption(args, "--exclude");
    const outputFile = getOption(args, "--output") || getOption(args, "-o");

    try {
      const result = await mapWebsite({
        url,
        maxUrls,
        includePatterns: includePattern ? [includePattern] : undefined,
        excludePatterns: excludePattern ? [excludePattern] : undefined,
      });

      const outputJson = JSON.stringify(result, null, 2);
      if (outputFile) {
        await writeFile(outputFile, outputJson, "utf8");
        console.log(`Map result with ${result.urls.length} URLs saved to ${outputFile}`);
      } else {
        console.log(outputJson);
      }
    } catch (err: any) {
      console.error(`Map error: ${err.message || err}`);
      process.exit(1);
    }
    return;
  }

  if (command === "crawl") {
    const { crawlWebsite } = await import("./crawler.js");
    if (positionalUrls.length === 0) {
      console.error("Error: Missing target URL for 'crawl' command.");
      process.exit(1);
    }
    const url = positionalUrls[0];
    const maxDepth = getOption(args, "--max-depth") ? parseInt(getOption(args, "--max-depth")!, 10) : 2;
    const maxPages = getOption(args, "--max-pages") ? parseInt(getOption(args, "--max-pages")!, 10) : 10;
    const modeArg = getOption(args, "--mode") || "fast";
    const mode = modeArg === "deep" ? "deep" : "fast";
    const linkFormat = (getOption(args, "--link-format") as "inline" | "references" | "strip") || "inline";
    const imageMode = (getOption(args, "--image-mode") as "markdown" | "alt_only" | "ignore") || "markdown";
    const concurrency = getOption(args, "--concurrency") ? parseInt(getOption(args, "--concurrency")!, 10) : 3;
    const includePattern = getOption(args, "--include");
    const excludePattern = getOption(args, "--exclude");
    const outputFile = getOption(args, "--output") || getOption(args, "-o");

    try {
      const result = await crawlWebsite({
        url,
        maxDepth,
        maxPages,
        mode,
        linkFormat,
        imageMode,
        concurrency,
        includePatterns: includePattern ? [includePattern] : undefined,
        excludePatterns: excludePattern ? [excludePattern] : undefined,
      });

      const outputJson = JSON.stringify(result, null, 2);
      if (outputFile) {
        await writeFile(outputFile, outputJson, "utf8");
        console.log(`Crawl completed: ${result.visitedCount} pages crawled, saved to ${outputFile}`);
      } else {
        console.log(outputJson);
      }
    } catch (err: any) {
      console.error(`Crawl error: ${err.message || err}`);
      process.exit(1);
    }
    return;
  }

  if (command === "batch") {
    const { batchExtract } = await import("./extractor.js");
    if (positionalUrls.length === 0) {
      console.error("Error: Missing target URLs for 'batch' command.");
      process.exit(1);
    }

    const modeArg = getOption(args, "--mode") || "fast";
    const mode = modeArg === "deep" ? "deep" : "fast";
    const concurrency = getOption(args, "--concurrency") ? parseInt(getOption(args, "--concurrency")!, 10) : 3;
    const selector = getOption(args, "--selector");
    const outputFile = getOption(args, "--output") || getOption(args, "-o");

    try {
      const result = await batchExtract({ urls: positionalUrls, mode, concurrency, cssSelector: selector });
      const outputJson = JSON.stringify(result, null, 2);
      if (outputFile) {
        await writeFile(outputFile, outputJson, "utf8");
        console.log(`Batch output saved to ${outputFile}`);
      } else {
        console.log(outputJson);
      }
    } catch (err: any) {
      console.error(`Batch extraction error: ${err.message || err}`);
      process.exit(1);
    }
    return;
  }

  if (command === "structured") {
    const { extractStructured } = await import("./extractor.js");
    if (positionalUrls.length === 0) {
      console.error("Error: Missing target URL for 'structured' command.");
      process.exit(1);
    }
    const url = positionalUrls[0];

    const modeArg = getOption(args, "--mode") || "fast";
    const mode = modeArg === "deep" ? "deep" : "fast";
    const rawSchema = getOption(args, "--schema");
    const outputFile = getOption(args, "--output") || getOption(args, "-o");
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
      const outputJson = JSON.stringify(result, null, 2);
      if (outputFile) {
        await writeFile(outputFile, outputJson, "utf8");
        console.log(`Structured output saved to ${outputFile}`);
      } else {
        console.log(outputJson);
      }
    } catch (err: any) {
      console.error(`Structured extraction error: ${err.message || err}`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown command: ${command}. Use --help for usage details.`);
  process.exit(1);
}

function getPositionalArgs(args: string[], command: string): string[] {
  const flagsWithValue = new Set([
    "--mode",
    "--selector",
    "--css-selector",
    "--link-format",
    "--image-mode",
    "--output",
    "-o",
    "--proxy",
    "--max-retries",
    "--max-urls",
    "--max-depth",
    "--max-pages",
    "--include",
    "--exclude",
    "--concurrency",
    "--schema",
    "--transport",
    "--port",
    "--host",
  ]);

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === command && positional.length === 0 && i === 0) {
      continue;
    }
    if (flagsWithValue.has(arg)) {
      i++; // skip next argument (it's the flag value)
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    positional.push(arg);
  }
  return positional;
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
