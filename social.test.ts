import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import {
  buildFbPostsScript,
  buildIgAddCommentScript,
  buildIgCommentsScript,
  igComment,
  igPostRef,
  parseFbDate,
  shortcodeToPk,
} from "./social.js";

/** Run a page script inside a JSDOM window, as CDP_EVAL would in Chrome. */
function runInPage(html: string, script: string, url = "https://www.facebook.com/groups/carrosexemplo", setup?: (w: any) => void): any {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  setup?.(dom.window);
  return dom.window.eval(script);
}

/**
 * Mimic Facebook's 10/2026 behaviour: a bare "?__cft__" timestamp link gets its
 * real href on hover, and hovering it adds a [role=tooltip] with the full date.
 */
function fakeHover(w: any) {
  w.document.addEventListener("mouseover", (e: any) => {
    const a = e.target.closest && e.target.closest("a[data-real]");
    if (!a) return;
    a.setAttribute("href", a.getAttribute("data-real"));
    const tip = w.document.createElement("div");
    tip.setAttribute("role", "tooltip");
    tip.textContent = a.getAttribute("data-date");
    a.tip = tip;
    w.document.body.appendChild(tip);
  });
  w.document.addEventListener("mouseout", (e: any) => {
    const a = e.target.closest && e.target.closest("a[data-real]");
    if (a?.tip) { a.tip.remove(); a.tip = null; }
  });
}

// Fictional people and posts only.
const groupItem = (id: string, user: string, author: string, text: string, date: string, extra = "") => `
  <div class="item">
    <div data-ad-rendering-role="profile_name"><h2><a href="/groups/carrosexemplo/user/${user}/?__cft__[0]=x">${author}</a></h2></div>
    <a href="?__cft__[0]=AZx" data-real="https://www.facebook.com/groups/carrosexemplo/posts/${id}/?__cft__[0]=AZx&amp;__tn__=R" data-date="${date}"><span>o͏d͏o͏e͏r</span></a>
    <div data-ad-rendering-role="story_message"><div data-ad-preview="message"><div dir="auto">${text}</div></div></div>
    <div data-ad-rendering-role="like_button"></div>
    ${extra}
  </div>`;

const GROUP_PT = `<html><body><div role="main"><span>Grupo Público · 12 mil membros</span><div role="feed">
  <div></div>
  ${groupItem("111", "9001", "Carlos Exemplo", "Procuro HB20 ou Onix até 60 mil, à vista… Ver mais", "Sexta, 16 de outubro de 2026 às 09:05",
    `<div role="article"><a href="/groups/carrosexemplo/user/9002/">Ana Fictícia</a><div dir="auto">tbm to procurando, chama no zap</div></div>`)}
  ${groupItem("222", "9003", "Garagem Modelo", "Vendo Gol 2015 completo, aceito troca", "Quinta, 15 de outubro de 2026 às 18:40")}
  <div class="item"><div data-ad-rendering-role="profile_name">Sem corpo</div><div role="article"></div></div>
</div></div></body></html>`;

describe("Facebook feed extractor (10/2026 layout, pt-BR)", () => {
  test("reads author, body, hover-filled permalink, tooltip date and comments", async () => {
    const res = await runInPage(GROUP_PT, buildFbPostsScript(10), undefined, fakeHover);
    expect(res.status).toBe("ok");
    expect(res.groupPublic).toBe(true);
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({
      author: "Carlos Exemplo",
      authorUrl: "https://www.facebook.com/groups/carrosexemplo/user/9001/",
      text: "Procuro HB20 ou Onix até 60 mil, à vista",
      url: "https://www.facebook.com/groups/carrosexemplo/posts/111/",
      date: "Sexta, 16 de outubro de 2026 às 09:05",
      comments: [{ author: "Ana Fictícia", authorUrl: "https://www.facebook.com/groups/carrosexemplo/user/9002/", text: "tbm to procurando, chama no zap" }],
    });
    // Each post gets its own tooltip, not a stale one from the previous hover.
    expect(res.rows[1].date).toBe("Quinta, 15 de outubro de 2026 às 18:40");
    expect(res.rows[1].url).toBe("https://www.facebook.com/groups/carrosexemplo/posts/222/");
  });

  test("skips dates for posts already collected", async () => {
    const res = await runInPage(GROUP_PT, buildFbPostsScript(10, ["https://www.facebook.com/groups/carrosexemplo/posts/111/"]), undefined, fakeHover);
    expect(res.rows[0].date).toBe("");
    expect(res.rows[1].date).not.toBe("");
  });

  test("an item whose permalink never resolves comes back without url", async () => {
    const res = await runInPage(GROUP_PT, buildFbPostsScript(10)); // no hover handler
    expect(res.rows.map((r: any) => r.url)).toEqual(["", ""]);
    expect(res.diagnostics.noUrl).toBe(2);
  });

  test("private group header is reported as not public", async () => {
    const html = GROUP_PT.replace("Grupo Público", "Grupo Privado");
    expect((await runInPage(html, buildFbPostsScript(10), undefined, fakeHover)).groupPublic).toBe(false);
  });

  test("search results: person author, source group and multi_permalinks post id", async () => {
    const html = `<html><body><div role="main"><div role="feed">
      <div>
        <a href="/groups/4242/?__cft__[0]=x" aria-label="Carros Exemplo GO"></a>
        <div data-ad-rendering-role="profile_name"><a href="/groups/4242/?__cft__[0]=x">Carros Exemplo GO</a> · Participar</div>
        <a href="/groups/4242/user/7007/?__cft__[0]=x">Pedro Inventado</a>
        <a href="https://www.facebook.com/groups/4242/?multi_permalinks=5555&amp;hoisted_section_header_type=recently_seen&amp;__cft__[0]=x">o͏d͏o</a>
        <div data-ad-rendering-role="story_message">Quero comprar um carro em Goiânia até 40 mil</div>
      </div>
    </div></div></body></html>`;
    const res = await runInPage(html, buildFbPostsScript(10), "https://www.facebook.com/search/posts?q=carro");
    expect(res.groupPublic).toBe(null);
    expect(res.rows[0]).toMatchObject({
      author: "Pedro Inventado",
      url: "https://www.facebook.com/groups/4242/posts/5555/",
      group: { name: "Carros Exemplo GO", url: "https://www.facebook.com/groups/4242/" },
      text: "Quero comprar um carro em Goiânia até 40 mil",
    });
  });

  test("reports the login wall instead of an empty result", async () => {
    const auth = await runInPage("<html><body>Entrar no Facebook</body></html>", buildFbPostsScript(5), "https://www.facebook.com/login/");
    expect(auth.status).toBe("auth");
  });

  test("tooltip dates become ISO local time", () => {
    expect(parseFbDate("Sábado, 17 de outubro de 2026 às 22:18")).toBe("2026-10-17T22:18");
    expect(parseFbDate("3 de março de 2025")).toBe("2025-03-03");
    expect(parseFbDate("Friday, October 16, 2026 at 9:05 PM")).toBe("2026-10-16T21:05");
    expect(parseFbDate("Friday, October 16, 2026 at 12:30 AM")).toBe("2026-10-16T00:30");
    expect(parseFbDate("ontem")).toBe("ontem");
  });
});

