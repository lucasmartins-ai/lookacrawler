import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectLocale, draftOutreach, runGtmPipeline, writeGtmSink } from "./gtm-pipeline.js";
import type { GoogleMapsLead } from "./maps-bridge.js";

const SITE = `<!doctype html><html><head><title>Acme</title></head><body>
<main><h1>Acme Dental</h1><p>${"Atendimento odontológico completo com equipe especializada. ".repeat(6)}</p></main>
<footer><a href="mailto:contato@acme.example">contato@acme.example</a></footer></body></html>`;

describe("gtm pipeline (offline)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let siteUrl: string;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-gtm-test-"));
  beforeAll(() => {
    process.env.LOOKACRAWLER_ALLOW_LOCAL = "true";
    server = Bun.serve({ port: 0, fetch: () => new Response(SITE, { headers: { "content-type": "text/html" } }) });
    siteUrl = `http://localhost:${server.port}/`;
  });
  afterAll(() => {
    delete process.env.LOOKACRAWLER_ALLOW_LOCAL;
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (leads: GoogleMapsLead[], extra = {}) =>
    runGtmPipeline({ niche: "dentista", location: "Goiania", limit: 5, ...extra, discover: async () => ({ data: leads, total: leads.length }) });

  test("discover -> enrich -> draft, keeping leads without a website", async () => {
    const r = await run([
      { title: "Acme Dental", web_site: siteUrl, address: "Rua 1, Setor Bueno, Goiânia - GO", review_rating: 4.8, review_count: 90, phone: "(62) 3333-4444" },
      { title: "Sem Site", phone: "(62) 99999-9999", whatsapp_link: "https://wa.me/5562999999999" },
    ]);
    expect(r.query).toBe("dentista Goiania");
    expect(r.totalDiscovered).toBe(2);
    expect(r.totalEnriched).toBe(1);
    const [a, b] = r.items;
    expect(a.emails).toEqual(["contato@acme.example"]);
    expect(a.channel).toBe("EMAIL");
    expect(a.destination).toBe("contato@acme.example");
    expect(a.outreachCopy).toContain("Acme Dental em Goiânia (nota 4.8★, 90 avaliações no Google)");
    expect(a.locale).toBe("pt");
    expect(a.slopScore).toBe(0);
    expect(b.channel).toBe("WHATSAPP");
    expect(b.enrichmentSuccess).toBe(false);
    expect(b.domain).toBe("sem-site.surrogate");
  });

  test("an English-speaking lead gets an English draft; --offer is used verbatim", () => {
    const lead = { title: "Bright Smile", emails: ["hi@bright.example"], socialLinks: {}, additionalPhones: [], decisionMakers: [], markdownSummary: "", estimatedTokens: 0, sourcePagesCrawled: [], enrichmentSuccess: true };
    const d = draftOutreach(lead, { title: "Bright Smile", complete_address: { country: "GB", city: "Bristol" } }, { niche: "dentist", offer: "review-request texts" });
    expect(d.locale).toBe("en");
    expect(d.copy).toContain("Bright Smile in Bristol");
    expect(d.copy).toContain("review-request texts");
    expect(detectLocale(undefined, "10 High St, Bristol BS1 4DJ")).toBe("en");
    expect(detectLocale(undefined, "Rua 1, Goiânia - GO")).toBe("pt");
  });

  test("writes JSONL, and CSV that neutralises formulas", async () => {
    const r = await run([{ title: "=HYPERLINK(\"http://evil\")", phone: "(62) 3333-4444" }]);
    const jsonl = path.join(dir, "out.jsonl");
    await writeGtmSink(jsonl, r.items);
    const lines = fs.readFileSync(jsonl, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).title).toBe('=HYPERLINK("http://evil")');

    const csv = path.join(dir, "out.csv");
    await writeGtmSink(csv, r.items);
    const text = fs.readFileSync(csv, "utf8");
    expect(text.split("\r\n")[0]).toStartWith("title,domain,website");
    expect(text).toContain(`"'=HYPERLINK`);
  });
});

test("only BR/PT leads get Portuguese drafts", () => {
  const lead = (country: string) => ({ complete_address: { country } }) as never;
  expect(detectLocale(lead("BR"))).toBe("pt");
  expect(detectLocale(lead("ES"))).toBe("en");
});
