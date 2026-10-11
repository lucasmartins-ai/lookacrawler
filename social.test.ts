import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import {
  buildFbPostsScript,
  buildFbSearchScript,
  buildIgAddCommentScript,
  buildIgCommentsScript,
  igComment,
  igPostRef,
  shortcodeToPk,
} from "./social.js";

/** Run a page script inside a JSDOM window, as CDP_EVAL would in Chrome. */
function runInPage(html: string, script: string, url = "https://www.facebook.com/groups/carrosexemplo"): any {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  return dom.window.eval(script);
}

const post = (id: string, author: string, text: string, extra = "") => `
  <div role="article">
    <h3><a href="https://www.facebook.com/profile.php?id=${id}" role="link">${author}</a></h3>
    <a href="https://www.facebook.com/groups/carrosexemplo/posts/${id}/?__cft__=x">2 h</a>
    <div aria-label="Ações para esta publicação"></div>
    <div dir="auto">${text}</div>
    <div dir="auto">12 comentários</div>
    <div aria-label="Curtir"></div><div aria-label="Comentar"></div>
    ${extra}
  </div>`;

const GROUP_PT = `<html><body><div role="main"><div role="feed">
  ${post("111", "Carlos Lima", "Procuro HB20 ou Onix até 60 mil, à vista",
    `<div role="article"><a href="https://www.facebook.com/profile.php?id=999" role="link">Ana Souza</a><div dir="auto">tbm to procurando, chama no zap</div></div>`)}
  ${post("222", "Garagem Exemplo", "Vendo Gol 2015 completo, aceito troca")}
  <div role="article"><a href="https://www.facebook.com/ads" role="link">Loja X</a><div dir="auto">Patrocinado</div><div dir="auto">Compre já seu carro</div></div>
  <div dir="auto">58210347766</div>
</div></div></body></html>`;

describe("Facebook posts extractor (pt-BR)", () => {
  const res = runInPage(GROUP_PT, buildFbPostsScript(10));

  test("finds real posts with author, full text and canonical post URL", () => {
    expect(res.status).toBe("ok");
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({
      author: "Carlos Lima",
      url: "https://www.facebook.com/groups/carrosexemplo/posts/111/",
    });
    expect(res.rows[0].text).toContain("Procuro HB20 ou Onix até 60 mil");
  });

  test("keeps comment text out of the post body and returns it separately", () => {
    expect(res.rows[0].text).not.toContain("chama no zap");
    expect(res.rows[0].comments).toEqual([
      { author: "Ana Souza", authorUrl: "https://www.facebook.com/profile.php", text: "tbm to procurando, chama no zap" },
    ]);
  });

  test("drops sponsored posts, metrics and decoy digit nodes", () => {
    expect(res.rows.some((r: any) => /Compre já/.test(r.text))).toBe(false);
    expect(res.rows[0].text).not.toContain("comentários");
    expect(JSON.stringify(res.rows)).not.toContain("58210347766");
  });

  test("reports the login wall instead of an empty result", () => {
    const auth = runInPage("<html><body>Entrar no Facebook</body></html>", buildFbPostsScript(5), "https://www.facebook.com/login/");
    expect(auth.status).toBe("auth");
  });
});

describe("Facebook search extractor", () => {
  test("keeps entity links, drops search decoys and tracking params", () => {
    const html = `<html><body><div role="feed">
      <div><a href="https://www.facebook.com/groups/carrosexemplo2/">Carros Compra e Venda</a> Grupo público · 45 mil membros</div>
      <div><a href="https://www.facebook.com/search/top?q=x">s e a r c h</a></div>
      <div><a href="https://www.facebook.com/permalink.php?story_fbid=55&id=7&__cft__=abc">Alguém vende Strada usada?</a> pago à vista</div>
    </div></body></html>`;
    const res = runInPage(html, buildFbSearchScript(10));
    expect(res.rows.map((r: any) => r.url)).toEqual([
      "https://www.facebook.com/groups/carrosexemplo2/",
      "https://www.facebook.com/permalink.php?story_fbid=55&id=7",
    ]);
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
