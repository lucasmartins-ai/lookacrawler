import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { extractFast, extractDeep, extractStructured, batchExtract } from "./extractor.js";
import { getCachedPage, setCachedPage } from "./cache.js";

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
    description:
      "Extract token-optimized clean Markdown content from a target website for LLM consumption.",
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
        .describe("Optional CSS selector to scope content extraction to a specific HTML node."),
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
      const bypassCache = Boolean(headers || cookies || proxy);
      if (!bypassCache) {
        const cached = getCachedPage(url);
        if (cached) {
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
        setCachedPage(url, markdown);
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
    description:
      "Batch extract token-optimized Markdown content from multiple website URLs concurrently with aggregate token statistics.",
    inputSchema: {
      urls: z.array(z.string().url()).min(1).max(20).describe("Array of target website URLs to extract."),
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
    description:
      "Extract page metadata (OG tags, canonical URL, author, dates) and custom CSS selector JSON schema mapping from a website.",
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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(structuredResult, null, 2),
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
 * Start standard input/output (stdio) transport for MCP client communication
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("LookaCrawler MCP Server running on stdio transport");
}

main().catch((error) => {
  console.error("Fatal error starting LookaCrawler MCP server:", error);
  process.exit(1);
});
