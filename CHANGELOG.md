# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
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