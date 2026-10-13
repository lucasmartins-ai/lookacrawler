import { describe, expect, test } from "bun:test";
import { resolveMapsLeadsBinary, discoverLocalLeads, formatWhatsAppLink, describeWhatsApp } from "./maps-bridge.js";
import { deepEnrichLead } from "./enrichment-bridge.js";

describe("Maps bridge binary resolution", () => {
  test("an explicit path that does not exist resolves to nothing", () => {
    const before = process.env.MAPS_LEADS_BIN;
    process.env.MAPS_LEADS_BIN = "/definitely/not/here/maps-leads";
    // A hardcoded /Users/<name>/... path would resolve on the author's Mac and
    // silently pass CI there while breaking every other clone.
    expect(resolveMapsLeadsBinary()).toBeNull();
    if (before === undefined) delete process.env.MAPS_LEADS_BIN;
    else process.env.MAPS_LEADS_BIN = before;
  });

  test("explicit path wins over env", () => {
    const dir = `${process.env.TMPDIR || "/tmp"}/lookacrawler-maps-test-${process.pid}`;
    require("node:fs").mkdirSync(dir, { recursive: true });
    const bin = `${dir}/maps-leads`;
    require("node:fs").writeFileSync(bin, "#!/bin/sh\n");
    expect(resolveMapsLeadsBinary(bin)).toBe(bin);
    require("node:fs").rmSync(dir, { recursive: true, force: true });
  });

  test("discovery fails gracefully when the binary is missing", async () => {
    const result = await discoverLocalLeads("dental clinic", { customBinaryPath: "/no/such/binary" });
    expect(result.success).toBe(false);
    expect(result.data).toEqual([]);
    expect(result.error).toContain("maps-leads");
  });
});

describe("WhatsApp link formatting", () => {
  test("normalizes international and local formats", () => {
    expect(formatWhatsAppLink("+55 33 99133-9795")).toBe("https://wa.me/5533991339795");
    expect(formatWhatsAppLink("+44 7356 026050")).toBe("https://wa.me/447356026050");
    expect(formatWhatsAppLink("(21) 99876-5432")).toBe("https://wa.me/5521998765432");
    // Already-international BR numbers must not be double-prefixed.
    expect(formatWhatsAppLink("5533991339795")).toBe("https://wa.me/5533991339795");
  });

  // Google Maps listings carry the national long-distance prefix. No E.164
  // number starts with 0, so guessing an area code from that string yields a
  // link that dials nothing — refusing beats shipping a dead wa.me URL.
  test("refuses ambiguous national long-distance numbers", () => {
    expect(formatWhatsAppLink("(011) 99123-4567")).toBeUndefined();
    expect(formatWhatsAppLink("(021) 3333-4444")).toBeUndefined();
  });

  test("does not mistake Brazilian street names for US/UK locations", () => {
    expect(formatWhatsAppLink("(11) 98765-4321", "Rua Augusta, 1500 - Consolação, São Paulo - SP")).toBe(
      "https://wa.me/5511987654321"
    );
    expect(formatWhatsAppLink("(62) 3333-4444", "Av. Industrial, 200 - Setor Industrial, Goiânia - GO")).toBe(
      "https://wa.me/556233334444"
    );
    expect(formatWhatsAppLink("(31) 99876-5432", "Rua Jesus de Nazaré, 10 - Belo Horizonte")).toBe(
      "https://wa.me/5531998765432"
    );
  });

  test("still detects real US and UK locations", () => {
    expect(formatWhatsAppLink("(415) 555-0100", "1 Market St, San Francisco, CA 94105, USA")).toBe(
      "https://wa.me/14155550100"
    );
    expect(formatWhatsAppLink("(212) 555-0100", "350 5th Ave, New York, NY, US")).toBe("https://wa.me/12125550100");
    expect(formatWhatsAppLink("020 7946 0958", "221B Baker St, London NW1 6XE, UK")).toBe("https://wa.me/442079460958");
  });

  test("rejects unusable input instead of emitting a broken link", () => {
    expect(formatWhatsAppLink(undefined)).toBeUndefined();
    expect(formatWhatsAppLink("123")).toBeUndefined();
  });
});

describe("Deep lead enrichment guards", () => {
  test("rejects an invalid website instead of crawling", async () => {
    const result = await deepEnrichLead({ title: "Teste", web_site: "invalid-url" });
    expect(result.enrichmentSuccess).toBe(false);
  });

  test("blocks private network targets (SSRF boundary)", async () => {
    const result = await deepEnrichLead({ title: "Local", web_site: "http://127.0.0.1:8080" });
    expect(result.enrichmentSuccess).toBe(false);
    expect(result.error).toContain("security policy");
  });
});
describe("WhatsApp link details", () => {
  test("the structured country beats address-text heuristics", () => {
    // "London" in a Brazilian street name must not turn this into a UK number.
    expect(formatWhatsAppLink("(11) 98765-4321", "Rua London, 10 - São Paulo", "BR")).toBe(
      "https://wa.me/5511987654321"
    );
    expect(formatWhatsAppLink("020 7946 0958", "221B Baker St", "GB")).toBe("https://wa.me/442079460958");
    expect(formatWhatsAppLink("(415) 555-0100", "1 Market St", "United States")).toBe("https://wa.me/14155550100");
  });

  test("keeps links for landlines but reports the line type", () => {
    const fixed = describeWhatsApp("(62) 3333-4444", undefined, "Brazil");
    expect(fixed?.link).toBe("https://wa.me/556233334444");
    expect(fixed?.type).toBe("fixed");

    const mobile = describeWhatsApp("(62) 99999-9999");
    expect(mobile?.type).toBe("mobile");
    expect(mobile?.e164).toBe("+5562999999999");
  });

  test("refuses document numbers and unknown area codes", () => {
    expect(formatWhatsAppLink("123.456.789-09")).toBeUndefined();
    expect(formatWhatsAppLink("(20) 99876-5432")).toBeUndefined();
    // Bare international digits still work without a "+".
    expect(formatWhatsAppLink("447356026050")).toBe("https://wa.me/447356026050");
  });
});