describe("Instagram", () => {
  test("shortcode decodes as base64url digits", () => {
    expect(shortcodeToPk("A")).toBe("0");
    expect(shortcodeToPk("BA")).toBe("64");
    expect(shortcodeToPk("_")).toBe("63");
    expect(() => shortcodeToPk("a+b")).toThrow();
  });

  test("post URLs resolve to the same pk for /p/, /reel/ and profile-scoped links", () => {
    const a = igPostRef("https://www.instagram.com/p/CxYz123AbC_/").pk;
    expect(igPostRef("https://www.instagram.com/reel/CxYz123AbC_/?igsh=1").pk).toBe(a);
    expect(igPostRef("https://www.instagram.com/garagemexemplo/p/CxYz123AbC_/").pk).toBe(a);
    expect(igPostRef("3141592653589").pk).toBe("3141592653589");
    expect(() => igPostRef("https://www.instagram.com/garagemexemplo/")).toThrow();
  });

  test("comments script paginates with next_min_id and stops at the limit", async () => {
    const calls: string[] = [];
    const pages: Record<string, any> = {
      "": { comments: [{ pk: 1, user: { username: "joao" }, text: "valor?", created_at: 1760000000 }], next_min_id: "c2" },
      c2: { comments: [{ pk: 2, user: { username: "maria" }, text: "aceita troca?", created_at: 1760000100 }, { pk: 3, user: { username: "x" }, text: "y", created_at: 1 }] },
    };
    const fakeFetch = async (url: string) => {
      calls.push(url);
      const cursor = new URL(url, "https://www.instagram.com").searchParams.get("min_id") || "";
      return new Response(JSON.stringify(pages[cursor]), { status: 200 });
    };
    const res = await new Function("fetch", `return ${buildIgCommentsScript("42", 2)}`)(fakeFetch);
    expect(res.status).toBe("ok");
    expect(res.rows.map((r: any) => [r.user, r.text])).toEqual([["joao", "valor?"], ["maria", "aceita troca?"]]);
    expect(calls[0]).toContain("/api/v1/media/42/comments/");
    expect(calls[1]).toContain("min_id=c2");
  });

  test("comments script flags an HTML answer instead of crashing", async () => {
    const fakeFetch = async () => new Response("<!DOCTYPE html>", { status: 200 });
    const res = await new Function("fetch", `return ${buildIgCommentsScript("42", 5)}`)(fakeFetch);
    expect(res.status).toBe("not_json");
  });

  test("add-comment script posts as a reply with the csrf token", async () => {
    let sent: any;
    const fakeFetch = async (url: string, init: any) => { sent = { url, init }; return new Response(JSON.stringify({ status: "ok", id: 77 })); };
    const res = await new Function("fetch", "document", `return ${buildIgAddCommentScript("42", "Oi Maria, te chamei no direct", "2")}`)(fakeFetch, { cookie: "ig_did=1; csrftoken=tok123" });
    expect(res).toEqual({ http: 200, ok: true, id: "77" });
    expect(sent.url).toBe("/api/v1/web/comments/42/add/");
    expect(sent.init.headers["x-csrftoken"]).toBe("tok123");
    const body = new URLSearchParams(sent.init.body);
    expect(body.get("comment_text")).toBe("Oi Maria, te chamei no direct");
    expect(body.get("replied_to_comment_id")).toBe("2");
  });

  test("igComment is a dry run unless live is set", async () => {
    const res = await igComment("https://www.instagram.com/p/CxYz123AbC_/", "  Oi! ", { replyTo: "9" });
    expect(res).toMatchObject({ dryRun: true, replyTo: "9", text: "Oi!" });
    await expect(igComment("https://www.instagram.com/p/CxYz123AbC_/", "   ")).rejects.toThrow();
  });
});
