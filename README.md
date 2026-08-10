# LookaCrawler

> **A free, open-source, token-efficient local alternative to Firecrawl.**

LookaCrawler is a token-optimized local **Model Context Protocol (MCP) Server** designed for high-efficiency web crawling, JavaScript SPA rendering, and noise-free Markdown extraction tailored for Large Language Models (LLMs).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Key Features

- **Token Economy First:** Achieves **>73% token reduction** by automatically pruning scripts, stylesheets, inline styles, SVGs, images, navigation bars, footers, forms, and tracking noise before delivering content to LLMs.
- **Hybrid Crawling Engine:**
  - `fast`: Native HTTP GET request with retry backoff for rapid static site extraction.
  - `deep`: Headless Playwright Chromium engine with stealth plugins for dynamic JavaScript SPAs, with strict resource blocking (images, fonts, media, and CSS aborted to save RAM & bandwidth).
- **Resilience & Anti-Bot Protection:**
  - **Cloudflare & CAPTCHA Detection:** Automatically detects anti-bot challenges and rate limits.
  - **Per-Domain Rate Limiting:** Built-in domain throttling to prevent IP blocks and server overload.
  - **Exponential Backoff Retries:** Retries transient network failures and 5xx errors with customizable retry attempts (`max_retries`).
- **Proxying & Custom Headers/Cookies:**
  - Full support for HTTP and SOCKS5 proxies (`proxy`).
  - Custom HTTP headers (`headers`) and authentication cookies (`cookies`) in both `fast` and `deep` crawl modes.
- **Structured JSON & Metadata Extraction:** Extract Open Graph tags (`og:title`, `og:description`, `og:image`), canonical URLs, publication dates, authors, and map custom CSS selectors to JSON objects.
- **Concurrent Batch Crawling:** Crawl up to 20 URLs simultaneously with configurable worker concurrency and aggregate token/byte metrics reporting.
- **DOM Targeting (`css_selector`):** Target specific HTML subtrees to extract only the necessary content node.
- **Local SQLite Caching:** Stores extracted Markdown in `crawler_cache.sqlite` with a 24-hour TTL to eliminate redundant network traffic.
- **Safe Remote Mode:** SSE binds to localhost by default, supports bearer-token authentication, blocks private hosts, validates redirects, and limits response size.

---

## Tech Stack

