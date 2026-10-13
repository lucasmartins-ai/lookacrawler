import { describe, expect, test } from "bun:test";
import { scoreCarPurchaseIntent, scorePurchaseIntent, scoreSocialItems } from "./purchase-intent.js";

describe("scoreCarPurchaseIntent (pt-BR)", () => {
  test.each([
    "Procuro HB20 ou Onix até 60 mil, pago à vista",
    "alguém vendendo uma strada? to precisando pra trabalhar",
    "Quero comprar um carro até 40 mil, alguém indica?",
    "Estou procurando SUV seminovo, tenho 20 mil de entrada",
    "compro carro com documento atrasado",
  ])("buyer: %s", (text) => {
    const r = scoreCarPurchaseIntent(text);
    expect(r.kind).toBe("buyer");
    expect(r.isLead).toBe(true);
  });

  test.each(["Valor?", "quanto tá?", "ainda disponível?", "aceita troca?", "faz financiamento?", "tenho interesse, me chama no zap"])(
    "price/availability question in a comment: %s",
    (text) => {
      const r = scoreCarPurchaseIntent(text);
      expect(r.kind).toBe("price_question");
      expect(r.isLead).toBe(true);
    },
  );

  test.each([
    "Vendo Gol 2015 completo, aceito troca. Valor: R$ 38.000",
    "VENDE-SE Corolla 2018, IPVA pago, chama no direct",
    "Repasse Onix 2020 abaixo da fipe",
    "Temos em estoque Compass 2021, financiamos em até 60x",
  ])("seller ad is not a lead: %s", (text) => {
    const r = scoreCarPurchaseIntent(text);
    expect(r.kind).toBe("seller");
    expect(r.isLead).toBe(false);
  });

  test("a seller who is also buying (trade-in) is a buyer", () => {
    expect(scoreCarPurchaseIntent("Vendo meu Gol e procuro um SUV até 90 mil").kind).toBe("buyer");
  });

  test("'procuro' without any car context is not a car buyer", () => {
    expect(scoreCarPurchaseIntent("procuro emprego de vendedor").isLead).toBe(false);
    expect(scoreCarPurchaseIntent("bom dia grupo").kind).toBe("none");
  });

  test("a model year is not a budget", () => {
    expect(scoreCarPurchaseIntent("procuro carro até 2015").budget).toBeNull();
    expect(scoreCarPurchaseIntent("procuro carro até R$ 45.000").budget).toBe(45000);
    expect(scoreCarPurchaseIntent("alguém vende up ate 35k").budget).toBe(35000);
  });

  test.each(["procuro peças pro meu gol", "procuro mecânico pro meu onix", "alguém indica oficina de funilaria pro carro?", "procuro seguro pro carro"])(
    "parts/services for a car the person already owns are not a purchase: %s",
    (text) => expect(scoreCarPurchaseIntent(text).isLead).toBe(false),
  );

  test("region and budget raise the score and are reported", () => {
    const regions = ["Vila Nova", "Vila Nova do Sul"];
    const plain = scoreCarPurchaseIntent("procuro um carro", regions);
    const local = scoreCarPurchaseIntent("procuro um carro até 50 mil em Vila Nova do Sul", regions);
    expect(local.region).toBe("vila nova do sul");
    expect(local.budget).toBe(50000);
    expect(local.score).toBeGreaterThan(plain.score);
  });
});

describe("scoreSocialItems", () => {
  test("scores posts and their comments, keeps only leads, best first", () => {
    const items = [
      {
        author: "Garagem Top", text: "Vendo Gol 2015", url: "https://fb.com/p/1",
        comments: [{ author: "Ana", text: "valor?" }, { author: "Bia", text: "lindo" }],
      },
      { author: "Carlos", text: "Procuro Onix até 60 mil", url: "https://fb.com/p/2" },
    ];
    const leads = scoreSocialItems(items);
    expect(leads.map((l) => [l.author, l.intent.kind])).toEqual([["Carlos", "buyer"], ["Ana", "price_question"]]);
    expect(leads[1].url).toBe("https://fb.com/p/1"); // a comment points back to its post
  });
});

describe("scorePurchaseIntent (generic lexicon, pt-BR + EN)", () => {
  test.each([
    "Procuro uma agência de marketing em Goiânia, alguém indica?",
    "Preciso contratar um contador urgente",
    "Looking for a dentist near downtown, any recommendations?",
    "Can anyone recommend a good plumber?",
    "I want to buy a standing desk under $400",
  ])("buyer: %s", (text) => {
    const r = scorePurchaseIntent(text);
    expect(r.kind).toBe("buyer");
    expect(r.isLead).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(75);
  });

  test.each(["Quanto custa?", "valor?", "How much for the pro plan?", "still available?", "dm me the price"])(
    "price question: %s",
    (text) => expect(scorePurchaseIntent(text).kind).toBe("price_question"),
  );

  test.each([
    "Vendo notebook usado, aceito proposta",
    "Nossos serviços de contabilidade com 20% off este mês",
    "For sale: office chairs, limited time",
  ])("seller or ad is not a lead: %s", (text) => {
    const r = scorePurchaseIntent(text);
    expect(r.kind).toBe("seller");
    expect(r.isLead).toBe(false);
  });

  test("job searches and small talk are not leads", () => {
    expect(scorePurchaseIntent("procuro emprego de vendedor").isLead).toBe(false);
    expect(scorePurchaseIntent("looking for a job in sales").isLead).toBe(false);
    expect(scorePurchaseIntent("bom dia pessoal").kind).toBe("none");
    expect(scorePurchaseIntent("").kind).toBe("none");
  });

  test("budget in R$, $ and k is parsed; a year is not a budget", () => {
    expect(scorePurchaseIntent("procuro sofá até R$ 2.500").budget).toBe(2500);
    expect(scorePurchaseIntent("looking for a laptop, budget of $1200").budget).toBe(1200);
    expect(scorePurchaseIntent("preciso de um site até 5k").budget).toBe(5000);
    expect(scorePurchaseIntent("procuro algo até 2015").budget).toBeNull();
  });

  test("the car vertical needs vehicle context, the generic one does not", () => {
    expect(scorePurchaseIntent("procuro um sofá", "car").isLead).toBe(false);
    expect(scorePurchaseIntent("procuro um sofá").isLead).toBe(true);
    expect(scorePurchaseIntent("procuro hb20 até 60 mil", "car").isLead).toBe(true);
  });

  test("unknown vertical throws and names the options", () => {
    expect(() => scorePurchaseIntent("procuro x", "boats")).toThrow(/generic, car/);
  });

  test("scoreSocialItems accepts a vertical", () => {
    const leads = scoreSocialItems([{ author: "A", text: "procuro um sofá" }], { vertical: "generic" });
    expect(leads).toHaveLength(1);
    expect(scoreSocialItems([{ author: "A", text: "procuro um sofá" }], { vertical: "car" })).toHaveLength(0);
  });
});

test("inherited object keys are not verticals", () => {
  expect(() => scorePurchaseIntent("x", "constructor" as never)).toThrow(/Unknown vertical/);
});
