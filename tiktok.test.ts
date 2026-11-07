import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  blockedReason,
  classifyYtDlpError,
  normalizeHandle,
  parseHashtagList,
  parseItemStruct,
  parseProfilePageData,
  parseTopContents,
  parseYtDlpProfile,
  tiktokProfile,
  tiktokTrends,
  type Browse,
  type PageCapture,
  type YtDlpRun,
} from "./tiktok.js";

// Real responses captured on 2026-11-07, trimmed (see docs/specs/tiktok.md).
const dir = join(import.meta.dir, "fixtures", "tiktok");
const fx = (name: string) => readFileSync(join(dir, name), "utf8");
const ytProfile = fx("ytdlp-profile.json");
const ytEmptyStderr = fx("ytdlp-empty-response.stderr.txt");
const rehydrationEmpty = fx("profile-rehydration-empty.json");
const itemStruct = JSON.parse(fx("video-item-struct.json"));
const ccHashtag = fx("cc-hashtag-br-7.json");
const ccVideo = JSON.parse(fx("cc-video-us-7.json"));

const capture = (over: Partial<PageCapture> = {}): PageCapture => ({
  docStatus: 200, finalUrl: "https://www.tiktok.com/@x", captcha: false, bodies: [], rehydration: "", ...over,
});
const neverBrowse: Browse = async () => { throw new Error("browser must not run"); };

describe("parsers", () => {
  test("yt-dlp flat playlist -> videos", () => {
    const v = parseYtDlpProfile(JSON.parse(ytProfile), "whinderssonnunes");
    expect(v).toHaveLength(3);
    expect(v[0]).toMatchObject({ author: "whinderssonnunes", url: expect.stringContaining("/video/") });
    expect(v[0].createTime).toMatch(/^\d{4}-\d\d-\d\dT/);
    for (const k of ["views", "likes", "comments", "shares", "durationSec"] as const) expect(typeof v[0][k]).toBe("number");
    expect(v[2].durationSec).toBeNull();
  });

  test("web item struct -> same shape", () => {
    const v = parseItemStruct(itemStruct);
    expect(v).toEqual({
      id: "7704740944427388191",
      url: "https://www.tiktok.com/@khaby.lame/video/7704740944427388191",
      author: "khaby.lame",
      description: itemStruct.desc,
      createTime: "2026-11-05T17:30:06.000Z",
      views: 446400,
      likes: 55100,
      comments: 1671,
      shares: 388,
      durationSec: 26,
    });
    expect(Object.keys(v).sort()).toEqual(Object.keys(parseYtDlpProfile(JSON.parse(ytProfile), "x")[0]).sort());
  });

  test("page data: item_list body wins, rehydration fills, duplicates and empty bodies ignored", () => {
    const body = JSON.stringify({ statusCode: 0, itemList: [itemStruct] });
    expect(parseProfilePageData(["", body, body], rehydrationEmpty)).toHaveLength(1);
    expect(parseProfilePageData([""], rehydrationEmpty)).toEqual([]);
  });

  test("Creative Center hashtag list", () => {
    const t = parseHashtagList(JSON.parse(ccHashtag));
    expect(t.map((x) => x.name)).toEqual(["finados", "novembro", "wesleyalemao"]);
    expect(t[0]).toMatchObject({ rank: 1, kind: "hashtag", views: 85059397, posts: 23584, url: "https://www.tiktok.com/tag/finados" });
  });

  test("Creative Center top videos", () => {
    const t = parseTopContents(ccVideo.body);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ rank: 1, kind: "video", author: "megannco", views: 46063622, posts: null });
    expect(t[0].url).toBe(`https://www.tiktok.com/@megannco/video/${t[0].id}`);
  });
});

describe("classification", () => {
  test("yt-dlp empty-body JSON error is an extraction error, 403/CAPTCHA are blocked", () => {
    expect(classifyYtDlpError(ytEmptyStderr)).toBe("extraction");
    expect(classifyYtDlpError("ERROR: [TikTok] x: Unable to download webpage: HTTP Error 403: Forbidden")).toBe("blocked");
    expect(classifyYtDlpError("ERROR: please solve the captcha")).toBe("blocked");
  });

  test("page: 403 / 429 / captcha are blocked, 200 without captcha is not", () => {
    expect(blockedReason(capture({ docStatus: 403 }))).toContain("403");
    expect(blockedReason(capture({ docStatus: 429 }))).toContain("429");
    expect(blockedReason(capture({ captcha: true }))).toContain("CAPTCHA");
    expect(blockedReason(capture())).toBeNull();
  });

  test("handles", () => {
    expect(normalizeHandle("@khaby.lame")).toBe("khaby.lame");
    expect(normalizeHandle("https://www.tiktok.com/@nasa?lang=en")).toBe("nasa");
    expect(() => normalizeHandle("--exec=rm")).toThrow();
  });
});

