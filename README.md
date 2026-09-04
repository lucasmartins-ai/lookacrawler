<div align="center">

# 🕷️ LookaCrawler

**Free, open-source, token-efficient local alternative to Firecrawl with native Model Context Protocol (MCP) Server for LLMs.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.1%2B-black.svg?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg?logo=typescript)](https://www.typescriptlang.org)
[![MCP Ready](https://img.shields.io/badge/MCP-JSON--RPC%202.0-8A2BE2.svg)](https://modelcontextprotocol.io)
[![GitHub Stars](https://img.shields.io/github/stars/lucasmartins-ai/lookacrawler?style=social)](https://github.com/lucasmartins-ai/lookacrawler)
[![Local-First](https://img.shields.io/badge/Privacy-100%25%20Local-success.svg)](SECURITY.md)

</div>

---

## 📌 Why LookaCrawler?

Web crawling for Large Language Models (LLMs) is broken by default: modern web pages contain massive HTML bloat (scripts, tracking pixels, nested divs, navigation headers, stylesheets), costing thousands of wasted tokens per page.

**LookaCrawler** is an open-source, token-optimized local crawler that strips >73% to 90% of web bloat, extracts clean Markdown, bypasses anti-bot barriers with stealth Playwright drivers, and exposes a native **Model Context Protocol (MCP) Server** ready for **Claude Desktop, Cursor, and Antigravity**.

---

## 🥊 Comparison: LookaCrawler vs Alternatives

| Feature | 🕷️ LookaCrawler | 🔥 Firecrawl (Cloud) | ⚡ Jina Reader |
| :--- | :---: | :---: | :---: |
| **Pricing / Cost** | **$0.00 (100% Free Open Source)** | $16 to $99+/month | Rate-limited API |
| **Token Reduction** | **>73% to 90% aggressive pruning** | Standard Markdown | Basic Markdown |
| **Data Privacy** | **100% Local (Zero Telemetry)** | Cloud Provider | Cloud API |
| **MCP Integration** | **Native 1-Click Server (stdio & SSE)** | Community Wrapper | None |
| **Stealth & Anti-Bot** | **Real Chrome + Stealth Fingerprint** | Cloud Proxies | Basic Headers |
| **Local SQLite Cache** | **Built-in (24h TTL cache)** | Redis / Paid Addon | None |
| **JS SPA Support** | **Playwright + Chrome Pool** | Cloud Headless | Headless |

---

## 🚀 Key Features

- **Token Economy First:** Automatically prunes scripts, styles, inline SVGs, tracking tags, navigations, footers, and redundant forms before passing Markdown to your LLM.
- **Dual Hybrid Crawling Engine:**
  - `fast`: Ultra-fast native HTTP GET with backoff. Auto-escalates to `deep` if an anti-bot challenge is encountered.
  - `deep`: Headless Playwright engine launching real Google Chrome with stealth patches (`navigator.webdriver` cleared, WebGL spoofed, CDP leaks stripped) to transparently crawl Cloudflare/Turnstile-protected pages.
- **Native MCP Server Protocol:** JSON-RPC 2.0 stdio and SSE transports ready for Claude Desktop, Cursor, Windsurf, and Antigravity.
- **Local SQLite Caching:** Stores extracted Markdown in `crawler_cache.sqlite` to eliminate duplicate network calls.
- **Structured JSON & Metadata Extraction:** Extracts Open Graph tags (`og:title`, `og:description`), publication dates, canonical URLs, and custom CSS selectors.

---

## 🔌 1-Click MCP Setup (Claude Desktop & Cursor)

Add LookaCrawler to your `claude_desktop_config.json` or Cursor MCP settings:

```json
{
  "mcpServers": {
    "lookacrawler": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/lookacrawler/index.ts"]
    }
  }
}
```

Now you can prompt Claude or Cursor:
> *"Crawl https://example.com/docs and extract the API documentation using LookaCrawler."*

---

## 📦 Quick Start & CLI Usage

### 1. Installation

Requires **Bun 1.1+** (or Node.js 20+):

```bash
# Clone the repository
git clone https://github.com/lucasmartins-ai/lookacrawler.git
cd lookacrawler

# Install dependencies
bun install
```

### 2. CLI Commands

```bash
# Single URL fast Markdown extraction
bun run index extract https://news.ycombinator.com --mode fast
# (alternative: bun run cli.ts extract ...)

# Headless Playwright deep extraction with CSS selector target
bun run cli.ts extract https://example.com --mode deep --selector "main" --json

# Batch concurrent multi-URL crawling
bun run cli.ts batch https://site1.com https://site2.com --concurrency 4

# Structured JSON schema extraction
bun run cli.ts structured https://example.com --schema '{"title":"h1","links":"a"}'

# Start MCP Server via SSE on port 3000
bun run cli.ts serve --transport sse --port 3000
```

### 3. Docker Deployment

```bash
# Build and run Docker container
docker build -t lookacrawler .
docker run -p 3000:3000 lookacrawler
```

---

## 🧪 Architecture & Testing

```text
Incoming URL ──► [Local SQLite Cache Check] ──(Hit)──► Return Cached Markdown
                       │ (Miss)
                       ▼
            [Fast HTTP GET Request] ──(Blocked?)──► [Auto-Escalate to Deep Stealth]
                       │                                      │
                       ▼                                      ▼
            [HTML DOM Tree Parser] ◄──────────────────────────┘
                       │
                       ▼
       [Aggressive Token Noise Pruner]
       (Strips SVG, Nav, Ads, Tracking, CSS, JS)
                       │
                       ▼
         [Mozilla Readability Engine]
                       │
                       ▼
         [Turndown Markdown Converter] ──► Return Clean LLM Markdown
```

Run test suite:
```bash
bun test
```

---

## ⭐ Star & Support
If LookaCrawler saves you API fees and token costs:
- ⭐ **Star this repository** to help other developers find it!
- 💡 **Open an Issue / PR** for new stealth bypasses or crawler features.

---

## Built by LookADev

[`lookacrawler`](https://github.com/lucasmartins-ai/lookacrawler) is built and maintained by [LookADev](https://lookadev.com), an engineering studio specializing in AI agents, web architecture, and token optimization.

**Start a project → [lookadev.com](https://lookadev.com)** · **Email: [lucas@lookadev.com](mailto:lucas@lookadev.com)**

## 📄 License

Open-source software licensed under the [MIT License](LICENSE).