describe("Maps CLI completion", () => {
  // A stand-in for maps-leads that behaves like the real one on a short result
  // page: it prints its leads, then a child (the browser) keeps stdout open and
  // the process never exits on its own.
  const fakeBinary = (dir: string, lines: object[]) => {
    const path = `${dir}/fake-maps-leads`;
    const out = lines.map((l) => JSON.stringify(l)).join("\n");
    Bun.write(path, `#!/bin/sh\nprintf '%s\\n' '${out.replace(/'/g, "'\\''")}'\nsleep 600 &\necho $! > "${dir}/grandchild.pid"\nwait\n`);
    require("node:fs").chmodSync(path, 0o755);
    return path;
  };

  test("finishes on inactivity even when the scraper hangs, and kills its whole process group", async () => {
    const dir = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/maps-fake-`);
    const bin = fakeBinary(dir, [
      { title: "Loja A", phone: "+55 62 99999-0001", cid: "1", place_id: "ChIJ_test_A", link_sources: [{ link: "https://api.whatsapp.com/send?phone=5562999990001", source: "x" }] },
      { title: "Loja B", phone: "+55 62 3000-1000", cid: "2" },
    ]);
    const started = Date.now();
    const res = await discoverLocalLeads("lojas", { customBinaryPath: bin, preferDaemon: false, limit: 20, idleMs: 400, timeoutMs: 20000 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.success).toBe(true);
    expect(res.data.map((l) => l.title)).toEqual(["Loja A", "Loja B"]);
    // Declared on the Google listing vs built from the listing phone.
    expect(res.data[0].whatsapp_source).toBe("google");
    expect(res.data[1].whatsapp_source).toBe("phone");
    expect(res.data[1].phone_type).toBe("fixed");
    expect(res.data[0].place_id).toBe("ChIJ_test_A");
    await Bun.sleep(200);
    const pid = Number(require("node:fs").readFileSync(`${dir}/grandchild.pid`, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow(); // the "browser" is gone too
  });

  test("scrolls one page by default: -depth 2+ kills the scraper's browser", async () => {
    const dir = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/maps-fake-`);
    const path = `${dir}/echo-args`;
    // Prints its own argv as the lead title, then exits.
    Bun.write(path, `#!/bin/sh\nprintf '{"title":"%s","cid":"1"}\\n' "$*"\n`);
    require("node:fs").chmodSync(path, 0o755);
    const res = await discoverLocalLeads("lojas", { customBinaryPath: path, preferDaemon: false, limit: 20, idleMs: 300 });
    expect(res.data[0].title).toContain("-depth 1 ");
  });

  test("an empty run that logged scraper errors is a failure, not an empty success", async () => {
    const dir = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/maps-fake-`);
    const path = `${dir}/crashing`;
    Bun.write(path, `#!/bin/sh\necho '{"level":"error","error":"playwright: target closed","message":"error while processing job"}' >&2\nexit 0\n`);
    require("node:fs").chmodSync(path, 0o755);
    const res = await discoverLocalLeads("lojas", { customBinaryPath: path, preferDaemon: false });
    expect(res.success).toBe(false);
    expect(res.error).toContain("target closed");
  });

  test("a search with no results is an empty success, not a failure", async () => {
    const dir = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/maps-fake-`);
    const path = `${dir}/nothing-found`;
    Bun.write(path, `#!/bin/sh\necho '{"level":"error","error":"inactivity timeout: 0001-01-01T00:00:00Z","message":"scrapemate exited"}' >&2\nexit 0\n`);
    require("node:fs").chmodSync(path, 0o755);
    const res = await discoverLocalLeads("lojas", { customBinaryPath: path, preferDaemon: false });
    expect(res.success).toBe(true);
    expect(res.data).toEqual([]);
    expect(res.error).toBeUndefined();
  });

  test("a timeout returns what arrived instead of hanging", async () => {
    const dir = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/maps-fake-`);
    const bin = fakeBinary(dir, [{ title: "Loja C", cid: "3" }]);
    const res = await discoverLocalLeads("lojas", { customBinaryPath: bin, preferDaemon: false, idleMs: 60000, timeoutMs: 800 });
    expect(res.data.map((l) => l.title)).toEqual(["Loja C"]);
    expect(res.success).toBe(true);
  });
});
