import { describe, expect, test } from "bun:test";
import { classifyFailure, failureEnvelope } from "./errors";
import { documentToMarkdown, fetchDocument, guardRefusal, processHtmlToMarkdown } from "./extractor";
import { BLOCKED_HEADER, BLOCKED_TOKEN } from "./egress-guard";

/** Smallest valid one-page PDF showing `text`, with a correct xref table. */
function tinyPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

describe("failure classification", () => {
  test.each([
    ["getaddrinfo ENOTFOUND zetlandvets.com", "dead_domain"],
    ["getaddrinfo EAI_AGAIN example.com", "connection_failed"],
    ["Requests to private or local hosts are not allowed", "blocked_private"],
    ["The socket connection was closed unexpectedly.", "connection_failed"],
    ["Connection to a.co.uk failed (refused or reset by the site)", "connection_failed"],
    ["Connection to enotfound.example failed (refused or reset by the site)", "connection_failed"],
    ["Connection to x.co.uk failed: redirect target does not resolve", "connection_failed"],
    ["Request timed out after 10000ms", "timeout"],
    ["Anti-Bot protection triggered: HTTP Status 403", "anti_bot"],
    ["HTTP 404: Not Found", "http_error"],
    ["HTTP 502: DNS lookup failed", "http_error"],
    ["Target URL is invalid", "invalid_input"],
    ["something else", "error"],
  ])("%s -> %s", (message, status) => {
    expect(classifyFailure(new Error(message))).toBe(status as any);
  });

  test("envelope carries ok:false, status and reason", () => {
    expect(failureEnvelope(new Error("HTTP 404: Not Found"), { url: "u" })).toEqual({
      ok: false,
      status: "http_error",
      reason: "HTTP 404: Not Found",
      url: "u",
    });
  });
});

describe("egress guard refusals keep their real reason", () => {
  const guardAnswer = (status: number, body = "") =>
    new Response(body, { status, headers: { [BLOCKED_HEADER]: BLOCKED_TOKEN } });

  test("502 is a failed connection, not a private host", async () => {
    const err = await guardRefusal(guardAnswer(502), "http://shop.example.co.uk/");
    expect(err.message).toContain("Connection to shop.example.co.uk failed");
    expect(classifyFailure(err)).toBe("connection_failed");
  });

  test("403 with a resolver error reports a dead domain", async () => {
    const err = await guardRefusal(guardAnswer(403, JSON.stringify({ error: "getaddrinfo ENOTFOUND gone.example" })), "http://gone.example/");
    expect(classifyFailure(err)).toBe("dead_domain");
  });

  test("403 for a private address still says so", async () => {
    const err = await guardRefusal(
      guardAnswer(403, JSON.stringify({ error: "Requests to private or local hosts are not allowed" })),
      "http://10.0.0.1/"
    );
    expect(classifyFailure(err)).toBe("blocked_private");
  });
});

describe("a site cannot forge the guard header", () => {
  test("upstream 502 with x-lookacrawler-blocked stays an HTTP error", async () => {
    process.env.LOOKACRAWLER_ALLOW_LOCAL = "true";
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ error: "getaddrinfo ENOTFOUND lead.example" }), { status: 502, headers: { [BLOCKED_HEADER]: "1" } }),
    });
    try {
      const err = (await fetchDocument(`http://localhost:${server.port}/`).catch((e) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).not.toContain("ENOTFOUND");
      expect(classifyFailure(err)).toBe("http_error");
    } finally {
      delete process.env.LOOKACRAWLER_ALLOW_LOCAL;
      server.stop(true);
    }
  });
});

describe("tables without rows", () => {
  // turndown-plugin-gfm read table.rows[0] unguarded and threw "tr.parentNode".
  test("an empty <table> does not crash the conversion", () => {
    const html = `<html><body><div id="m"><table></table><p>Back on track physio</p></div></body></html>`;
    expect(processHtmlToMarkdown(html, { url: "https://x.test/", cssSelector: "#m" })).toContain("Back on track physio");
  });

  test("tables with rows still render as GFM", () => {
    const html = `<html><body><div id="m"><table><tr><th>Day</th></tr><tr><td>Mon</td></tr></table></div></body></html>`;
    expect(processHtmlToMarkdown(html, { url: "https://x.test/", cssSelector: "#m" })).toContain("| Day |");
  });
});

describe("content-type routing", () => {
  const doc = (text: string, contentType: string, bytes: Buffer = Buffer.from(text)) => ({ text, bytes, contentType });

  test("markdown passes through with its code fences", async () => {
    const md = "# Title\n\n```bash\ncargo install x\n```\n";
    expect(await documentToMarkdown(doc(md, "text/markdown; charset=utf-8"), { url: "https://x.test/r.md" })).toBe(md.trim());
  });

  test("plain text passes through", async () => {
    expect(await documentToMarkdown(doc("line 1\r\nline 2", "text/plain"), { url: "https://x.test/a.txt" })).toBe("line 1\nline 2");
  });

  test("PDF text is extracted, by type or by magic bytes", async () => {
    const pdf = tinyPdf("Opening hours Mon to Fri");
    for (const type of ["application/pdf", "application/octet-stream", "text/plain"]) {
      expect(await documentToMarkdown(doc("", type, pdf), { url: "https://x.test/menu.pdf" })).toContain("Opening hours Mon to Fri");
    }
  });

  test("a broken PDF fails once as parse_error", async () => {
    const err = (await documentToMarkdown(doc("", "application/pdf", Buffer.from("%PDF-1.4\ngarbage")), { url: "https://x.test/b.pdf" }).catch((e) => e)) as Error;
    expect(err.message).toStartWith("PDF could not be parsed");
    expect(classifyFailure(err)).toBe("parse_error");
  });

  test("HTML still goes through the HTML pipeline", async () => {
    const html = `<html><body><article><h1>Clinic</h1><p>${"Real text here. ".repeat(20)}</p></article></body></html>`;
    const out = await documentToMarkdown(doc(html, "text/html"), { url: "https://x.test/" });
    expect(out).toContain("Real text here.");
    expect(out).not.toContain("<p>");
  });
});

describe("CLI exit codes", () => {
  const cli = (...args: string[]) =>
    Bun.spawnSync(["bun", "cli.ts", ...args], { cwd: import.meta.dir, env: { ...process.env } });

  test("enrich on a dead domain exits 1 and says why", () => {
    // .invalid never resolves (RFC 2606).
    const r = cli("enrich", "https://lookacrawler-p0.invalid/");
    const out = JSON.parse(r.stdout.toString());
    expect(r.exitCode).toBe(1);
    expect(out.enrichmentSuccess).toBe(false);
    expect(out.status).toBe("dead_domain");
    expect(out.error).toStartWith("Website unreachable");
  });

  test("extract --json failure prints an envelope and exits 1", () => {
    const r = cli("extract", "https://lookacrawler-p0.invalid/", "--json", "--no-cache");
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout.toString());
    expect(out).toMatchObject({ ok: false, status: "dead_domain", url: "https://lookacrawler-p0.invalid/" });
  });
});