describe("tiktokProfile fallback", () => {
  const ok: YtDlpRun = async () => ({ code: 0, stdout: ytProfile, stderr: "" });
  const empty: YtDlpRun = async () => ({ code: 1, stdout: "", stderr: ytEmptyStderr });
  const forbidden: YtDlpRun = async () => ({ code: 1, stdout: "", stderr: "ERROR: HTTP Error 403: Forbidden" });

  test("yt-dlp success, limit applied, browser untouched", async () => {
    const r = await tiktokProfile("@whinderssonnunes", { limit: 2, ytdlp: ok, browse: neverBrowse });
    expect(r).toMatchObject({ ok: true, source: "yt-dlp" });
    if (r.ok) expect(r.items).toHaveLength(2);
  });

  test("extraction error -> browser reads the page's own item_list", async () => {
    const browse: Browse = async (url, match) => {
      expect(url).toBe("https://www.tiktok.com/@khaby.lame");
      expect(match.test("https://www.tiktok.com/api/post/item_list/?x=1")).toBe(true);
      return capture({ bodies: [{ url, body: JSON.stringify({ itemList: [itemStruct] }), postData: null }] });
    };
    const r = await tiktokProfile("khaby.lame", { ytdlp: empty, browse });
    expect(r).toMatchObject({ ok: true, source: "browser" });
  });

  test("extraction error -> browser hits CAPTCHA -> blocked", async () => {
    const r = await tiktokProfile("khaby.lame", { ytdlp: empty, browse: async () => capture({ captcha: true, rehydration: rehydrationEmpty }) });
    expect(r).toMatchObject({ ok: false, status: "blocked" });
    if (!r.ok) expect(r.reason).toContain("Failed to parse JSON");
  });

  test("yt-dlp blocked -> stop, no browser", async () => {
    expect(await tiktokProfile("nasa", { ytdlp: forbidden, browse: neverBrowse })).toMatchObject({ ok: false, status: "blocked" });
  });

  test("no data and no block -> error", async () => {
    expect(await tiktokProfile("nasa", { ytdlp: empty, browse: async () => capture() })).toMatchObject({ ok: false, status: "error" });
  });

  test("invalid handle never spawns anything", async () => {
    const r = await tiktokProfile("../etc", { ytdlp: async () => { throw new Error("spawned"); }, browse: neverBrowse });
    expect(r).toMatchObject({ ok: false, status: "error" });
  });
});

describe("tiktokTrends", () => {
  const ccPage = (finalUrl: string, body: string): Browse => async () => capture({ finalUrl, bodies: [{ url: "", body, postData: null }] });

  test("hashtag BR", async () => {
    const r = await tiktokTrends({ region: "br", period: 7, browse: ccPage("https://ads.tiktok.com/creative/creativeCenter/trends/hashtag?region=BR&period=7", ccHashtag) });
    expect(r).toMatchObject({ ok: true, source: "creative-center" });
    if (r.ok) expect(r.items).toHaveLength(3);
  });

  test("video redirected to another region -> error, not silently wrong data", async () => {
    const r = await tiktokTrends({ region: "BR", kind: "video", browse: ccPage("https://ads.tiktok.com/creative/creativeCenter/trends/video?region=US&period=7", JSON.stringify(ccVideo.body)) });
    expect(r).toMatchObject({ ok: false, status: "error" });
    if (!r.ok) expect(r.reason).toContain("US");
  });

  test("video US", async () => {
    const r = await tiktokTrends({ region: "US", kind: "video", browse: ccPage("https://ads.tiktok.com/creative/creativeCenter/trends/video?region=US&period=7", JSON.stringify(ccVideo.body)) });
    expect(r).toMatchObject({ ok: true, items: expect.any(Array) });
  });

  test("headless 403 -> blocked", async () => {
    expect(await tiktokTrends({ browse: async () => capture({ docStatus: 403 }) })).toMatchObject({ ok: false, status: "blocked" });
  });

  test("song / creator and bad input are errors without a browser", async () => {
    for (const o of [{ kind: "song" as const }, { kind: "creator" as const }, { region: "BRA" }, { period: 90 }]) {
      expect(await tiktokTrends({ ...o, browse: neverBrowse })).toMatchObject({ ok: false, status: "error" });
    }
  });
});
