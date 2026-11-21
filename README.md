<div align="center">

# 🕷️ LookaCrawler

**Free, open-source, token-efficient local alternative to Firecrawl with native Model Context Protocol (MCP) Server for LLMs.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.1%2B-black.svg?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg?logo=typescript)](https://www.typescriptlang.org)
[![MCP Ready](https://img.shields.io/badge/MCP-JSON--RPC%202.0-8A2BE2.svg)](https://modelcontextprotocol.io)
[![GitHub Stars](https://img.shields.io/github/stars/lucasmartins-ai/lookacrawler?style=social)](https://github.com/lucasmartins-ai/lookacrawler)
[![Local-First](https://img.shields.io/badge/Privacy-Local--first-success.svg)](SECURITY.md)

</div>

---

## 📌 Why LookaCrawler?

Web crawling for Large Language Models (LLMs) is broken by default: modern web pages contain massive HTML bloat (scripts, tracking pixels, nested divs, navigation headers, stylesheets), costing thousands of wasted tokens per page.

**LookaCrawler** is an open-source, token-optimized local crawler that cuts a median 90% of tokens on real pages (21–98% across 8 sites, see `benchmark-live.ts`), extracts clean Markdown, renders JavaScript-heavy pages with a real browser, and exposes a native **Model Context Protocol (MCP) Server** ready for **Claude Desktop, Cursor, and Antigravity**.

---

## 🥊 Comparison: LookaCrawler vs Alternatives

| Feature | 🕷️ LookaCrawler | 🔥 Firecrawl (Cloud) | ⚡ Jina Reader |
| :--- | :---: | :---: | :---: |
| **Pricing / Cost** | **$0.00 (100% Free Open Source)** | Free tier of 1,000 credits/month; paid plans from $19/month (Hobby, $16 billed annually) to $749/month (Scale), Enterprise custom | Rate-limited API |
| **Token Reduction** | **Median 90% fewer tokens (real pages) + Footnotes** | Standard Markdown | Basic Markdown |
| **Autonomous Crawling** | **Native `map` & `crawl` (BFS + URL patterns)** | Cloud Crawler | Single-page only |
| **Pre-Crawl Actions** | **Native Playwright (click, scroll, fill)** | Paid Addon | None |
| **Link Formatting** | **Inline, References Footnotes, Strip** | Inline only | Inline only |
| **Data Privacy** | **Local-first (Zero Telemetry)** | Cloud Provider | Cloud API |
| **MCP Integration** | **Native Tools + Resources + Prompts** | Official MCP server (`firecrawl-mcp`) and a hosted OAuth connector | None |
| **JS Rendering** | **Real Chrome (Playwright)** | Cloud Proxies | Basic Headers |
| **Local SQLite Cache** | **Built-in (24h TTL cache)** | Redis / Paid Addon | None |
| **JS SPA Support** | **Playwright + Chrome Pool** | Cloud Headless | Headless |

Firecrawl rows checked on 2026-11-21 against the [pricing page](https://www.firecrawl.dev/pricing) (prices "effective September 4, 2026", USD), the [firecrawl-mcp-server README](https://github.com/firecrawl/firecrawl-mcp-server) and the [MCP docs](https://docs.firecrawl.dev/mcp-server). Firecrawl also ships Firecrawl Local and a self-hosted server under AGPL-3.0 ([README](https://github.com/firecrawl/firecrawl)); the column above describes the cloud service.

---

## 🚀 Key Features

- **Token Economy First:** Automatically prunes scripts, styles, inline SVGs, tracking tags, navigations, footers, redundant forms, and boilerplate containers with high link density (>80%).
- **Advanced Link & Image Formatting:**
  - `link_format`: Choose between `inline` (standard markdown), `references` (footnote citations `[1]`, saving ~25% tokens on repetitive URLs), or `strip` (pure text).
  - `image_mode`: Choose between `ignore` (zero tokens), `alt_only` (preserves semantic context without URL bloat), or `markdown` (full `![alt](url)`).
- **Autonomous Mapping & Recursive Crawling:**
  - `map_website`: Inspects `/robots.txt`, sitemaps, and root anchors to discover all pages in a domain.
  - `crawl_website`: Breadth-first autonomous crawling with max depth, max pages, URL pattern filters (substring, `*` wildcard), and real-time token accounting.
  - Both obey `robots.txt` `Disallow`/`Allow` rules for `User-agent: *` or `User-agent: lookacrawler` (a `lookacrawler` group replaces `*`). Skipped URLs come back in `skippedByRobots`, and `robots` reports `applied`, `none`, `unreachable` (5xx/timeout: nothing is fetched, per RFC 9309) or `ignored`. Fast mode also refuses a redirect into a disallowed path. Opt out with `--ignore-robots` / `ignore_robots: true`. A single-URL `extract` is a user request and does not read `robots.txt`.
- **Pre-Crawl Browser Actions:** Automate clicks, scrolls, typing, and waits in Playwright before extracting content (dismiss cookie banners, scroll for infinite loading, expand accordions).
- **Dual Hybrid Crawling Engine:**
  - `fast`: Ultra-fast native HTTP GET with backoff. When an anti-bot page blocks it, the CLI retries in the stealth browser (`deep`); pass `--no-escalate` to stop that. The library and MCP server only escalate with `LOOKACRAWLER_AUTO_STEALTH=1`; otherwise the block is returned as an `anti_bot` failure.
  - `deep`: Headless Playwright engine launching real Google Chrome for pages that need JavaScript. Challenge pages (CAPTCHA, bot checks) are detected and reported instead of retried.
- **Native MCP Ecosystem:**
  - **Tools:** `extract_web_content`, `crawl_website`, `map_website`, `batch_extract_web_content`, `extract_structured_data`, `extract_contacts`, `search_places`, `discover_local_leads`, `deep_enrich_lead`, `lint_anti_slop`, `lookup_social_profile`, `search_social_intent`, `audit_company_website`, `analyze_competitors`, `generate_growth_plan`, `gtm_pipeline_run`.
  - **Resources:** Live telemetry at `crawler://metrics` and cache analytics at `crawler://cache/stats`.
  - **Prompts:** Pre-engineered templates `crawl-and-summarize` and `compare-pages`.
- **Entity Extraction:** `contacts` pulls emails, phone numbers, WhatsApp links and social profiles; `places` returns structured Google Maps business records with formula-injection-safe CSV output.
- **B2B Lead Discovery:** `maps` (Google Maps engine) plus `enrich`, which crawls a company's own site for verified emails, socials and decision makers.
- **GTM Toolkit (no paid APIs):** `audit` (SEO + conversion checklist), `intel` (audit + Maps competitor review + deterministic growth plan), `gtm` (Maps discovery, enrichment, outreach draft written to JSONL/CSV; never sends anything), `antislop` (AI-slop copy linter), `intent` (pt-BR/EN buying-intent scorer), `social-lookup` and `intent-search` (public profile meta tags, Reddit `.json`), `daemon` (Maps scraper web-mode service).
- **Local SQLite Caching:** Stores extracted Markdown in `crawler_cache.sqlite` to eliminate duplicate network calls.
- **Structured JSON & Metadata Extraction:** Extracts Open Graph tags (`og:title`, `og:description`), publication dates, canonical URLs, and custom CSS selectors.

---

## 🔌 1-Click MCP Setup (Claude Desktop & Cursor)

`lookacrawler init` adds the MCP server to Claude Code (`~/.claude.json`),
Cursor (`~/.cursor/mcp.json`) and Codex (`~/.codex/config.toml`) when those
files exist. It backs each file up first (`<file>.lookacrawler-backup-<time>`),
leaves alone any file it cannot parse or that already has a `lookacrawler`
entry, and `--dry-run` prints the lines it would add without writing anything.

```bash
bun run cli.ts init --dry-run
bun run cli.ts init
```

Or add it by hand to `claude_desktop_config.json` or Cursor MCP settings:

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

Requires **Bun 1.1+** (high-performance runtime with native SQLite):

```bash
# Clone the repository
git clone https://github.com/lucasmartins-ai/lookacrawler.git
cd lookacrawler

# Install dependencies
bun install
```

#### Single binary (no Bun needed)

Tagged releases attach `lookacrawler-darwin-arm64` and `lookacrawler-linux-x64`
(with `SHA256SUMS`). Build them yourself with `bun run build:darwin-arm64` or
`bun run build:linux-x64` (output in `dist/`). Fast mode, `map`, `crawl`,
`contacts`, `serve` and `init` work from the binary alone. Playwright is not
bundled: deep mode needs `npm i playwright && npx playwright install chromium`
in a folder you choose, with `LOOKACRAWLER_PLAYWRIGHT_DIR` set to that folder
(or the `node_modules` beside the binary). The binary never loads Playwright
from the working directory, so a project you open cannot plant its own copy.

### 2. CLI Commands

```bash
# Single URL fast Markdown extraction
bun run cli.ts extract https://news.ycombinator.com --mode fast

# Single URL fast Markdown extraction with reference footnotes
bun run cli.ts extract https://example.com --link-format references --output page.md

# Headless Playwright deep extraction with CSS selector target
bun run cli.ts extract https://example.com --mode deep --selector "main" --json

# Discover all website URLs and sitemaps
bun run cli.ts map https://example.com --max-urls 500

# Recursively crawl documentation with URL pattern filtering and token accounting
bun run cli.ts crawl https://example.com/docs --max-depth 2 --max-pages 15 --include /docs/ --link-format references

# Batch concurrent multi-URL crawling
bun run cli.ts batch https://site1.com https://site2.com --concurrency 4

# Structured JSON schema extraction
bun run cli.ts structured https://example.com --schema '{"title":"h1","links":"a"}'

# Extract emails, phones, WhatsApp links and social profiles from a site
bun run cli.ts contacts https://example.com

# Search local businesses on Google Maps (browser-driven)
bun run cli.ts places "dentists in Bristol" --limit 5 --csv -o places.csv

# B2B lead discovery via the bundled google-maps-scraper engine
# (build it first: bun run build:maps)
bun run cli.ts maps "dental clinic" "Bristol" --limit 20

# Enrich a company website: emails, socials, decision makers, short summary
bun run cli.ts enrich https://example.com --title "Example Ltd" --mode fast

# Enrich many leads at once from a JSON array of {title, website}
bun run cli.ts enrich-batch leads.json --concurrency 3 -o enriched.json

# Audit a site: SEO checklist, conversion channels, services, digital maturity
bun run cli.ts audit https://example.com

# Audit + Maps competitor review + deterministic growth plan (--locale en for English)
bun run cli.ts intel --site https://example.com --niche "dental clinic" --loc Bristol --limit 3

# Discover -> enrich -> draft outreach copy -> JSONL (or .csv). Draft only, nothing is sent
bun run cli.ts gtm --niche "dental clinic" --loc Bristol --limit 5 --out leads.jsonl

# Lint copy for AI-slop (argument, --file, or stdin)
bun run cli.ts antislop "No cenário atual, uma solução revolucionária"

# Score buying intent of a post or comment (generic lexicon; --vertical car for vehicles)
bun run cli.ts intent "Procuro um sofá até R$ 2.500"

# Public social lookups, no keys: profile meta tags and Reddit search
bun run cli.ts social-lookup https://www.instagram.com/example/
bun run cli.ts intent-search "recommend a dentist Goiania" --subreddit goiania

# Run the Maps scraper as a local service (127.0.0.1:8088); `maps`, `gtm` and `intel` use it when up
bun run cli.ts daemon start
bun run cli.ts daemon status
bun run cli.ts daemon stop

# Start MCP Server via SSE on port 3000
bun run cli.ts serve --transport sse --port 3000
```

> **Behind a TLS-intercepting proxy?** Export `LOOKACRAWLER_INSECURE_TLS=true` to
> accept the proxy's forged certificate. Off by default — never enable it for
> untrusted networks.

> **Rotating proxies?** Export `LOOKACRAWLER_PROXIES` with a comma or
> whitespace separated list of URLs. Every request without an explicit
> `--proxy` pulls the next entry, so one blocked IP is not fatal for the run.

> **Local proxy (Tor, mitmproxy, a sidecar)?** A `proxy` passed per request
> must be a public host. List trusted local proxies in
> `LOOKACRAWLER_ALLOWED_PROXIES` (comma separated, exact URLs); entries in
> `LOOKACRAWLER_PROXIES` are trusted too.

#### SSE server security

| Variable | Effect |
| --- | --- |
| `LOOKACRAWLER_SSE_TOKEN` | Bearer token required on every request. If the server is bound to a non-loopback address (e.g. `--host 0.0.0.0`) and this is unset, a random token is generated and printed at startup. |
| `LOOKACRAWLER_SSE_ALLOWED_ORIGINS` | Comma-separated web origins allowed to call the server from a browser (CORS). Requests with any other `Origin` header are refused. CLI/desktop MCP clients are unaffected. |
| `LOOKACRAWLER_SSE_ALLOW_UNAUTHENTICATED` | `true` disables the token requirement on non-loopback binds. Only for isolated networks. |
| `LOOKACRAWLER_SSE_MAX_SESSIONS` | Maximum concurrent SSE clients (each gets its own MCP session). Default `16`; further connections get `503` until one disconnects. |
| `LOOKACRAWLER_MAX_BROWSERS` | Maximum concurrent Chromium processes (one per distinct proxy). Default `4`; idle ones are closed after `LOOKACRAWLER_BROWSER_IDLE_MS` (default 120000). |

Every outbound connection goes through a built-in loopback egress guard that
resolves each destination once, refuses private/link-local/loopback addresses
and connects to exactly the IP it checked. This covers redirects and requests a
page makes on its own (fetch, XHR, WebSocket) in `deep` mode, and prevents DNS
rebinding. With a proxy (`--proxy`, `LOOKACRAWLER_PROXIES`) the guard sits in
front of it: it validates the destination, then asks the proxy to connect to
that IP (HTTP `CONNECT`, SOCKS5 with optional user/password, or SOCKS4), so a
proxy — even a trusted local one — can never be steered at an internal host.
Side effect: DNS is resolved on this machine, not at the proxy, so geo-DNS/CDN
edges follow your location rather than the proxy's, and SOCKS4 cannot reach
IPv6-only sites. `LOOKACRAWLER_ALLOW_LOCAL=true` turns all of this off and talks
to the proxy directly (for local development only).

#### Firecrawl v2-compatible API

The SSE server also answers `POST /v2/scrape`, `POST /v2/map`, `POST /v2/crawl`
and `GET /v2/crawl/:id` in Firecrawl's v2 shapes, behind the same token and
egress guard. Point a Firecrawl SDK at it:

```js
import { Firecrawl } from "firecrawl";
const app = new Firecrawl({ apiUrl: "http://127.0.0.1:3000", apiKey: process.env.LOOKACRAWLER_SSE_TOKEN });
const doc = await app.scrape("https://example.com", { formats: ["markdown", "links"] });
```

Only what lookacrawler can honour is accepted; anything else gets a `400` that
names the field, never a silent no-op:

- Formats: `markdown` and `links`. No screenshots, HTML, JSON extraction or summaries.
- `proxy`: `basic`/`auto` fetch over HTTP (`auto` already escalates to the browser
  on anti-bot pages); `stealth`/`enhanced`, `waitFor` and `actions` (`wait`,
  `click`, `scroll`) use the browser.
- Map covers one host (`includeSubdomains: false`), sitemap plus home-page links;
  `search` ranks matching URLs first; `limit` up to 5,000.
- Crawl `limit` up to 100 pages, `maxDiscoveryDepth` up to 5, at most 2 crawls
  running. `includePaths`/`excludePaths` are plain path substrings; regex syntax
  and quantifiers (`*`, `+`, `?`) get a 400. robots.txt is not read yet, so every
  crawl must send `"ignoreRobotsTxt": true`. `headers` go only to the start
  origin. Finished jobs live in memory for an hour, within a 200 MB budget.
- `timeout` bounds the whole scrape or map (`408` when it runs out).
  `metadata.statusCode` is always `200`. Fast mode turns an HTTP 4xx/5xx into an
  error; browser mode (`stealth`, `actions`) still returns the rendered error page.
- No `/v2/search`, batch scrape, crawl cancel, `location` or v0/v1 routes.

### 3. Google Maps engine (optional)

The `maps` command, `daemon`, `gtm`, `intel` and the `discover_local_leads` MCP
tool drive a Google Maps scraper written in Go. Its source lives in
[`google-maps-scraper/`](google-maps-scraper/) (MIT, originally by
[Georgios Komninos (gosom)](https://github.com/gosom/google-maps-scraper), via
[coelhobugado/google-maps-scraper](https://github.com/coelhobugado/google-maps-scraper),
with local fixes for hangs and leaked browsers).

> **Responsible use.** Google's Maps Platform terms restrict scraping Google Maps
> content. Use this engine for low-volume research you review yourself, respect
> each site's terms, and prefer the official Places API for commercial volume. Build it once (needs Go 1.26+;
`install-browser` also needs Node.js 18+; the Docker image ships it built):

```bash
bun run build:maps
cd google-maps-scraper && ./maps-leads install-browser   # first run only
```

The binary is looked up next to `cli.ts`, in `../google-maps-scraper/`, or at
`$MAPS_LEADS_BIN` (an explicit path that does not exist is an error, not a
fallback).

Without it, `maps` fails fast with a clear message; `extract`, `crawl`,
`contacts`, `places` and `enrich` are unaffected. Pass `--email` to let the
scraper extract public emails during discovery.

### TikTok (public data, no login)

```bash
bun run cli.ts tiktok profile @khaby.lame --limit 10
bun run cli.ts tiktok trends --region BR --period 7 --kind hashtag
```

Same as the MCP tools `tiktok_profile` and `tiktok_trends`. Output envelope:
`{ "ok": true, "source": "yt-dlp"|"browser"|"creative-center", "items": [...] }` or
`{ "ok": false, "status": "blocked"|"error", "reason": "..." }` (exit code 1).
`blocked` means TikTok answered 403/429 or a CAPTCHA: final, do not retry.
Profiles need `yt-dlp` with `curl_cffi` on PATH (`LOOKACRAWLER_YTDLP` overrides
the binary). Nothing here logs in, signs requests or solves CAPTCHAs; from a
headless browser TikTok often answers with a CAPTCHA (profiles) or 403 (Creative
Center). Measurements and limits: [docs/specs/tiktok.md](docs/specs/tiktok.md).

### Watch an account (TikTok, Instagram, Threads, Facebook, X)

```bash
bun run cli.ts watch https://x.com/AnthropicAI --limit 5
bun run cli.ts watch @vetlucasmartins --platform instagram
```

Same as the MCP tool `watch_social`. One shape for every network:
`{ ok, platform, handle, source, observedAt, profile: {name, bio, followers, following, posts}, posts: [{url, author, text, publishedAt, views, likes, comments, shares}] }`,
or `{ ok: false, status: "invalid_input"|"bridge_offline"|"not_logged_in"|"blocked"|"error", reason }` (exit 1).
Instagram, Threads, Facebook and X are read from the rendered page in the
logged-in Chrome tab of the local bridge (`127.0.0.1:8765`), read-only. TikTok
falls back to that tab when yt-dlp and the headless browser fail. Fields a page
does not show stay `null`. A CAPTCHA is reported as `blocked` and never solved.
Set `BRIDGE_SESSION` to keep a job in its own bridge tabs.

### 4. Docker Deployment

```bash
# Build and run Docker container
docker build -t lookacrawler .
docker run -p 3000:3000 -e LOOKACRAWLER_SSE_TOKEN="$(openssl rand -hex 24)" lookacrawler
```

The container listens on `0.0.0.0`, so a token is always required. Without
`LOOKACRAWLER_SSE_TOKEN` a random one is generated on each start and printed in
the container logs.

---

## 🧪 Architecture & Testing

```text
Incoming URL ──► [Local SQLite Cache Check] ──(Hit)──► Return Cached Markdown
                       │ (Miss)
                       ▼
            [Fast HTTP GET Request] ──(Blocked?)──► [Escalate to Browser Rendering]
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
- 💡 **Open an Issue / PR** for rendering improvements or crawler features.

---

## Built by LookADev

[`lookacrawler`](https://github.com/lucasmartins-ai/lookacrawler) is built and maintained by [LookADev](https://lookadev.com), an engineering studio specializing in AI agents, web architecture, and token optimization.

**Start a project → [lookadev.com](https://lookadev.com)** · **Email: [lucas@lookadev.com](mailto:lucas@lookadev.com)**

## 📄 License

Open-source software licensed under the [MIT License](LICENSE).
