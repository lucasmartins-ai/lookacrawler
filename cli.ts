#!/usr/bin/env bun
import { formatJinaReader } from "./jina-format.js";

import { readFile, writeFile } from "fs/promises";
import { EXCEL_PT_BR, toSafeCsv } from "./csv-safe.js";

const VERSION = "1.1.2";

function showHelp() {
  console.log(`
LookaCrawler CLI v${VERSION}
Token-optimized web crawler & LLM extraction tool.

Usage:
  lookacrawler <command> [options]

Commands:
  extract <url>               Extract token-optimized Markdown from a URL.
  contacts <url>              Extract emails, phones, WhatsApp links and social profiles.
  places <query>              Search local businesses on Google Maps.
  map <url>                   Discover domain URLs via robots.txt, sitemaps, and links.
  crawl <url>                 Recursively crawl pages within domain boundaries.
  batch <url1> <url2>...     Batch extract content from multiple URLs concurrently.
  structured <url>           Extract metadata and CSS-selector schema JSON from a URL.
  maps <query> [location]     Discover local B2B prospects via the Google Maps engine.
  enrich <url>                Enrich a company website (emails, socials, decision makers).
  enrich-batch <file>         Enrich every website listed in a JSON file ({title, website}[]).
  social <sub> ...            Read/write Facebook & Instagram through the logged-in
                              Antigravity browser bridge (127.0.0.1:8765).
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

Options for 'contacts':
  --no-deep                   Skip crawling linked contact/about subpages.
  --concurrency <n>           With several URLs: sites scanned in parallel (default 4, max 8).
                              Several URLs print a JSON array; failures come back as { url, error }.
  --output, -o <file>         Write JSON output to a file.

Options for 'maps':
  --email                     Let the scraper extract public emails (slower).
  --location <text>           Location passed to the Maps engine.
  --limit <n>                 Maximum leads (default: 20).
  --lang <code>               Language for categories and labels (default: pt).

Options for 'enrich-batch':
  --concurrency <n>           Parallel enrichments (default: 3).
  --mode <fast|deep>          Crawl mode (default: fast).
  --output, -o <file>         Write JSON array to a file.

Subcommands for 'social':
  doctor                      Bridge + login state of open tabs (never navigates).
  fb-search "<query>"         Search Facebook posts.
  fb-posts <group|page url>   Posts (and their comments) of a group or page.
  ig-comments <post url>      Comments of an Instagram post.
  ig-comment <post url> "<text>"  Comment on a post; dry run unless --live.
  --reply-to <comment id>     Reply to that comment (ig-comment).
  --live                      Actually publish (ig-comment). Default: dry run.
  --limit <n>                 Maximum rows.
  --output, -o <file>         Write JSON output to a file.

Options for 'places':
  --limit <n>                 Maximum places to return (default: 5).
  --csv                       Output as formula-injection-safe CSV instead of JSON.
  --excel                     CSV for Excel pt-BR (BOM, ";" delimiter, decimal comma). Implies --csv.
  --output, -o <file>         Write output to a file.

Options for 'map':
  --max-urls <n>              Maximum discovered URLs to return (default: 1000).
  --include <pattern>         Only URLs containing pattern (* = wildcard).
  --exclude <pattern>         Ignore URLs containing pattern (* = wildcard).
  --output, -o <file>         Write JSON output to a file.

Options for 'crawl':
  --max-depth <n>             Maximum crawl recursion depth (default: 2).
  --max-pages <n>             Maximum pages to crawl (default: 10).
  --mode <fast|deep>          Extraction mode: fast or deep (default: fast).
  --link-format <fmt>         Link format: inline, references, or strip (default: inline)
  --image-mode <mode>         Image mode: markdown, alt_only, or ignore (default: markdown)
  --concurrency <n>           Parallel page crawl concurrency limit (default: 3).
  --include <pattern>         Allowed URL pattern (substring, * = wildcard).
  --exclude <pattern>         Forbidden URL pattern (substring, * = wildcard).
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
    return "serve";
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

  if (command === "contacts") {
    const { extractContacts } = await import("./contacts.js");
    if (positionalUrls.length === 0) {
      console.error("Error: Missing target URL for 'contacts' command.");
      process.exit(1);
    }
    const deepScan = !args.includes("--no-deep");
    const outputFile = getOption(args, "--output") || getOption(args, "-o");

    try {
      let result: unknown;
      if (positionalUrls.length === 1) {
        result = await extractContacts({ url: positionalUrls[0], deepScan });
      } else {
        // Many sites in one process: no per-site startup, bounded parallelism.
        // A failing site yields { url, error } instead of aborting the batch.
        const concurrency = Math.max(1, Math.min(8, parseInt(getOption(args, "--concurrency") || "4", 10) || 4));
        const out: unknown[] = new Array(positionalUrls.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(concurrency, positionalUrls.length) }, async () => {
          while (next < positionalUrls.length) {
            const i = next++;
            try {
              out[i] = await extractContacts({ url: positionalUrls[i], deepScan });
            } catch (err: any) {
              out[i] = { url: positionalUrls[i], error: String(err?.message || err) };
            }
          }
        }));
        result = out;
      }
      const outputJson = JSON.stringify(result, null, 2);
      if (outputFile) {
        await writeFile(outputFile, outputJson, "utf8");
        console.log(`Contacts output saved to ${outputFile}`);
      } else {
        console.log(outputJson);
      }
    } catch (err: any) {
      console.error(`Contacts extraction error: ${err.message || err}`);
      process.exit(1);
    }
    return;
  }

  if (command === "social") {
    const social = await import("./social.js");
    const valueFlags = new Set(["--limit", "--reply-to", "--output", "-o"]);
    const pos: string[] = [];
    for (let i = 1; i < args.length; i++) {
      if (valueFlags.has(args[i])) { i++; continue; }
      if (!args[i].startsWith("-")) pos.push(args[i]);
    }
    const [sub, a1 = "", a2 = ""] = pos;
    const limit = Number(getOption(args, "--limit")) || undefined;
    const outputFile = getOption(args, "--output") || getOption(args, "-o");
    const run: Record<string, () => Promise<unknown>> = {
      doctor: () => social.socialDoctor(),
      "fb-search": () => social.fbSearch(a1, limit),
      "fb-posts": () => social.fbPosts(a1, limit),
      "ig-comments": () => social.igComments(a1, limit),
      "ig-comment": () => social.igComment(a1, a2, { replyTo: getOption(args, "--reply-to"), live: args.includes("--live") }),
    };
    if (!sub || !run[sub]) {
      console.error(`Error: social subcommand must be one of: ${Object.keys(run).join(", ")}`);
      process.exit(1);
    }
    try {
      const outputJson = JSON.stringify(await run[sub](), null, 2);
      if (outputFile) {
        await writeFile(outputFile, outputJson, "utf8");
        console.log(`Social output saved to ${outputFile}`);
      } else {
        console.log(outputJson);
      }
    } catch (err: any) {
      console.error(`Social error: ${err.message || err}`);
      process.exit(1);
    }
    return;
  }

  if (command === "places") {
    const { searchPlaces } = await import("./places.js");
    if (positionalUrls.length === 0) {
      console.error("Error: Missing search query for 'places' command.");
      process.exit(1);
    }
    const query = positionalUrls.join(" ");
    const limit = getOption(args, "--limit") ? parseInt(getOption(args, "--limit")!, 10) : 5;
    const isExcel = args.includes("--excel");
    const isCsv = isExcel || args.includes("--csv");
    const outputFile = getOption(args, "--output") || getOption(args, "-o");

    try {
      const result = await searchPlaces({ query, limit });
      let outputText: string;
      if (isCsv) {
        const headers = ["Title", "Address", "Phone", "Website", "Rating", "ReviewCount", "Latitude", "Longitude", "URL"];
        const rows = result.places.map((p) => [
          p.title, p.address ?? "", p.phone ?? "", p.website ?? "",
          p.rating ?? "", p.reviewCount ?? "", p.latitude ?? "", p.longitude ?? "", p.url ?? "",
        ]);
        outputText = toSafeCsv(headers, rows, isExcel ? EXCEL_PT_BR : {});
      } else {
        outputText = JSON.stringify(result, null, 2);
      }

      if (outputFile) {
        await writeFile(outputFile, outputText, "utf8");
        console.log(`Places result saved to ${outputFile}`);
      } else {
        console.log(outputText);
      }
    } catch (err: any) {
      console.error(`Places search error: ${err.message || err}`);
      process.exit(1);
    }
    return;
  }

  if (command === "maps") {
    const { discoverLocalLeads } = await import("./maps-bridge.js");
    const query = positionalUrls[0];
    const location = positionalUrls[1] || getOption(args, "--location");
    const limit = parseInt(getOption(args, "--limit") || "20", 10);
    const outputFile = getOption(args, "--output") || getOption(args, "-o");

    if (!query) {
      console.error("Error: search query is required (e.g. lookacrawler maps 'clinica odontologica' 'Goiania')");
      process.exit(1);
    }

    try {
      const res = await discoverLocalLeads(query, {
        location,
        limit,
        fastMode: args.includes("--fast-mode"),
        extractEmails: args.includes("--email"),
        lang: getOption(args, "--lang"),
      });
      const outputJson = JSON.stringify(res, null, 2);
      if (outputFile) {
        await writeFile(outputFile, outputJson, "utf8");
        console.log(`Found ${res.total} leads. Saved to ${outputFile}`);
      } else {
        console.log(outputJson);
      }
    } catch (err: any) {
      console.error(`Maps discovery error: ${err.message || err}`);
      process.exit(1);
    }
    return;
  }

  if (command === "enrich") {
    const { deepEnrichLead } = await import("./enrichment-bridge.js");
    if (positionalUrls.length === 0) {
      console.error("Error: URL is required (e.g. lookacrawler enrich https://example.com)");
      process.exit(1);
    }

    const url = positionalUrls[0];
    const title = getOption(args, "--title") || url;
    const mode = getOption(args, "--mode") === "deep" ? "deep" : "fast";
    const outputFile = getOption(args, "--output") || getOption(args, "-o");

    try {
      const res = await deepEnrichLead({ title, web_site: url }, { mode });
      const outputJson = JSON.stringify(res, null, 2);
      if (outputFile) {
        await writeFile(outputFile, outputJson, "utf8");
        console.log(`Enrichment complete. Saved to ${outputFile}`);
      } else {
        console.log(outputJson);
      }
    } catch (err: any) {
      console.error(`Enrichment error: ${err.message || err}`);
      process.exit(1);
    }
    return;
  }

  if (command === "enrich-batch") {
    const { deepEnrichLead } = await import("./enrichment-bridge.js");
    if (positionalUrls.length === 0) {
      console.error("Error: JSON file is required (e.g. lookacrawler enrich-batch leads.json)");
      process.exit(1);
    }
    const inputFile = positionalUrls[0];
    const mode = getOption(args, "--mode") === "deep" ? "deep" : "fast";
    const concurrency = Math.max(1, parseInt(getOption(args, "--concurrency") || "3", 10));
    const outputFile = getOption(args, "--output") || getOption(args, "-o");

    let leads: Array<{ title: string; website: string }>;
    try {
      const parsed = JSON.parse(await readFile(inputFile, "utf8"));
      leads = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.leads) ? parsed.leads : [];
      if (leads.length === 0) throw new Error("no leads found (expected a JSON array of {title, website})");
    } catch (err: any) {
      console.error(`Input error: ${err.message || err}`);
      process.exit(1);
      return;
    }

    // Bounded worker pool. A plain `for await` serialised every site; each
    // enrichment is one network round trip, so 20 leads took 20x the time of
    // the slowest. ponytail: fixed concurrency, no queue/retry layer.
    const results: unknown[] = new Array(leads.length);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, leads.length) }, async () => {
        while (cursor < leads.length) {
          const i = cursor++;
          const lead = leads[i];
          results[i] = await deepEnrichLead(
            { title: lead.title || lead.website, web_site: lead.website },
            { mode }
          );
        }
      })
    );

    const outputJson = JSON.stringify(results, null, 2);
    if (outputFile) {
      await writeFile(outputFile, outputJson, "utf8");
      console.log(`Enriched ${results.length} leads. Saved to ${outputFile}`);
    } else {
      console.log(outputJson);
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
        startUrl: url,
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
        console.log(`Crawl completed: ${result.totalPagesCrawled} pages crawled, saved to ${outputFile}`);
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
    "--location",
    "--lang",
    "--limit",
    "--title",
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

async function main() {
  const outcome = await runCli();
  if (outcome === "serve") return;
  // One-shot commands: close Chromium and the egress guard, otherwise their
  // handles keep the event loop alive and the process never exits.
  const { runCleanups } = await import("./lifecycle.js");
  await runCleanups(3_000);
  // Safety net for any other stray handle; unref'd so it never delays a
  // process that is already free to exit.
  setTimeout(() => process.exit(process.exitCode ?? 0), 2_000).unref();
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
