# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Disk: the page cache now drops expired pages whenever any process opens it
  (CLI, MCP server, v2 API, library). Before, only the MCP server pruned, so a
  CLI-only install kept every page it ever read past the 24 h TTL. A locked
  database skips the prune and keeps the cache usable.
- Disk: purging or deleting a Maps campaign also removes the `.raw.tmp` and
  `.tmp.csv` a crashed worker leaves behind; before, they stayed forever.

- Retries: a `429` or `503` inside a URL no longer makes an error retryable.
  A robots.txt veto on a URL with port 44290 was fetched 4 times instead of
  once; only `HTTP 429`, `HTTP Status 503` or a message that starts with the
  code counts as a status now.
- `maps` / `discover_local_leads`: a scraper that exits before reading the
  query no longer crashes the CLI or MCP server with an uncaught `EPIPE`.
- CI runs on Bun 1.4.5. On 1.3.14, `bun test` sometimes missed a spawned
  child's exit or pipe EOF, so CLI tests timed out at random (5 of 10 matrix
  legs failed on 1.3.14, 0 of 20 spawn hangs on 1.4.5, 21/11/2026).

### Changed

- The fast extraction path (`extract`, `batch`, the Markdown of `structured`,
  `extractMetadata`) no longer loads jsdom. HTML is parsed by parse5 (the
  parser jsdom uses) and read through linkedom, and the unpruned fallback
  re-parses instead of cloning every document. `extractor.ts` no longer
  re-exports `mapWebsite`/`crawlWebsite` (import them from `crawler.ts`), which
  had pulled jsdom in through `crawler.ts`. Markdown and metadata are
  byte-identical to the jsdom output on 21 public pages in 9 link/image modes.
  A `css_selector` with a pseudo-element (`div::before`) now fails instead of
  being ignored, and an invalid selector throws `Error` instead of
  `SyntaxError`. jsdom stays for contacts, crawl link discovery, competitor
  audit and `structured` schema selectors.

