import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { extractFast, extractDeep, extractStructured, batchExtract } from "./extractor.js";
import { getCachedPage, setCachedPage } from "./cache.js";
import { buildCacheKey } from "./cache.js";
import { validateTargetUrl } from "./security.js";
import { getMetrics, recordMetric } from "./metrics.js";
import { closeBrowsers } from "./browser-manager.js";

/**
 * Initialize the LookaCrawler MCP Server
 */
const server = new McpServer({
  name: "lookacrawler",
  version: "1.0.0",
});

/**
 * Define the `extract_web_content` tool
 */
server.registerTool(
  "extract_web_content",
  {
    description: `Extract token-optimized, clean Markdown content from a target website for LLM consumption.

What it does
Fetches a URL, strips HTML bloat (scripts, styles, inline SVGs, tracking tags, navigation, footers, redundant forms) and returns readable Markdown — cutting token usage by ~73% to 90% versus the raw page.

How to use
- Use for any web page, article, or docs you want as LLM-ready text.
- mode="fast" (default): native HTTP GET. mode="deep": headless Chrome with stealth fingerprint for JS-heavy or Cloudflare/Turnstile-protected pages.
- css_selector scopes to a single element (e.g. "main", "article", "#content").
- Pass headers/cookies for gated or geo-restricted content. Providing any of headers/cookies/proxy bypasses the SQLite cache.
- No auth required. Respects robots/rate-limit via retry backoff.

Returns
Markdown text. Cache hits are prefixed with a NOTE marker. Unsupported URLs (non-http, private IP, SSRF) fail with isError: true and a reason.`,
    inputSchema: {
      url: z.string().url().describe("Target website URL to extract content from."),
      mode: z
        .enum(["fast", "deep"])
        .default("fast")
        .describe(
          "Crawl mode: 'fast' (native HTTP fetch) or 'deep' (headless Playwright browser with JS execution)."
        ),
      css_selector: z
        .string()
        .optional()
        .describe("Optional CSS selector to scope content extraction to a specific HTML node (e.g. 'main', 'article')."),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("Optional custom HTTP request headers key-value dictionary."),
      cookies: z
        .record(z.string(), z.string())
        .optional()
        .describe("Optional custom HTTP cookies key-value dictionary."),
      proxy: z
        .string()
        .optional()
        .describe("Optional HTTP/SOCKS5 proxy URL (e.g. 'http://proxy.example.com:8080')."),
      max_retries: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Maximum retry attempts for transient errors or rate limits (default: 3)."),
    },
  },
  async ({ url, mode, css_selector, headers, cookies, proxy, max_retries }) => {
    try {
      await validateTargetUrl(url);
      const bypassCache = Boolean(headers || cookies || proxy);
      const cacheKey = buildCacheKey({ url, mode, cssSelector: css_selector });
      if (!bypassCache) {
        const cached = getCachedPage(cacheKey);
        if (cached !== null) {
          recordMetric("cacheHits");
          return {
            content: [
              {
                type: "text",
                text: `> [!NOTE] This content was retrieved from local cache.\n\n${cached}`,
              },
            ],
          };
        }
      }

      let markdown: string;
      if (mode === "fast") {
        markdown = await extractFast({
          url,
          cssSelector: css_selector,
          headers,
          cookies,
          proxy,
          maxRetries: max_retries,
        });
      } else if (mode === "deep") {
        markdown = await extractDeep({
          url,
          cssSelector: css_selector,
          headers,
          cookies,
          proxy,
          maxRetries: max_retries,
        });
      } else {
        throw new Error(`Unsupported mode: ${mode}`);
      }

      if (!bypassCache) {
        setCachedPage(cacheKey, markdown);
      }

      return {
        content: [
          {
            type: "text",
            text: markdown,
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Extraction failed: ${error.message || String(error)}`,
          },
        ],
      };
    }
  }
);

/**
 * Define the `batch_extract_web_content` tool
 */
server.registerTool(
  "batch_extract_web_content",
  {
    description: `Batch extract token-optimized Markdown from multiple website URLs concurrently, with aggregate token statistics.

What it does
Runs the same fast/deep pipeline as extract_web_content across an array of up to 20 URLs in parallel, then returns per-URL results plus a summary (urls attempted, succeeded, failed, total tokens, and per-page token counts).

How to use
- Use when you need many pages at once — docs, a list of product pages, a set of sources to compare.
- mode applies to every URL. concurrency (1-10) caps parallel workers; keep it modest on fast machines / low bandwidth.
- css_selector is applied to all URLs. headers/cookies/proxy apply globally to every request.
- Each URL is independent: a single failure does not abort the batch (results carry an "error" field for that URL).

Returns
Structured JSON with per-url markdown/tokens/error and aggregate totals. Incomplete or empty batches still return a valid result object.`,
    inputSchema: {
      urls: z.array(z.string().url()).min(1).max(20).describe("Array of target website URLs to extract (1-20)."),
      mode: z
        .enum(["fast", "deep"])
        .default("fast")
        .describe("Crawl mode: 'fast' (native HTTP fetch) or 'deep' (headless Playwright browser)."),
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(3)
        .describe("Maximum parallel HTTP/browser crawl worker concurrency (default: 3)."),
      css_selector: z
        .string()
        .optional()
        .describe("Optional CSS selector to filter DOM node across all target URLs."),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("Optional custom HTTP request headers key-value dictionary."),
      cookies: z
        .record(z.string(), z.string())
        .optional()
        .describe("Optional custom HTTP cookies key-value dictionary."),
      proxy: z.string().optional().describe("Optional HTTP/SOCKS5 proxy URL."),
      max_retries: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Maximum retry attempts per URL (default: 3)."),
    },
  },
  async ({ urls, mode, concurrency, css_selector, headers, cookies, proxy, max_retries }) => {
    try {
      const batchResult = await batchExtract({
        urls,
        mode,
        concurrency,
        cssSelector: css_selector,
        headers,
        cookies,
        proxy,
        maxRetries: max_retries,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(batchResult, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Batch extraction failed: ${error.message || String(error)}`,
          },
        ],
      };
    }
  }
);

