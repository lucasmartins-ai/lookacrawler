import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { analyzeCompetitors, auditHtml, extractDomain } from "./competitor-intelligence.js";
import { generateGrowthPlan } from "./growth-planner.js";
import type { GoogleMapsLead } from "./maps-bridge.js";

const GOOD = `<!doctype html><html lang="pt-BR"><head>
<title>Studio Sorriso | Odontologia em Goiânia</title>
<meta name="description" content="Clínica odontológica em Goiânia com implantes, clareamento e ortodontia. Agende pelo WhatsApp em minutos.">
<meta property="og:title" content="Studio Sorriso"><link rel="canonical" href="https://studio.example/">
<meta name="viewport" content="width=device-width">
<script type="application/ld+json">{"@type":"Dentist"}</script>
</head><body>
<h1>Odontologia em Goiânia</h1>
<h2>Nossos serviços</h2><ul><li>Implantes dentários</li><li>Clareamento a laser</li></ul>
<a href="https://wa.me/5562999999999">Fale no WhatsApp</a>
<a href="/agendar">Agendar consulta</a>
<p>Telefone: (62) 3333-4444. contato@studio.example</p>
<img src="a.png" alt="Fachada">
<form action="/c"><input name="n"></form>
</body></html>`;

const BARE = `<html><head></head><body><div>Welcome</div><h1>A</h1><h1>B</h1></body></html>`;

describe("extractDomain", () => {
  test("hostname without www, surrogate when there is no site", () => {
    expect(extractDomain("https://www.Example.com/x")).toBe("example.com");
    expect(extractDomain("example.org")).toBe("example.org");
    expect(extractDomain(undefined, "Clínica Ágil")).toBe("clinica-agil.surrogate");
  });
});

describe("auditHtml", () => {
  const good = auditHtml(GOOD, "https://studio.example/");
  test("a complete page scores high and reports few issues", () => {
    expect(good.seoScore).toBeGreaterThanOrEqual(85);
    expect(good.seoIssues.length).toBeLessThanOrEqual(2);
    expect(good.meta.h1s).toEqual(["Odontologia em Goiânia"]);
    expect(good.companyName).toBe("Studio Sorriso");
  });
  test("reads conversion channels", () => {
    expect(good.conversion.hasWhatsApp).toBe(true);
    expect(good.conversion.hasOnlineBooking).toBe(true);
    expect(good.conversion.bookingUrl).toBe("/agendar");
    expect(good.conversion.hasPhone).toBe(true);
    expect(good.conversion.email).toBe("contato@studio.example");
    expect(good.conversion.hasContactForm).toBe(true);
  });
  test("lists services from a services heading", () => {
    expect(good.services).toEqual(["Implantes dentários", "Clareamento a laser"]);
  });
  test("a bare page lists concrete issues and low maturity", () => {
    const bare = auditHtml(BARE, "http://bare.example/");
    expect(bare.seoScore).toBeLessThan(30);
    expect(bare.seoIssues).toContain("missing <title>");
    expect(bare.seoIssues).toContain("not served over https");
    expect(bare.seoIssues.some((i) => i.includes("2 <h1>"))).toBe(true);
    expect(bare.digitalMaturity).toBeLessThan(good.digitalMaturity);
    expect(bare.conversion.hasWhatsApp).toBe(false);
  });
});

describe("analyzeCompetitors + generateGrowthPlan (offline)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let siteUrl: string;
  beforeAll(() => {
    process.env.LOOKACRAWLER_ALLOW_LOCAL = "true";
    server = Bun.serve({ port: 0, fetch: () => new Response(BARE, { headers: { "content-type": "text/html" } }) });
    siteUrl = `http://localhost:${server.port}/`;
  });
  afterAll(() => {
    delete process.env.LOOKACRAWLER_ALLOW_LOCAL;
    server.stop(true);
  });

  const leads = (): GoogleMapsLead[] => [
    { title: "Rival Um", web_site: siteUrl, review_rating: 4.9, review_count: 120 },
    { title: "Rival Dois", review_rating: 4.1, review_count: 10 },
  ];

  test("reviews competitors from injected leads and derives gaps", async () => {
    const audit = auditHtml(GOOD, "https://studio.example/");
    const a = await analyzeCompetitors(audit, "dentista", "Goiânia", { competitors: leads(), locale: "pt" });
    expect(a.competitors).toHaveLength(2);
    const [one, two] = a.competitors;
    expect(one.siteReviewed).toBe(true);
    expect(one.strengths[0]).toContain("Boa reputação");
    expect(one.weaknesses).toContain("Sem agendamento online no site");
    expect(two.siteReviewed).toBe(false);
    expect(two.weaknesses).toContain("Sem site próprio (só a ficha do Google)");
    expect(a.marketGaps.conversionGaps[0]).toBe("2 de 2 concorrentes sem agendamento online");
    expect(a.marketGaps.positioningAdvantage).toContain("Studio Sorriso");
  });

  test("the plan is niche-driven, lint-clean, cites only observed numbers, and honours locale", async () => {
    const audit = auditHtml(GOOD, "https://studio.example/");
    for (const locale of ["pt", "en"] as const) {
      const a = await analyzeCompetitors(audit, "dentista", "Goiânia", { competitors: leads(), locale });
      const plan = generateGrowthPlan(a);
      expect(plan.weeklyContentPlan).toHaveLength(5);
      expect(plan.outreachPlaybook.map((s) => s.channel)).toEqual(["WhatsApp", "Instagram DM", "FollowUp", "Email"]);
      expect(plan.verification.allPassedAntiSlop).toBe(true);
      expect(plan.seo.keywords[0].keyword).toBe(locale === "pt" ? "dentista em Goiânia" : "dentista in Goiânia");
      const all = JSON.stringify(plan);
      expect(all).toContain("Implantes dentários");
      // The fork's invented figures and clinic-only wording must be gone.
      expect(all).not.toMatch(/90%|95%|93%|300 pacientes|clínica|clinic\b|paciente|patient/i);
      expect(all).toContain(locale === "pt" ? "[inclua um número real" : "[add a real number");
    }
  });

  test("no reviewable competitors is reported as unknown, not as 'they cover the basics'", async () => {
    const audit = auditHtml(GOOD, "https://studio.example/");
    const a = await analyzeCompetitors(audit, "dentista", "Goiânia", { competitors: [], locale: "en" });
    expect(a.marketGaps.conversionGaps).toEqual(["their websites could not be reviewed in this scan"]);
    expect(generateGrowthPlan(a).weeklyContentPlan[0].proof).toContain("We looked at 0 local competitors");
  });

  test("WhatsApp is only claimed when the audit saw it", async () => {
    const audit = auditHtml(BARE, "https://bare.example/");
    expect(audit.conversion.hasWhatsApp).toBe(false);
    const plan = generateGrowthPlan(await analyzeCompetitors(audit, "dentista", "Goiânia", { competitors: [], locale: "pt" }));
    expect(plan.weeklyContentPlan[0].mechanism).toContain("[seu canal de atendimento]");
    expect(JSON.stringify(plan.seo)).not.toContain("WhatsApp");
  });
});
