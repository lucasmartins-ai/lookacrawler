import { describe, expect, test } from "bun:test";
import { resolveMapsLeadsBinary, discoverLocalLeads, formatWhatsAppLink } from "./maps-bridge.js";
import { deepEnrichLead } from "./enrichment-bridge.js";

describe("Maps bridge binary resolution", () => {
  test("no absolute developer paths leak into the candidate list", () => {
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