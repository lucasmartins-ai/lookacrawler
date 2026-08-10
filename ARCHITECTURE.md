# LookaCrawler - Technical Architecture & Engineering Guidelines

LookaCrawler is a local Model Context Protocol (MCP) server engineered specifically for web crawling, JS rendering, and high-efficiency HTML-to-Markdown extraction designed for Large Language Model (LLM) consumption.

The system's core design pillar is **Token Economy**: minimizing prompt overhead by stripping unnecessary HTML, stylesheets, scripts, media assets, and whitespace before returning clean, structured Markdown to the LLM.

---

## 1. System Architecture Overview

```
+-----------------------------------------------------------------------------------+
|                                 MCP Client (LLM)                                  |
+-----------------------------------------------------------------------------------+
                                          |
                                   stdio transport
                                          v
+-----------------------------------------------------------------------------------+
|                        LookaCrawler MCP Server (Bun / TS)                         |
|                                                                                   |
|  Tool: extract_web_content                                                        |
|  Params: { url, mode, css_selector, headers, cookies, proxy, max_retries }        |
+-----------------------------------------------------------------------------------+
                                          |
                                          +-----------------------------------------+
                                          |                                         |
                                   mode = "fast"                             mode = "deep"
                                          |                                         |
                                          v                                         v
+---------------------------------------------------+     +---------------------------------------------------+
|     Resilience & Proxy Layer (resilience.ts)      |     |     Resilience & Stealth Engine (extractor.ts)    |
|  - RateLimiter per domain                         |     |  - RateLimiter per domain                         |
|  - Exponential backoff retryWithBackoff           |     |  - Stealth plugin integration                     |
|  - ProxyManager (HTTP / SOCKS5)                   |     |  - Playwright proxy & context extra headers/cookies|
|  - Custom headers & serialized cookies            |     |  - Resource blocking (image, font, css abort)     |
+---------------------------------------------------+     +---------------------------------------------------+
                                          |                                         |
                                          +-------------------+---------------------+
                                                              |
                                                              v (Raw HTML)
+-----------------------------------------------------------------------------------+
|                            Anti-Bot & Challenge Detector                          |
|  - Detects Cloudflare, hCaptcha, Turnstile, reCAPTCHA, and HTTP 403/429/503      |
+-----------------------------------------------------------------------------------+
                                                              |
                                                              v (Validated HTML)
+-----------------------------------------------------------------------------------+
|                         Token-Optimization Pipeline                               |
|                                                                                   |
|  1. DOM Pruning:                                                                  |
|     Remove <script>, <style>, <noscript>, <svg>, <iframe>, <nav>, <footer>,        |
|     <form>, and inline style attributes.                                          |
|                                                                                   |
|  2. CSS Targeting (Optional):                                                     |
|     Scope DOM exclusively to elements matching `css_selector`.                     |
|                                                                                   |
|  3. Readability Processing (@mozilla/readability + JSDOM):                        |
|     Extract main article body text and meaningful structural content.             |
|                                                                                   |
|  4. Turndown Markdown Conversion:                                                 |
|     Convert pruned HTML to GFM Markdown; collapse consecutive blank lines.        |
+-----------------------------------------------------------------------------------+
                                          |
                                          v (Clean Markdown)
+-----------------------------------------------------------------------------------+
|                               Response Output to LLM                              |
+-----------------------------------------------------------------------------------+
```

---

## 2. Tech Stack & Dependencies

| Component | Library / Tool | Purpose |
|---|---|---|
| Runtime | **Bun** (`v1.3+`) | High-performance JavaScript/TypeScript runtime |
| Protocol | `@modelcontextprotocol/sdk` | MCP standard protocol server for tool exposure |
| HTML Parsing | `cheerio` / `jsdom` | Fast DOM traversal, manipulation, and tag/attribute pruning |
| Main Content | `@mozilla/readability` | Heuristic extraction of primary article/page content |
| Markdown | `turndown` | HTML-to-Markdown converter |
| Headless Browser | `playwright` | JS-rendered page crawling ("deep" mode) with reusable browser pool and resource blocking |
| Resilience | `resilience.ts` | Per-domain rate limiting, exponential backoff retries, anti-bot detection, and proxy rotation |

---

## 3. Core Tool Specification

### Tool Name: `extract_web_content`

#### Arguments:
- `url` (`string`, required): Valid HTTP/HTTPS target URL.
- `mode` (`enum: "fast" | "deep"`, default `"fast"`):
  - `"fast"`: Native HTTP GET extraction with rate limiting and retry backoff.
  - `"deep"`: Headless Chromium SPA rendering with stealth plugins and resource blocking.
- `css_selector` (`string`, optional): CSS selector to filter the DOM before readability and Markdown processing.
- `headers` (`Record<string, string>`, optional): Key-value map of custom request headers.
- `cookies` (`Record<string, string>`, optional): Key-value map of authentication or session cookies.
- `proxy` (`string`, optional): HTTP or SOCKS5 proxy server URL.
- `max_retries` (`number`, default `3`): Max exponential backoff retries on transient errors.

---

## 4. Resilience & Protection Architecture

1. **Anti-Bot & CAPTCHA Detection (`detectAntiBot`):**
   - Automatically inspects HTTP response status (403, 429, 503) and body signatures for Cloudflare, hCaptcha, Turnstile, and reCAPTCHA challenge pages.
   - Throws descriptive anti-bot errors allowing client applications to switch modes or rotate proxies.

2. **Per-Domain Rate Limiting (`RateLimiter`):**
   - Tracks timestamp of last request per domain.
   - Automatically delays subsequent calls to identical domains to avoid triggering rate limits or IP bans.

3. **Exponential Backoff Retries (`retryWithBackoff`):**
   - Automatically retries transient network errors, timeouts, or server drops with increasing delay intervals (`initialDelayMs * backoffFactor^attempt`).

4. **Proxy Manager (`ProxyManager`):**
   - Accepts proxy server definitions and handles proxy rotation across requests for both native `fetch` and Playwright browser instances.

---

## 5. Token-Optimization Pipeline Rules

All extracted HTML MUST undergo the 4-stage token optimization pipeline:

1. **Tag & Attribute Stripping:** Remove `script`, `style`, `noscript`, `svg`, `iframe`, `nav`, `footer`, `form`.
2. **Node Targeting (CSS Selector):** If `css_selector` is provided, scope DOM root to matching elements.
3. **Readability Extraction (`@mozilla/readability`):** Strip headers, sidebars, ads, and noise.
4. **Turndown Markdown Formatting:** Convert clean DOM tree into GFM Markdown and collapse excess newlines (`\n{3,}` -> `\n\n`).

---

## 6. Architectural Standards for Developers & AI Agents

1. **No External Network Leaks in Deep Mode:** Playwright route interceptors MUST abort requests for images, fonts, media, and stylesheets (`image`, `font`, `media`, `stylesheet`).
2. **Deterministic Outputs:** Output Markdown must omit extraneous metadata unless explicitly requested.
3. **Error Isolation:** Network failures (4xx, 5xx, timeouts) must return structured JSON error payloads through the MCP tool response rather than crashing the MCP stdio server connection.
4. **Memory Hygiene:** Playwright browser contexts must be closed immediately in `finally` blocks.
5. **Network Safety:** Only public HTTP/HTTPS targets are accepted; redirects are revalidated and response bodies have a configurable size limit.
6. **Cache Correctness:** Cache keys include URL, mode, selector, schema variant, and pipeline version.
