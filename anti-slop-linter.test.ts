import { describe, expect, test } from "bun:test";
import { lintAntiSlop, sanitizeCopy } from "./anti-slop-linter.js";

describe("lintAntiSlop", () => {
  test("empty text is clean", () => {
    const r = lintAntiSlop("   ");
    expect(r.isSlop).toBe(false);
    expect(r.slopScore).toBe(0);
  });

  test("flags pt-BR slop with the matched text and a suggestion", () => {
    const r = lintAntiSlop("No mundo dinâmico de hoje, nossa solução revolucionária vai elevar seu negócio ao próximo nível.");
    expect(r.isSlop).toBe(true);
    expect(r.violationsCount).toBeGreaterThanOrEqual(3);
    expect(r.violations.every((v) => v.suggestion.length > 0)).toBe(true);
    expect(r.violations.map((v) => v.matched.toLowerCase())).toContain("revolucionária");
  });

  test("flags English slop", () => {
    const r = lintAntiSlop("Let's delve into this game-changer and unlock the potential of your team.", "en");
    expect(r.violationsCount).toBeGreaterThanOrEqual(3);
  });

  test("language rules are scoped", () => {
    expect(lintAntiSlop("vamos mergulhar fundo", "en").violationsCount).toBe(0);
    expect(lintAntiSlop("vamos mergulhar fundo", "pt").violationsCount).toBeGreaterThan(0);
  });

  test("flags the false antithesis in both languages", () => {
    const pt = lintAntiSlop("Não se trata apenas de preço, mas sim de confiança.");
    expect(pt.violations.some((v) => v.category === "false_antithesis")).toBe(true);
    const en = lintAntiSlop("It's not just about price, it's about trust.");
    expect(en.violations.some((v) => v.category === "false_antithesis")).toBe(true);
  });

  test("plain, concrete copy scores zero", () => {
    const r = lintAntiSlop("Atendemos 12 clientes por semana. Resposta no WhatsApp em até 5 minutos.");
    expect(r.slopScore).toBe(0);
    expect(r.metrics.hasConcreteGrounding).toBe(true);
  });

  test("long text without any number is a grounding violation", () => {
    const r = lintAntiSlop("palavra ".repeat(90));
    expect(r.violations.some((v) => v.category === "hollow_claim")).toBe(true);
  });

  test("emoji spam is a formatting violation", () => {
    const r = lintAntiSlop("Oferta especial para você hoje mesmo 🎉🎉🎉🎉🎉 venha conferir agora mesmo nossa loja completa 🔥🔥🔥 e aproveite muito os nossos preços com bastante tempo ainda");
    expect(r.violations.some((v) => v.category === "formatting")).toBe(true);
  });

  test("is stateless across calls (global regexes are cloned)", () => {
    const text = "Uma solução revolucionária.";
    expect(lintAntiSlop(text).violationsCount).toBe(lintAntiSlop(text).violationsCount);
  });
});

describe("sanitizeCopy", () => {
  test("drops throat-clearing openings and swaps buzzwords", () => {
    expect(sanitizeCopy("No cenário atual, um método revolucionário.")).toBe("um método eficiente.");
    expect(sanitizeCopy("In today's fast-paced world, we ship.")).toBe("we ship.");
  });
});

test("accented 'É importante notar que' is flagged and stripped", () => {
  expect(lintAntiSlop("É importante notar que o preço caiu.", "pt").violations.length).toBeGreaterThan(0);
  expect(sanitizeCopy("É importante notar que o preço caiu.")).toBe("o preço caiu.");
});
