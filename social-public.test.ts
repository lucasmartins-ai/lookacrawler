import { describe, expect, test } from "bun:test";
import {
  detectSocialPlatform,
  extractMetaTag,
  lookupSocialProfile,
  parseRedditJson,
  parseShorthandNumber,
  searchRedditIntent,
  type FetchText,
} from "./social-public.js";

const IG_HTML = `<html><head>
<meta property="og:title" content="Dra. Ana (@dra.ana) • Instagram photos and videos">
<meta property="og:description" content="12.5K Followers, 450 Following, 320 Posts - See Instagram photos and videos from Dra. Ana (@dra.ana)">
</head><body></body></html>`;

const LI_HTML = `<html><head>
<meta property="og:title" content="Acme Ltda | LinkedIn">
<meta property="og:description" content="Acme Ltda | 51-200 employees | Software | 1.250 followers on LinkedIn">
</head></html>`;

describe("detectSocialPlatform", () => {
  test("matches the real host, not a substring", () => {
    expect(detectSocialPlatform("https://www.instagram.com/x")).toBe("instagram");
    expect(detectSocialPlatform("https://x.com/acme")).toBe("twitter");
    expect(detectSocialPlatform("https://box.com/acme")).toBe("unknown");
    expect(detectSocialPlatform("https://notinstagram.com/acme")).toBe("unknown");
    expect(detectSocialPlatform("not a url")).toBe("unknown");
  });
});

describe("parseShorthandNumber", () => {
  test.each([["12.5K", 12500], ["12,5 mil", 12500], ["1.2M", 1200000], ["10.000", 10000], ["350", 350]])("%s", (s, n) => {
    expect(parseShorthandNumber(s)).toBe(n);
  });
});

describe("lookupSocialProfile (offline, injected fetch)", () => {
  test("parses an Instagram profile and sends no cookies", async () => {
    let seen: Record<string, string> | undefined;
    const fetchText: FetchText = async (_u, o) => ((seen = o?.headers), IG_HTML);
    const p = await lookupSocialProfile("https://www.instagram.com/dra.ana/", { fetchText });
    expect(p.platform).toBe("instagram");
    expect(p.handle).toBe("dra.ana");
    expect(p.followers).toBe(12500);
    expect(p.postsCount).toBe(320);
    expect(Object.keys(seen || {}).map((k) => k.toLowerCase())).not.toContain("cookie");
  });

  test("parses a LinkedIn company page", async () => {
    const p = await lookupSocialProfile("https://www.linkedin.com/company/acme", { fetchText: async () => LI_HTML });
    expect(p.platform).toBe("linkedin");
    expect(p.name).toBe("Acme Ltda");
    expect(p.followers).toBe(1250);
  });

  test("a failing fetch degrades to a summary line", async () => {
    const p = await lookupSocialProfile("https://x.com/acme", {
      fetchText: async () => {
        throw new Error("HTTP 429");
      },
    });
    expect(p.platform).toBe("twitter");
    expect(p.tokenSummary).toContain("HTTP 429");
  });

  test("an unknown host is never fetched", async () => {
    let called = false;
    const p = await lookupSocialProfile("https://example.com/me", { fetchText: async () => ((called = true), "") });
    expect(p.platform).toBe("unknown");
    expect(called).toBe(false);
  });
});

describe("searchRedditIntent (offline, injected fetch)", () => {
  const payload = {
    data: {
      children: [
        { data: { id: "a", title: "Alguém recomenda dentista em Goiânia?", subreddit: "goiania", author: "u1", permalink: "/r/goiania/a", score: 4, num_comments: 2, created_utc: 1700000000, selftext: "" } },
        { data: { id: "b", title: "Bad service at the clinic, never again", subreddit: "x", author: "u2", permalink: "/r/x/b", score: 1, num_comments: 0, created_utc: 1700000001, selftext: "" } },
        { data: { id: "c", title: "Weekend thread", subreddit: "x", author: "u3", permalink: "/r/x/c", score: 1, num_comments: 0, created_utc: 1700000002, selftext: "" } },
      ],
    },
  };

  test("classifies posts and builds a bounded, encoded URL", async () => {
    let url = "";
    const r = await searchRedditIntent("dentista & implante", {
      subreddit: "goiania",
      limit: 99,
      fetchText: async (u) => ((url = u), JSON.stringify(payload)),
    });
    expect(url).toStartWith("https://www.reddit.com/r/goiania/search.json?q=dentista%20%26%20implante");
    expect(url).toContain("limit=25");
    expect(r.posts.map((p) => p.intentCategory)).toEqual(["recommendation_request", "problem_complaint", "general_discussion"]);
    expect(r.summaryText).toContain("r/goiania");
  });

  test("rejects a subreddit that could alter the URL path", async () => {
    await expect(searchRedditIntent("x", { subreddit: "../admin", fetchText: async () => "{}" })).rejects.toThrow("Invalid subreddit");
  });

  test("bad JSON or a failed fetch is an empty result, not a throw", async () => {
    const bad = await searchRedditIntent("x", { fetchText: async () => "<html>blocked</html>" });
    expect(bad.totalFound).toBe(0);
    expect(bad.summaryText).toContain("failed");
  });

  test("parseRedditJson tolerates a missing payload", () => {
    expect(parseRedditJson({})).toEqual([]);
  });
});

describe("extractMetaTag", () => {
  test("reads either attribute order and quote style", () => {
    expect(extractMetaTag(`<meta property="og:title" content="Hi 'x'">`, "og:title")).toBe("Hi 'x'");
    expect(extractMetaTag(`<meta content='A' name='og:description'/>`, "og:description")).toBe("A");
  });

  test("stays linear on a hostile page of unclosed meta tags", () => {
    const start = performance.now();
    extractMetaTag("<meta ".repeat(40_000) + "x", "og:title");
    expect(performance.now() - start).toBeLessThan(1000); // was ~18 s before the bounded scan
  });
});
