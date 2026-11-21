import { describe, expect, test } from "bun:test";
import { cleanPostText, countBefore, igNameBio, leadingNumber, parseWatchTarget, profileFromHeader, threadsBio, threadsMetrics, tiktokCaption, watchSocial } from "./watch";

describe("parseWatchTarget", () => {
  test.each([
    ["https://www.tiktok.com/@lucasmartins.ai", "tiktok", "lucasmartins.ai", "https://www.tiktok.com/@lucasmartins.ai"],
    ["https://www.instagram.com/vetlucasmartins/?hl=pt", "instagram", "vetlucasmartins", "https://www.instagram.com/vetlucasmartins/"],
    ["https://www.threads.net/@lucasmartins.ai", "threads", "lucasmartins.ai", "https://www.threads.com/@lucasmartins.ai"],
    ["https://twitter.com/lucasmartinsai", "x", "lucasmartinsai", "https://x.com/lucasmartinsai"],
    ["https://x.com/lucasmartinsai/", "x", "lucasmartinsai", "https://x.com/lucasmartinsai"],
    ["https://www.facebook.com/groups/542220895801669/", "facebook", "/groups/542220895801669", "https://www.facebook.com/groups/542220895801669/"],
  ])("%s", (input, platform, handle, url) => {
    expect(parseWatchTarget(input)).toEqual({ platform: platform as any, handle, url });
  });

  test("handle needs --platform", () => {
    expect(parseWatchTarget("@lucasmartinsai", "x").url).toBe("https://x.com/lucasmartinsai");
    expect(() => parseWatchTarget("@lucasmartinsai")).toThrow("--platform");
  });

  test("post and app URLs are not profiles", () => {
    expect(() => parseWatchTarget("https://www.instagram.com/p/DAbc123/")).toThrow("not a profile");
    expect(() => parseWatchTarget("https://x.com/i/chat/123")).toThrow("not a profile");
    expect(() => parseWatchTarget("https://example.com/foo")).toThrow("not a supported");
  });
});

describe("page number parsing", () => {
  test("profile header in pt-BR and English", () => {
    const ig = "vetlucasmartins\nSeguir\n1.204 posts\n83,1 mil seguidores\n512 seguindo";
    expect(profileFromHeader(ig, "Lucas", null)).toEqual({ name: "Lucas", bio: null, followers: 83100, following: 512, posts: 1204 });
    expect(countBefore("294 Following\n1,234 Followers", ["followers", "seguidores"])).toBe(1234);
    expect(countBefore("20,8 mil seguidores", ["followers", "seguidores"])).toBe(20800);
    expect(countBefore("no counts here", ["followers"])).toBeNull();
  });

  test("aria labels", () => {
    expect(leadingNumber("1,234 Likes. Like")).toBe(1234);
    expect(leadingNumber("12 mil visualizações")).toBe(12000);
    expect(leadingNumber("Reply")).toBeNull();
    expect(leadingNumber(null)).toBeNull();
  });

  test("threads action buttons", () => {
    expect(
      threadsMetrics([
        { label: "Curtir", text: "1,2 mil" },
        { label: "Responder", text: "34" },
        { label: "Repostar", text: "5" },
        { label: "Compartilhar", text: "" },
      ])
    ).toEqual({ likes: 1200, comments: 34, shares: 5 });
    expect(threadsMetrics([])).toEqual({ likes: null, comments: null, shares: null });
  });
});

describe("recorded page text (21/11/2026)", () => {
  test("instagram header: name, bio until the link", () => {
    const h = "vetlucasmartins\nLucas Martins\n823 posts\n82,9 mil seguidores\n291 seguindo\nFui veterinário por 10 anos.\nHoje trabalho com tecnologia.\nmais\npetfoodfix.com/br?utm_source=ig\nSeguido(a) por igormuniz.s\nSeguir";
    expect(igNameBio(h)).toEqual({ name: "Lucas Martins", bio: "Fui veterinário por 10 anos.\nHoje trabalho com tecnologia." });
    expect(profileFromHeader(h, "x", null)).toMatchObject({ followers: 82900, following: 291, posts: 823 });
    expect(igNameBio("brand\n10 posts\n5 seguidores\n1 seguindo\nMais saúde para pets")).toEqual({ name: null, bio: "Mais saúde para pets" });
  });

  test("threads og:description and post text", () => {
    expect(threadsBio("5,8 mi seguidores • 175 threads • Mostly superintelligence and MMA takes. Veja as conversas mais recentes com @zuck.")).toBe(
      "Mostly superintelligence and MMA takes."
    );
    expect(threadsBio(null)).toBeNull();
    expect(cleanPostText("Now in the Muse app: talk with your Muse 🗣️  \nTraduzir\n \n1\n/\n2")).toBe("Now in the Muse app: talk with your Muse 🗣️");
    expect(countBefore("5,8 mi seguidores • 175 threads • bio", ["threads"])).toBe(175);
  });
});

test("tiktok grid alt keeps only the caption", () => {
  expect(tiktokCaption("Você usa IA para estudar? #ia  criado por Lucas Martins AI com a música som original de Lucas Martins AI")).toBe("Você usa IA para estudar? #ia");
  expect(tiktokCaption("no suffix")).toBe("no suffix");
});

describe("review fixes (Codex 21/11)", () => {
  test("app routes and numeric facebook profiles", () => {
    expect(() => parseWatchTarget("https://www.facebook.com/messages/")).toThrow("not a profile");
    expect(parseWatchTarget("https://www.facebook.com/profile.php?id=123&ref=x").url).toBe("https://www.facebook.com/profile.php?id=123");
    expect(() => parseWatchTarget("@home", "x")).toThrow("invalid handle");
    expect(() => parseWatchTarget("https://www.facebook.com/alice/posts/123")).toThrow("not a profile");
    expect(parseWatchTarget("https://www.threads.com/@reels").handle).toBe("reels");
    expect(() => parseWatchTarget("https://www.instagram.com/reels/")).toThrow("not a profile");
  });

  test("numbers: grouped, million, names that start with a number", () => {
    expect(countBefore("1\u202f234 followers", ["followers"])).toBe(1234);
    expect(leadingNumber("1.2 million views")).toBe(1200000);
    expect(leadingNumber("12 mil visualizações")).toBe(12000);
    expect(igNameBio("fiftycent\n50 Cent\n10 posts\n1 seguidores\n2 seguindo").name).toBe("50 Cent");
    expect(threadsBio("10 followers • 2 threads • Hi. See the latest conversations with @alice.")).toBe("Hi.");
    expect(tiktokCaption("A guide created by volunteers")).toBe("A guide created by volunteers");
    expect(tiktokCaption("Tips created by Ana with original sound - Ana")).toBe("Tips");
  });
});

describe("watchSocial envelope", () => {
  test("bad input never throws", async () => {
    expect(await watchSocial("not a url")).toMatchObject({ ok: false, status: "invalid_input" });
  });

});