- `crawl` and `map` (CLI and MCP) now obey `robots.txt` `Disallow`/`Allow`
  rules for `User-agent: *` and `User-agent: lookacrawler` (a specific group
  replaces `*`; longest match wins, `Allow` wins ties; `*` and `$` wildcards).
  The old docs said robots was respected, but only `Sitemap` lines were read.
  Results gain `robots` (`applied` / `none` / `unreachable` / `ignored`) and
  `skippedByRobots`. A 404 means no rules; a 429, 5xx or timeout means nothing
  is fetched (RFC 9309 §2.3.1.4). Paths are compared with percent-escapes
  normalized. Fast mode also refuses a redirect into a disallowed path (deep
  mode's browser follows redirects itself). The start URL's robots.txt
  governs that host on both schemes. Opt out with `--ignore-robots` or
  `ignore_robots: true`. Single-URL `extract` is unaffected.
- The fast-to-stealth-browser escalation on an anti-bot block is now opt-in
  through `LOOKACRAWLER_AUTO_STEALTH=1`. The CLI sets it by default, because
  existing callers (`lookacrawler enrich` in batch scripts, the lookacrawler
  skill's "prefer fast, it escalates" rule) rely on it; `--no-escalate`
  turns it off. The library and MCP server no longer escalate unless the env
  var is set, and the unescalated failure still classifies as `anti_bot` and
  names the switch.

### Added

- `watch <url|@handle> [--platform P] [--limit N]` (MCP `watch_social`): profile and recent
  posts of one account on TikTok, Instagram, Threads, Facebook or X in one shape,
  `{ok, platform, handle, source, observedAt, profile{name,bio,followers,following,posts},
  posts[{url,author,text,publishedAt,views,likes,comments,shares}]}` or
  `{ok:false, status, reason}`. Logged-in sites are read from the rendered page in the
  Chrome bridge tab (read-only, no internal APIs); TikTok tries yt-dlp, then the headless
  browser, then the bridge tab. A field the page does not show is `null`, never a guess:
  the Instagram grid no longer shows counts, Facebook shows no machine dates. A CAPTCHA is
  `blocked` and is never solved. Checked live 21/11/2026 on X, Instagram, Threads,
  Facebook and TikTok (profile; TikTok then showed a CAPTCHA, reported as `blocked`).
- Per-field provenance: `contacts`, `enrich` and `enrich-batch` results carry
  an `evidence` list with one `{type, value, e164?, source_url, observed_at}`
  entry per email and phone. The flat `emails` / `phones` /
  `additionalPhones` arrays are unchanged. Values a lead arrived with (Maps
  listing or caller input) point at the Maps `link`, or `"input"`; values read
  from cached markdown carry the cache time, not the request time.
- Firecrawl v2-compatible routes on the SSE server: `POST /v2/scrape`,
  `POST /v2/map`, `POST /v2/crawl` and `GET /v2/crawl/:id`, so a Firecrawl SDK
  pointed at `http://127.0.0.1:<port>` works unchanged (checked with the
  `firecrawl` JS SDK 4.52.0). Same bearer token, Origin/Host checks and egress
  guard as the MCP endpoints. Fields lookacrawler cannot honour (screenshots,
  subdomains, regex paths, geo location) get a `400`
  naming the field instead of being ignored. Code in `v2-api.ts`.
- `bench/icp-benchmark.ts`: homepage-scrape benchmark through any Firecrawl
  v2-compatible endpoint, so lookacrawler and firecrawl-local are measured the
  same way (sequential, tools interleaved per site, 30 s timeout, success =
  HTTP 200 with at least 100 visible characters, chars/4 tokens, one e-mail
  regex). Writes `per-site.csv` (no URLs) and `summary.md`. The site list is
  not in the repo: it comes from a private CRM.
- `lookacrawler init [--dry-run]` registers the MCP server in Claude Code,
  Cursor and Codex configs that already exist. Each file is backed up (mode
  0600) and replaced atomically; files that do not parse, already have a
  `lookacrawler` entry, or change during the run are left untouched. The dry run
  prints only the added lines, never the rest of the config.
- Single-file binaries: `bun run build:darwin-arm64` / `build:linux-x64`
  (`scripts/build-binary.ts`, `bun build --compile` with minify), a tag-triggered
  `release.yml` that attaches both plus `SHA256SUMS`, and a CI step that builds
  the linux-x64 binary and runs `--version`, `init --dry-run` and `extract`
  outside the repo. Measured on an M-series Mac (6 runs, `/usr/bin/time -l`,
  warm runs, cold first run excluded): darwin-arm64 binary 73 MB, linux-x64
  104 MB; `--version` 0.14 s / 70 MB RSS (via `bun cli.ts`: 0.02 s / 31 MB);
  `extract https://example.com` 0.41-0.51 s / 163 MB (via `bun cli.ts`:
  0.56-0.58 s / 177 MB). Commit d1f3b97, 2026-11-21.
- `tiktok profile @handle [--limit N]` and `tiktok trends [--region BR] [--period 7|30]
  [--kind hashtag|video]`, also as MCP tools `tiktok_profile` / `tiktok_trends`.
  Profiles come from `yt-dlp --flat-playlist`, falling back to a plain headless
  Chromium that reads the page's own `item_list` / rehydration JSON. Trends come
  from the Creative Center page's own list response. One envelope for both:
  `{ok, source, items}` or `{ok:false, status:"blocked"|"error", reason}`;
  403/429/CAPTCHA is `blocked` and never retried. No stealth patches, no login.
  Spec and measurements: `docs/specs/tiktok.md`.
- `social fb-posts` reads each post's top-level comments from its permalink
  (`{author, text, date, url}`, `date` is Facebook's relative age, max 30 per post).
  It switches the order to "Todos os comentários" and scrolls the post dialog (or presses
  "Ver mais comentários") within a 5 s budget. Read-only: only sort/expand controls are
  clicked. `--no-comments` skips it (~6 s per post otherwise). Checked live 18/10/2026:
  matches the page on two group posts with comments; 30 of 30 on a page post with
  hundreds; 20 recent posts of group 542220895801669 really show "Ainda não há nenhum
  comentário", so `comments: []` there is correct.
- Optional TypeSafe System One (Jev) judgments, on only when `TYPESAFE_API_KEY`
  (or the macOS Keychain item `typesafe`) is set; `LOOKACRAWLER_JEV=off` disables
  them. `gtm` asks one batched question per run and skips Maps results outside
  the niche (shops of related goods, schools, associations, public places)
  before crawling them; skipped leads are listed in `skipped`. Enrichment lets
  Jev pick the decision maker among names found on the page, or none. Every
  failure falls back to the deterministic path.
- `audit <url>` / `audit_company_website`: deterministic SEO checklist, conversion
  channels (WhatsApp, phone, email, booking, form), services and a digital
  maturity score. No paid API.
- `intel --site --niche [--loc]` / `analyze_competitors` / `generate_growth_plan`:
  Maps competitor discovery and review, market gaps, and a niche-driven growth
  plan (pt-BR default, `--locale en`). Proof lines cite observed data only.
- `gtm --niche [--loc] [--out file.jsonl|.csv]` / `gtm_pipeline_run`: discover,
  enrich, draft outreach copy (linted) and write a JSONL or formula-safe CSV
  sink. Draft only; nothing is sent.
- `antislop` / `lint_anti_slop`: pt-BR and English AI-slop copy linter.
- `intent` and `scorePurchaseIntent(text, vertical?)`: buying-intent scorer with
  a generic pt-BR + EN lexicon and a built-in `car` vertical.
- `social-lookup` / `lookup_social_profile` and `intent-search` /
  `search_social_intent`: public profile meta tags and Reddit `.json` search,
  fetched through the guarded fetch path. No keys, no login.
- `daemon start|stop|status`: manage the Maps scraper's web mode on 127.0.0.1.
  `stop` only signals a PID it recorded and only while the port still answers.

### Fixed

- Bridge reads (`social`, `watch`) run in the tab the command navigated: the domain match
  could pick another tab of the same site, such as a DM tab another job had open.
- README comparison table: Firecrawl pricing and MCP rows corrected from the
  pricing page and the firecrawl-mcp-server README (checked 2026-11-21), with
  links; the old "$16 to $99+/month" and "Community Wrapper" were out of date.
- `crawl` sends `headers` and cookies only to the start origin. Pages on the same
  host but another scheme or port are still crawled, without credentials.
- Playwright is imported on first browser use instead of at module load
  (`loadChromium()` in `browser-manager.ts`, also used by `tiktok.ts`). With a
  static import every command, `--version` included, crashed wherever
  Playwright was not installed; deep mode now fails with install instructions.
  The compiled binary loads Playwright only from `LOOKACRAWLER_PLAYWRIGHT_DIR`
  or beside the binary, never from the working directory, where an opened
  project could plant a `node_modules/playwright`.
- `social fb-posts` / `fb-search` read the 10/2026 Facebook layout. Post body from
  `[data-ad-rendering-role=story_message]` (fallback `[data-ad-preview=message]`),
  permalink from the bare timestamp link that Facebook fills on hover (search:
  `?multi_permalinks=<id>`), date from the timestamp tooltip, `groupPublic` from the
  group header, and the source `group` on search rows. The feed is virtualised, so
  posts are collected across viewport-sized scrolls and keyed by URL; rows without a
  permalink are dropped. Checked live on one public pt-BR group (6 and 8 posts) and one
  search query (6 posts) on 17/10/2026.
- Bridge calls send `Connection: close`. The "socket connection was closed
  unexpectedly" failure was Bun reusing a keep-alive socket the bridge had already
  closed (the call failed in ~3 ms), not a slow page script.
- `gtm` niche gate no longer treats "supplier" as a miss: Google labels solar
  installers "Fornecedor de equipamentos a energia solar", and 9 real ones
  scored 0.03-0.17. Cut moved from 0.2 to 0.3 after one scoring run over 179 real Maps leads.
- Decision-maker names with accents ("Dra. Marta Lúcia", "Dr. João") were never
  matched by the person regex.
- Failures report why and exit non-zero. `enrich` exited 0 with
  `enrichmentSuccess: false`; it now exits 1 and adds `status`
  (`dead_domain`, `connection_failed`, `blocked_private`, `timeout`,
  `anti_bot`, `http_error`, `invalid_input`, `error`). `extract --json` prints
  `{ ok: false, status, reason, url, mode }` on stdout instead of a stderr line.
- A domain with no DNS record was reported as "blocked by security policy", and
  a site that reset the connection as "private or local hosts are not allowed".
  Both now carry their real reason (`dead_domain`, `connection_failed`).
- A `<table>` with no rows crashed the markdown conversion ("tr.parentNode",
  turndown-plugin-gfm) and lost the whole page; in `enrich` a conversion error
  no longer costs the emails and phones found in the raw HTML.
- `text/markdown` and `text/plain` responses pass through as-is (the HTML
  pipeline flattened their code blocks). PDFs are converted to text with
  `unpdf` (pinned 2.1.0), detected by Content-Type or `%PDF-` magic bytes:
  first 50 pages, 2M characters, 15 s; a PDF that fails to parse is not retried.
- A site could send `x-lookacrawler-blocked` itself and have its own answer
  read as an egress-guard refusal. The guard now marks its answers with a
  random per-process token. A redirect to a host that does not resolve is
  `connection_failed`, so the lead's own domain is not marked dead.
- `extract` failed intermittently with "Extraction error: disk I/O error"
  (`SQLITE_IOERR_VNODE`). On macOS something hard-links the `-wal`/`-shm` files
  of a cache DB kept under `~/Downloads/lookacrawler` while a connection is open,
  and Apple's SQLite then rejects writes. The default cache now lives in
  `$XDG_CACHE_HOME/lookacrawler` (or `~/.cache/lookacrawler`); `LOOKACRAWLER_DB_PATH`
  still overrides it. Measured: 4/6 failures with a fresh DB in the repo dir vs
  0/6 in `~/.cache`; 20/20 consecutive extracts clean after the change.
- The cache is best-effort: any SQLite error is logged once on stderr and treated
  as a miss, so a broken cache no longer fails an extraction.
- `maps` reported a search with no results as a failure ("maps-leads failed:
  inactivity timeout"): that is how the scraper ends an empty search. It is
  an empty success again; a crashed browser still fails with its error.

### Fixed
- `maps` (CLI mode) hung for minutes, or forever, on a result page shorter
  than `--limit`: it waited for the scraper's stdout to close, but the browser
  the scraper drives keeps that pipe open. It now finishes on the limit, after
  `idleMs` (default 15 s) without a new lead, or on the timeout with what
  arrived, and kills the scraper's whole process group so no browser is left
  running. Measured: a 20-lead query that hung for 400+ s returns in 13 s.
- `maps` returned an empty "success" for many queries: it asked for
  `-depth ceil(limit/10)`, and at depth 2 the bundled scraper's browser dies
  on the second scroll ("playwright: target closed"). Measured on the same
  query: 18 leads at depth 1, 0 at depth 2. Depth now defaults to 1, and an
  empty run that logged scraper errors fails with that error instead of
  looking like "no businesses here".

### Added
- `whatsapp_source` on Maps leads: `"google"` when the business listed a
  WhatsApp link on its Maps profile, `"phone"` when the link was built from the
  listing phone and is unconfirmed.
- `contacts` takes several URLs and scans them in one process
  (`--concurrency`, default 4); it prints an array in input order and reports
  a failing site as `{ url, error }` instead of aborting.
- `maps --lang` (default `pt`).

### Security
- Requests sent through a proxy (`--proxy`, `LOOKACRAWLER_PROXIES`) bypassed
  the egress guard, so redirects, page-initiated fetch/XHR/WebSocket and DNS
  rebinding could reach internal hosts through the proxy — including this
  machine's loopback via a trusted local proxy. The guard is now chained in
  front of the proxy (HTTP CONNECT, SOCKS5, SOCKS4) and asks it for the
  validated IP only. DNS is now resolved locally rather than at the proxy:
  geo-DNS follows this machine, Tor `.onion` names no longer resolve, and
  `LOOKACRAWLER_INSECURE_TLS` does not apply to the TLS hop to an `https://`
  proxy (a proxy with a forged certificate now fails with 502).
- Crawl `include`/`exclude` patterns could freeze the whole server: crawled
  URLs are attacker-controlled and a backtracking regex took ~2.8 s per URL on
  the event loop (3 hostile URLs stalled every other client for 9.4 s). They
  are now substrings with `*` wildcards (max 10 × 200 chars); regex syntax is
  rejected with an error instead of silently matching nothing. (#15)
- Deep-mode `actions` are bounded (wait ≤ 10 s, scroll ≤ 20000 px, ≤ 20
  actions, 30 s total, explicit click/fill timeouts). Five clicks on a missing
  selector used to hold a browser for 166 s. (#15)
- Authenticated proxies (`user:pass@`) work in deep mode and the password no
  longer appears on the Chromium command line; service workers are blocked. (#15)
- Documentation, Teredo, local-use NAT64 and IPv4-translated ranges count as
  internal addresses. (#15)

### Fixed
- Enrichment never hit its cache: the home page was stored with a 7-day TTL in
  the timestamp column (i.e. year 1970). It is also fetched once per lead
  instead of twice. (#15)
- Pages served as ISO-8859-1/windows-1252 lost their accents ("A��o"); the
  Content-Type charset, `<meta>` charset and BOM are now honoured. (#15)
- Contacts: phones are normalised to E.164 and validated (libphonenumber), so
  CPFs, CEPs, dates, prices, timestamps and labelled ids ("Protocolo …") are no
  longer reported as phones; emails go through one shared filter (placeholders,
  asset names, error-tracker ids dropped; `[at]`/`(arroba)` decoded); CNPJs
  (numeric and the new alphanumeric format) are extracted; contact subpages are
  ranked by whole words ("team" no longer matches "steam"). (#15)
- `extractContacts` on large pages: the #15 rewrite doubled its time (jsdom
  `closest()` per text node, four case-insensitive attribute queries); now one
  anchor pass and a manual text walk (~+20% vs before #15, which did less work).
- SSE server leaked sessions: Bun's `node:http` never emits `close` on the
  response when a client disconnects, so slots were never freed and the server
  answered `503` to everyone once `LOOKACRAWLER_SSE_MAX_SESSIONS` clients had
  come and gone. Sessions are now released on the request's `close` too.
- Link-heavy pages (news homepages) returned empty Markdown: link-density
  pruning removed the whole content container (`bbc.com/news`: 0 chars). When
  pruning strips >75% of the output, the page is re-rendered without it.
- Tests are hermetic: a `bunfig.toml` preload gives them an in-memory cache DB
  and stubbed DNS. Previously the suite wiped the real `crawler_cache.sqlite`
  and failed offline; the CLI flag-order test now uses a local fixture.
- Maps/enrichment error messages are in English like the rest of the product.

### Added
- `places --excel`: CSV with BOM, `;` separator and decimal comma for Excel
  pt-BR. (#15)
- `quality/phone.ts`, `quality/email.ts`, `quality/cnpj.ts`. (#15)

### Changed
- **Breaking:** crawl/map `include_patterns`/`exclude_patterns` and CLI
  `--include`/`--exclude` are substrings with `*` wildcards, not regexes. (#15)
- `contacts.phones` are formatted national numbers, deduplicated; 8-digit
  local numbers without an area code are dropped. (#15)
- `enrich` returns `whatsapp` as a `wa.me` URL when Maps has no link. (#15)
- New dependency: `libphonenumber-js`. (#15)
- CI pins Bun 1.3.14 instead of `latest`.
- Token-savings claim re-measured on 8 real pages (`benchmark-live.ts`):
  median 90%, range 21–98%, replacing the synthetic ">73%".

## [1.1.2] — 2026-10-11

Security patch release. Upgrading is recommended for anyone running the SSE
server or using `deep` mode. See the README "SSE server security" section for
the new defaults (token required off-loopback, CORS allowlist).

### Security
- `deep` mode: every outbound connection (redirect hops, page-initiated
  fetch/XHR/WebSocket included) now goes through a loopback egress guard that
  pins the validated IP, closing redirect-based SSRF and DNS rebinding. The
  final URL and redirect chain are re-validated as well.
- `fast` mode: connections are pinned the same way; the response size cap is
  enforced while streaming, so responses without `Content-Length` can no longer
  exhaust memory.
- Caller `Cookie`, `Authorization` and custom headers are no longer sent after a
  cross-origin redirect, and in `deep` mode headers are only sent to the target
  origin (previously to every third-party request).
- Per-request `proxy` values are validated (scheme, no path, no
  private/local host); trusted local proxies can be listed in
  `LOOKACRAWLER_ALLOWED_PROXIES`.
- Concurrent Chromium processes are capped (`LOOKACRAWLER_MAX_BROWSERS`) and idle
  ones are closed.
- SSE server: a token is mandatory on non-loopback binds (generated if unset),
  CORS is limited to `LOOKACRAWLER_SSE_ALLOWED_ORIGINS` instead of `*`, browser
  requests from other origins and non-loopback `Host` headers are refused, and
  the token check is constant-time.
- `isPrivateAddress` recognises IPv4-mapped (`::ffff:7f00:1`), NAT64 and 6to4
  encodings of internal addresses.

### Added
- SSE server: several MCP clients can be connected at the same time; each
  session gets its own server instance. Open sessions are capped by
  `LOOKACRAWLER_SSE_MAX_SESSIONS` (default 16); beyond that `/sse` answers `503`.

### Fixed
- SSE server: a new client can connect after the previous one disconnects
  (previously every later connection got `409` until restart).
- CLI: `extract`/`batch`/`crawl` with `--mode deep` now exit when they finish
  (Chromium and the egress guard were keeping the process alive).
- The MCP server reported version `1.1.0`; versions are now aligned to `1.1.2`.

## [1.1.1] — 2026-10-02

Patch release. `places` was returning a single result titled "Results" — the
results-list heading read as a business name — while every real card on the
page went unparsed. Three separate breakages, each reproduced against live
Google Maps before being fixed.

### Fixed

- **Consent interstitial blocked Maps entirely.** Google redirects to
  `consent.google.com`, which serves no results until answered. The handler
  matched `aria-label*="Accept"`, but that label is localized — a run served
  `hl=pt-BR` with the button reading "Aceitar todos" and never matched. It now
  covers several languages and waits for the redirect back to Maps.
- **Results view was mistaken for a single place.** The branch that decides
  between the two views read the page `h1`, which is the localized heading
  "Results". It now keys off whether any `/maps/place/` card exists.
- **Every coordinate was dropped.** Current Maps URLs encode position as
  `!3d<lat>!4d<lng>`; the parser only handled the legacy `@lat,lng,zoom` form,
  so no result carried a latitude or longitude.

### Added

- `readCardMeta()` reads rating, review count, category and address from the
  result card, so a sweep stays at one page load instead of opening each place.

### Verification

`tsc --noEmit` clean · `bun test` 147 pass / 2 skip / 0 fail. Live run of
`places "dental clinic Bristol" --limit 3` returns real businesses with rating,
category, address and coordinates; CSV output carries all of them.

## [1.1.0] — 2026-10-02

First release since `v1.0.0` (21 commits). Additive feature work plus five
defects found in a technical audit of the crawler and the lead-discovery
pipeline. No breaking changes: every new capability is opt-in, and existing
CLI flags and MCP tools keep their current behaviour.

### Added

- **Entity extraction.** `extract_contacts` / `contacts` returns emails, phone
  numbers, WhatsApp links and social profiles from a site and its contact
  subpages. `search_places` / `places` returns structured Google Maps business
  records, with `--csv` output sanitized against spreadsheet formula injection.
- **B2B lead discovery.** `discover_local_leads` / `maps` runs the Google Maps
  engine; `deep_enrich_lead` / `enrich` crawls a company's own site for
  verified emails, social links and decision makers, emitting a sub-300-token
  Markdown summary.
- **`enrich-batch`.** Enriches a JSON array of `{title, website}` through a
  bounded worker pool (`--concurrency`, default 3). The previous sequential
  path took 20x the slowest site for a 20-lead batch.
- **`--jina-format`.** Emits Jina Reader-compatible metadata headers.
- **Rotating proxy pool.** `LOOKACRAWLER_PROXIES` takes a comma or whitespace
  separated list of proxy URLs. Every request without an explicit `--proxy`
  pulls the next entry, so one blocked IP is not fatal for a run.
- **Opt-in insecure TLS.** `LOOKACRAWLER_INSECURE_TLS=true` accepts a
  TLS-intercepting proxy's forged certificate, for both the fetch and the
  Playwright path. Off by default.
- **Cloudflare email deobfuscation.** Decodes
  `/cdn-cgi/l/email-protection` XOR-encoded addresses, which are otherwise
  invisible to any text scan.

### Fixed

- **Cloudflare Turnstile could never load.** The Playwright request
  interceptor allowed only `document`/`script`/`fetch`/`xhr` and aborted
  everything else — including `sub_frame`. The challenge widget was killed on
  arrival, the page never resolved, and the `fast` → `deep` escalation was
  wasted. `sub_frame` is now allowed; stylesheets stay blocked, which is where
  most of the byte savings come from.
- **Contacts were read back from pruned markdown.** `deepEnrichLead` matched
  emails with a regex over the extracted Markdown, but the pipeline drops
  `<nav>` and `<footer>` as boilerplate — exactly where companies put the
  contact address. It also dropped the `/contact` link the fallback searches
  for, so that path never fired. Contact extraction now reads raw HTML via
  `extractContacts`, which also removes a duplicate regex set.
- **WhatsApp links assumed Brazil.** `formatWhatsAppLink` padded a UK number
  into a `wa.me/55…` link. It now refuses to guess: no E.164 number starts
  with `0`, so national long-distance forms return `undefined` rather than a
  link that dials nothing.
- **Every page was fetched twice during a crawl.** Link discovery re-fetched
  each page purely to read hrefs, doubling traffic; in `deep` mode the refetch
  returns raw SPA markup with an empty root, so discovery found nothing and the
  crawl stopped at depth 0. Discovery now reuses the extracted Markdown.
  `link_format: strip` still refetches, since it removes URLs by design.
- **`ProxyManager` was dead code.** The class existed and was unit-tested but
  never instantiated, so `--proxy` took a single URL per run and an IP block
  could not be routed around.
- **Hardcoded developer path.** `resolveMapsLeadsBinary` listed
  `/Users/<author>/…` as a fallback candidate, so the binary only resolved on
  the original machine. Removed.
- **CI hit the live Google Maps site.** The `places` browser test ran against
  `google.com/maps` on every invocation and timed out. Gated behind
  `LIVE_PLACES_TEST=1`.

### Changed

- `maps` accepts `--email`, exposing the scraper's email extraction, which was
  implemented but unreachable from the CLI.
- README documents the optional Google Maps binary (`MAPS_LEADS_BIN`) and its
  graceful failure. The Go scraper is a separate project and is not vendored.

### Verification

`tsc --noEmit` clean · `bun test` 146 pass / 1 skip / 0 fail across 25 files
(494 assertions) · `bun run build` OK. Crawl of a linked page pair completes in
322 ms with one fetch per page. Live enrichment of `cloudflare.com` went from
0 to 50 phone numbers; that site publishes no email address, so `emails` stays
empty there.

[Unreleased]: https://github.com/lucasmartins-ai/lookacrawler/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/lucasmartins-ai/lookacrawler/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/lucasmartins-ai/lookacrawler/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/lucasmartins-ai/lookacrawler/releases/tag/v1.0.0