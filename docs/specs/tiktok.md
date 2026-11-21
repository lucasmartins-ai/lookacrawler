# TikTok: profile videos and Creative Center trends

Clean-room spec for `tiktok.ts`. Written from our own measurements on
2026-11-07 (macOS, residential IP, no login) and from reading what public tools
document. No third-party code was copied.

## Commands and output

```
lookacrawler tiktok profile @handle [--limit N]     # MCP: tiktok_profile
lookacrawler tiktok trends [--region BR] [--period 7|30] [--kind hashtag|video]   # MCP: tiktok_trends
```

Every call prints one envelope (exit code 1 when `ok` is false):

```jsonc
{ "ok": true, "source": "yt-dlp" | "browser" | "creative-center", "items": [ ... ] }
{ "ok": false, "status": "blocked" | "error", "reason": "..." }
```

- `blocked`: HTTP 403/429 or a CAPTCHA on our only path. Final; callers must not retry.
- `error`: bad input, nothing to extract, or a kind/region Creative Center does not serve.

Profile item: `id, url, author, description, createTime (ISO), views, likes,
comments, shares, durationSec` (`null` when unknown).
Trend item: `rank, kind, id, name, url, views, posts, author, createTime`
(`posts` = videos using the hashtag; `author`/`createTime` only for videos).

## What we studied

- **yt-dlp TikTok extractor** (open source): `tiktok:user` lists a profile through
  the web app's own `item_list` endpoint and maps `stats.shareCount` to
  `repost_count`. It tries impersonation by itself when `curl_cffi` is installed;
  no flag from us is needed.
- **TikTok-Api (davidteather)** and the **Apify TikTok actor** README: both read the
  same web item struct (`id, desc, createTime, author.uniqueId, stats.playCount,
  diggCount, commentCount, shareCount, video.duration`). TikTok-Api signs requests
  inside a real browser session; we do not do that or anything like it.
- **Public pages** (Playwright, plain Chromium, read-only): profile page ships
  `#__UNIVERSAL_DATA_FOR_REHYDRATION__` with `webapp.user-detail` (user, stats,
  `itemList`) and then requests `/api/post/item_list/` itself. A video page ships
  `webapp.video-detail.itemInfo.itemStruct` (same struct as `item_list` items).
- **Creative Center** moved to `ads.tiktok.com/creative/creativeCenter/trends/<tab>`
  (the old `/business/creativecenter/...` URL 301s there). The page fetches
  `POST /CreativeOne/KnowledgeAPI/GetHashtagList` with
  `{timeRange, countryCode, page, limit}` and, on the video tab,
  `GET ads.us.tiktok.com/CreativeOne/Report/CreativeCenterGetTopContentsList`.

## Paths

Profile:
1. `yt-dlp --ignore-config --flat-playlist -J --playlist-end N https://www.tiktok.com/@h`
   (no user config, so never cookies). stderr, warnings included and minus the
   `ERROR: <id>:` prefix, matching 403/429/captcha/"IP address is blocked" -> `blocked`, stop.
   Any other failure (e.g. `Failed to parse JSON` on an empty body) -> step 2.
2. Fresh headless Chromium, no stealth patches, no fetch escalation. Keep the bodies
   of `/api/post/item_list/` responses the page requests and read the rehydration
   script. Items found -> `source: browser`. Otherwise 403/429 (document or API) or CAPTCHA -> `blocked`,
   else `error`.

Trends: one headless page load, keep the list response, check the region the page
actually served (video falls back to US), then parse.

## Measurements (2026-11-07)

| Probe | Result |
|---|---|
| yt-dlp 2026.08.19 without curl_cffi | fails on every profile (empty body) |
| yt-dlp 2026.10.26 + curl_cffi, 5-6 profiles | ~1-1.8 s each; intermittent: @khaby.lame, @whinderssonnunes, @tiktok returned 5-10 videos, @charlidamelio, @nasa returned an empty body. After ~15 calls in 20 min every profile returned an empty body |
| Profile page, clean Chromium (headless or headed) | 200 HTML, `item_list` body empty, slider CAPTCHA shown -> `blocked` |
| Creative Center hashtag, headless | HTTP 403 (curl with a desktop UA gets 200, 21 KB, no data) -> `blocked` |
| Creative Center hashtag, headed (measurement only) | 200; BR 7 d and 30 d return the top **3** hashtags only (login wall for more) |
| Creative Center video tab, headed | region BR redirects to US; 4 videos anonymously |
| Creative Center song / creator | song redirects to hashtag; creator "Coming soon" |
| Creative Center filters | no industry or keyword filter for hashtags without login; items carry `industryIDs` |
| `tiktok.com/search?q=receita de bolo`, headless and headed | "Something went wrong", `/api/search/general/full/` empty body, 0 videos -> no search command |

## Not done, on purpose

- Headed browser for Creative Center: it works, but its only purpose here would be
  to dodge a 403 aimed at headless automation. Left out; owner's decision.
- No user-agent spoofing, stealth init scripts, signed endpoint calls, CAPTCHA
  solving, login, or retries after `blocked`.
- `/tag/` via yt-dlp is broken upstream ("No working app info"); not used.

## Fixtures

`fixtures/tiktok/` holds trimmed real captures: a yt-dlp playlist, the yt-dlp
empty-body error, the profile rehydration with an empty `itemList` (captured with
the CAPTCHA up), a video item struct, the BR hashtag list and the US video list.
