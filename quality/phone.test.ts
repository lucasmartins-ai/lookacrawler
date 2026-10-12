import { describe, expect, test } from "bun:test";
import { classifyBrazilian, countryToRegion, findPhones, normalizePhone, phoneKey } from "./phone.js";

describe("Phone normalization (quality/phone.ts)", () => {
  test("normalizes Brazilian mobile and fixed lines to E.164", () => {
    const mobile = normalizePhone("(62) 99999-9999");
    expect(mobile?.e164).toBe("+5562999999999");
    expect(mobile?.type).toBe("mobile");
    expect(mobile?.valid).toBe(true);
    expect(mobile?.national).toBe("(62) 99999-9999");
    expect(mobile?.international).toBe("+55 62 99999 9999");

    const fixed = normalizePhone("+55 (11) 3333-4444");
    expect(fixed?.e164).toBe("+551133334444");
    expect(fixed?.type).toBe("fixed");
    expect(fixed?.valid).toBe(true);
  });

  test("tel:, formatted and international spellings share one key", () => {
    const keys = ["tel:+5562999999999", "(62) 99999-9999", "+55 62 99999-9999", "62 99999.9999"].map((p) =>
      phoneKey(p)
    );
    expect(new Set(keys)).toEqual(new Set(["+5562999999999"]));
  });

  test("rejects CPF, CNPJ, CEP, money, year ranges and ids", () => {
    expect(normalizePhone("123.456.789-09")).toBeNull();
    expect(normalizePhone("12.345.678/0001-95")).toBeNull();
    expect(normalizePhone("74000-000")).toBeNull();
    expect(normalizePhone("74.000-000")).toBeNull();
    expect(normalizePhone("1.234.567")).toBeNull();
    expect(normalizePhone("R$ 1.234.567,00")).toBeNull();
    expect(normalizePhone("2019-2026")).toBeNull();
    expect(normalizePhone("10/10/2026")).toBeNull();
    // Unix timestamps and long ids in page text
    expect(normalizePhone("1712345678")).toBeNull();
    expect(normalizePhone("1712345678901")).toBeNull();
    expect(normalizePhone("12345678909")).toBeNull();
    expect(normalizePhone("123")).toBeNull();
  });

  test("rejects a bare 11-digit CPF that looks like a mobile, keeps formatted numbers", () => {
    // Valid CPF check digits, DDD 11 and a 9 in third position.
    expect(normalizePhone("11945678941")).toBeNull();
    expect(normalizePhone("11945678941", { context: "maps" })).toBeNull();
    expect(normalizePhone("(11) 94567-8941")?.e164).toBe("+5511945678941");
    expect(normalizePhone("tel:11945678941", { context: "tel" })?.e164).toBe("+5511945678941");
    // Same shape without valid CPF check digits stays a mobile.
    expect(normalizePhone("11945678900")?.e164).toBe("+5511945678900");
  });

  test("bare digits are accepted from explicit links", () => {
    expect(normalizePhone("5511988887777", { context: "whatsapp" })?.e164).toBe("+5511988887777");
    expect(normalizePhone("1133334444", { context: "tel" })?.type).toBe("fixed");
    // In free text the same 11-digit mobile shape is still accepted.
    expect(normalizePhone("62999999999")?.e164).toBe("+5562999999999");
  });

  test("marks unknown DDDs and impossible subscriber ranges invalid", () => {
    expect(normalizePhone("(20) 99876-5432")?.valid).toBe(false);
    expect(phoneKey("(20) 99876-5432")).toBeNull();
    expect(phoneKey("(62) 1234-5678")).toBeNull();
  });

  test("upgrades pre-2016 8-digit mobiles with the leading 9", () => {
    const old = normalizePhone("(62) 8999-9999");
    expect(old?.e164).toBe("+5562989999999");
    expect(old?.type).toBe("mobile");
  });

  test("handles other regions through defaultRegion", () => {
    const uk = normalizePhone("020 7946 0958", { defaultRegion: "GB" });
    expect(uk?.e164).toBe("+442079460958");
    expect(uk?.type).toBe("fixed");
    expect(normalizePhone("+44 7356 026050")?.type).toBe("mobile");
  });

  test("maps structured country fields to regions", () => {
    expect(countryToRegion("BR")).toBe("BR");
    expect(countryToRegion("Brasil")).toBe("BR");
    expect(countryToRegion("United States")).toBe("US");
    expect(countryToRegion("uk")).toBe("GB");
    expect(countryToRegion("Atlantis")).toBeUndefined();
    expect(countryToRegion(undefined)).toBeUndefined();
  });

  test("classifies Brazilian national numbers", () => {
    expect(classifyBrazilian("62999999999")).toBe("mobile");
    expect(classifyBrazilian("6233334444")).toBe("fixed");
    expect(classifyBrazilian("6263334444")).toBeNull();
    expect(classifyBrazilian("2099999999")).toBeNull();
  });
});

describe("Phone scanning in text (findPhones)", () => {
  test("finds phones and skips document numbers next to them", () => {
    const text =
      "Ligue (62) 99999-9999 ou +55 62 3333-4444. CNPJ 12.345.678/0001-95, CPF 123.456.789-09, " +
      "CEP 74000-000. Desde 2019-2026. Preço R$ 1.234.567,00. Pedido 1712345678901.";
    const found = findPhones(text).map((p) => p.e164);
    expect(found).toEqual(["+5562999999999", "+556233334444"]);
  });

  test("dedupes the same number written twice", () => {
    const found = findPhones("Tel: (62) 99999-9999 / WhatsApp: 62 99999-9999");
    expect(found.length).toBe(1);
  });

  test("scans long digit-heavy text in linear time", () => {
    const text = "1234-5678.".repeat(20000) + " 9".repeat(20000);
    const started = performance.now();
    findPhones(text);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("ignores bare digit runs labelled as identifiers", () => {
    const text = "Protocolo 12945678909 · Pedido nº 11987654321 · código: 21987654321 · Ligue 11987654321";
    expect(findPhones(text).map((p) => p.e164)).toEqual(["+5511987654321"]);
    // Formatted numbers survive an identifier-looking word before them.
    expect(findPhones("Pedidos: (11) 98765-4321").map((p) => p.e164)).toEqual(["+5511987654321"]);
  });
});