/**
 * Define the `extract_structured_data` tool
 */
server.registerTool(
  "extract_structured_data",
  {
    description: `Extract structured JSON — page metadata (Open Graph, canonical URL, author, dates) and/or a custom CSS-selector schema — from a website.

What it does
Fetches a URL and returns a structured object. With include_metadata=true it reads Open Graph tags (og:title, og:description, og:image), the canonical URL, author, and publication/modified dates. You can also pass a schema (property name -> CSS selector) to pull specific fields (e.g. {"title": "h1", "price": ".price", "rating": "span.rating"}) into a typed object.

How to use
- Use for product listings, news/metadata, schema-driven extraction, and any time you need fields instead of prose.
- schema keys become the JSON keys; values are CSS selectors. Leave schema empty to get metadata only.
- include_metadata (default true) adds the Open Graph / author / date block. Set false for a lean result.
- mode/css_selector/headers/cookies/proxy behave exactly as in extract_web_content.

Returns
JSON object with the requested fields (and/or metadata). Missing selectors are omitted rather than failing the whole call. Non-http or private URLs fail with isError: true.`,
    inputSchema: {
      url: z.string().url().describe("Target website URL to extract content and metadata from."),
      schema: z
        .record(z.string(), z.string())
        .optional()
        .describe("Optional key-value map of property names to CSS selectors (e.g. { title: 'h1', price: '.price' })."),
      include_metadata: z
        .boolean()
        .default(true)
        .describe("Whether to extract Open Graph tags, canonical URL, author, and date metadata (default: true)."),
      mode: z
        .enum(["fast", "deep"])
        .default("fast")
        .describe("Crawl mode: 'fast' (native fetch) or 'deep' (Playwright Chromium)."),
      css_selector: z
        .string()
        .optional()
        .describe("Optional CSS selector to scope content before processing."),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("Optional custom HTTP request headers key-value dictionary."),
      cookies: z
        .record(z.string(), z.string())
        .optional()
        .describe("Optional custom HTTP cookies key-value dictionary."),
      proxy: z.string().optional().describe("Optional HTTP/SOCKS5 proxy URL."),
      max_retries: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Maximum retry attempts (default: 3)."),
    },
  },
  async ({ url, schema, include_metadata, mode, css_selector, headers, cookies, proxy, max_retries }) => {
    try {
      await validateTargetUrl(url);
      const bypassCache = Boolean(headers || cookies || proxy);
      const cacheKey = buildCacheKey({
        url,
        mode,
        cssSelector: css_selector,
        variant: { schema, include_metadata },
      });
      if (!bypassCache) {
        const cached = getCachedPage(cacheKey);
        if (cached !== null) {
          return { content: [{ type: "text", text: cached }] };
        }
      }
      const structuredResult = await extractStructured({
        url,
        mode,
        schema,
        includeMetadata: include_metadata,
        cssSelector: css_selector,
        headers,
        cookies,
        proxy,
        maxRetries: max_retries,
      });

      const output = JSON.stringify(structuredResult, null, 2);
      if (!bypassCache) setCachedPage(cacheKey, output);
      return {
        content: [
          {
            type: "text",
            text: output,
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Structured data extraction failed: ${error.message || String(error)}`,
          },
        ],
      };
    }
  }
);

/**
 * Start input/output transport for MCP client communication (stdio or SSE HTTP)
 */
async function main() {
  const args = process.argv.slice(2);
  let transportMode = "stdio";
  let port = 3000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--transport=sse" || args[i] === "--sse") {
      transportMode = "sse";
    } else if (args[i] === "--transport" && args[i + 1]) {
      transportMode = args[i + 1];
      i++;
    } else if (args[i].startsWith("--transport=")) {
      transportMode = args[i].split("=")[1];
    } else if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i].startsWith("--port=")) {
      port = parseInt(args[i].split("=")[1], 10);
    }
  }

  if (transportMode === "sse") {
    let sseTransport: SSEServerTransport | null = null;
    const token = process.env.LOOKACRAWLER_SSE_TOKEN;
    const httpServer = createServer(async (req, res) => {
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
      if (url.pathname === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", metrics: getMetrics() }));
      } else if (url.pathname === "/metrics" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(getMetrics()));
      } else if (url.pathname === "/sse") {
        if (sseTransport) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "An SSE session is already active" }));
          return;
        }
        res.on("close", () => { sseTransport = null; });
        sseTransport = new SSEServerTransport("/messages", res);
        await server.connect(sseTransport);
      } else if (url.pathname === "/messages" && req.method === "POST") {
        if (sseTransport) {
          await sseTransport.handlePostMessage(req, res);
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "SSE session not established" }));
        }
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    });

    const host = process.env.HOST || "127.0.0.1";
    httpServer.listen(port, host, () => {
      console.log(`LookaCrawler MCP Server listening on SSE transport at http://${host}:${port}/sse`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("LookaCrawler MCP Server running on stdio transport");
  }
}

main().catch((error) => {
  console.error("Fatal error starting LookaCrawler MCP server:", error);
  process.exit(1);
});

process.once("SIGINT", () => void closeBrowsers().finally(() => process.exit(0)));
process.once("SIGTERM", () => void closeBrowsers().finally(() => process.exit(0)));