- **Runtime:** [Bun](https://bun.sh) (with native `bun:sqlite` and `bun:test`)
- **Protocol:** `@modelcontextprotocol/sdk`
- **Article Extraction:** `@mozilla/readability` + `jsdom`
- **Markdown Conversion:** `turndown`
- **Headless Browser:** `playwright` with a reusable browser pool

---

## Quick Start

### Installation

```bash
bun install
```

### CLI Interface

LookaCrawler includes a zero-dependency CLI interface:

```bash
# Single URL Markdown extraction
bun run cli.ts extract https://news.ycombinator.com --mode fast

# Headless Playwright Chromium extraction with CSS selector target
bun run cli.ts extract https://example.com --mode deep --selector "main" --json

# Batch concurrent multi-URL extraction
bun run cli.ts batch https://example.com https://news.ycombinator.com --concurrency 3

# Structured JSON schema & metadata extraction
bun run cli.ts structured https://example.com --schema '{"title":"h1","links":"a"}'

# Start MCP Server with SSE HTTP Transport
bun run cli.ts serve --transport sse --port 3000
```

### Docker Container Deployment

```bash
# Build Docker container image
docker build -t lookacrawler .

# Run LookaCrawler container in isolated environment (SSE server on port 3000)
docker run -p 3000:3000 lookacrawler
```

### Running the MCP Server

```bash
# Start MCP server over standard stdio (default)
bun run index.ts

# Start MCP server over SSE HTTP transport (Port 3000)
bun run serve

# Build production bundle
bun run build
```

### Production limits

- `HOST`: SSE bind host, defaults to `127.0.0.1`.
- `LOOKACRAWLER_SSE_TOKEN`: optional bearer token for SSE, health, and metrics endpoints.
- `LOOKACRAWLER_MAX_RESPONSE_BYTES`: maximum response size, defaults to 10 MiB.

---

## 🌟 Real-World Example & Benchmark

Below is a demonstration of LookaCrawler running on a modern web application, demonstrating noise-free Markdown extraction, structured schema parsing, and **>90% token economy savings**.

### 1. Fast Markdown Extraction & Token Benchmark

```bash
bun run cli.ts extract https://example.com --json
```

**Output:**
```json
{
  "url": "https://example.com",
  "mode": "fast",
  "cached": false,
  "byteLength": 4120,
  "content": "## High-Performance Web Applications & AI Automations\n\nWe build fast websites, tailored backends, and AI workflows to automate operations and drive conversions.\n\n### 01 // PERFORMANCE: Fast mobile loading speeds\nSites that load in under 1 second with maximum visitor retention.\n\n### 02 // SYSTEMS: Centralized CRM & Order Management\nCustom management systems connecting all orders, customers, and operations.\n\n### 03 // AUTOMATION: 24/7 AI-driven Customer Inquiries\nInstant AI workflows operating continuously.\n\n[Get Started](https://example.com/contact)..."
}
```

#### 📊 Live Benchmark Metrics:
- **Raw HTML Size**: `64,024 bytes` (~15,955 LLM tokens)
- **LookaCrawler Markdown**: `4,120 bytes` (~1,030 LLM tokens)
- **Token Reduction**: **93.34% savings** (Saved **~14,900 tokens** in a single call!)
- **Latency**: **230ms** (Fast mode) | **0ms** on SQLite cache hit.

---

### 2. Structured Extraction (Open Graph + Custom CSS Schema)

```bash
bun run cli.ts structured https://example.com \
  --schema '{"features":"h3","techStack":"li","cta":".btn-primary"}'
```

**Output:**
```json
{
  "url": "https://example.com",
  "metadata": {
    "title": "Example App — Modern Web Applications & AI Workflows",
    "description": "High-performance web applications, API integrations, and autonomous AI agents.",
    "ogTitle": "Example App — Modern Web Applications & AI Workflows",
    "ogImage": "https://example.com/og-banner.png",
    "canonicalUrl": "https://example.com",
    "author": "Engineering Team"
  },
  "data": {
    "features": [
      "Fast mobile loading speeds",
      "Centralized CRM & Order Management",
      "24/7 AI-driven Customer Inquiries"
    ],
    "techStack": ["Next.js", "React", "Tailwind", "TypeScript", "Python", "FastAPI"],
    "cta": "Get Started"
  }
}
```

---

### 3. Concurrent Multi-URL Batch Crawl

```bash
bun run cli.ts batch \
  https://example.com \
  https://example.com/about \
  https://example.com/pricing \
  https://example.com/docs \
  --concurrency 3
```

**Output:**
```
✔ Batch completed in 540ms across 4 target URLs (4/4 Successful)
✔ Total aggregated LLM tokens: ~1,760 tokens
```

---

---

## MCP Tools Reference

### 1. `extract_web_content`
Extract token-optimized clean Markdown content from a target URL.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | string | **Yes** | - | Target website URL to extract content from. |
| `mode` | `"fast"` \| `"deep"` | No | `"fast"` | `"fast"` (native HTTP fetch) or `"deep"` (headless Chromium SPA rendering). |
| `css_selector` | string | No | `undefined` | Optional CSS selector to narrow extraction to a specific HTML node. |
| `headers` | Record<string, string> | No | `undefined` | Key-value dictionary of custom HTTP request headers. |
| `cookies` | Record<string, string> | No | `undefined` | Key-value dictionary of cookies (e.g. `{ session: "xyz" }`). |
| `proxy` | string | No | `undefined` | HTTP/SOCKS5 proxy URL (e.g. `http://proxy.example.com:8080`). |
| `max_retries` | number | No | `3` | Maximum retry attempts for transient errors (0 to 10). |

---

### 2. `batch_extract_web_content`
Extract content from multiple website URLs concurrently with aggregate token metrics.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `urls` | string[] | **Yes** | - | Array of target URLs to crawl concurrently (1-20 URLs). |
| `mode` | `"fast"` \| `"deep"` | No | `"fast"` | `"fast"` (native fetch) or `"deep"` (Playwright Chromium). |
| `concurrency` | number | No | `3` | Parallel worker concurrency limit (1 to 10). |
| `css_selector` | string | No | `undefined` | Optional CSS selector filter applied across all target URLs. |
| `headers` | Record<string, string> | No | `undefined` | Custom HTTP request headers. |
| `cookies` | Record<string, string> | No | `undefined` | Custom HTTP authentication cookies. |
| `proxy` | string | No | `undefined` | HTTP/SOCKS5 proxy server URL. |

---

### 3. `extract_structured_data`
Extract Open Graph metadata, canonical links, publication dates, and map CSS selectors to JSON objects.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | string | **Yes** | - | Target website URL. |
| `schema` | Record<string, string> | No | `undefined` | Key-value map of schema keys to CSS selectors (e.g. `{ headline: "h1", price: ".price" }`). |
| `include_metadata` | boolean | No | `true` | Extract Open Graph, canonical URL, author, and date tags. |
| `mode` | `"fast"` \| `"deep"` | No | `"fast"` | `"fast"` (native fetch) or `"deep"` (Playwright Chromium). |
| `css_selector` | string | No | `undefined` | Optional CSS selector to scope extraction root. |

---

## Testing & QA

```bash
# Run complete test suite (unit, integration, resilience, structured, batch)
bun test

# Run token optimization benchmark (>70% reduction verification)
bun run benchmark.ts
```

---

## Open Source & Licensing

LookaCrawler is free and open-source software released under the **[MIT License](file:///Users/Master/LOOKACRAWLER/LICENSE)**.

---

## Documentation

- [ARCHITECTURE.md](file:///Users/Master/LOOKACRAWLER/ARCHITECTURE.md): System design, resilience architecture, and pipeline rules.
- [ROADMAP.md](file:///Users/Master/LOOKACRAWLER/ROADMAP.md): Development phases and completed milestones.
