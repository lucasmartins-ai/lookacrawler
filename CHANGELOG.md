# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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