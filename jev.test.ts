import { describe, expect, test } from "bun:test";
import { findPersonCandidates, pickDecisionMaker } from "./enrichment-bridge.js";
import { splitByNiche } from "./gtm-pipeline.js";
import { jevAsk, type JevAsk } from "./jev.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const answer = (answers: Record<string, object> | null): JevAsk => async () => answers as never;

describe("jev judgments (offline)", () => {
  test("person candidates read accented names", () => {
    expect(findPersonCandidates("Dr. João Antônio da Silva atende. Diretora: Ana Lúcia. Sobre: Consultas Online")).toEqual([
      "João Antônio da Silva",
      "Ana Lúcia",
    ]);
  });

  test("decision maker: pick goes first, none clears, no Jev keeps all", async () => {
    const c = ["Consultas Online", "Marta Reis"];
    const lead = { title: "Clínica Reis" };
    expect(await pickDecisionMaker(c, "", lead, answer({ decision_maker: { type: "choice", choice: "Marta Reis" } }))).toEqual(["Marta Reis", "Consultas Online"]);
    expect(await pickDecisionMaker(c, "", lead, answer({ decision_maker: { type: "choice", choice: "none" } }))).toEqual([]);
    expect(await pickDecisionMaker(c, "", lead, answer(null))).toEqual(c);
    expect(await pickDecisionMaker([], "", lead, answer(null))).toEqual([]);
  });

  test("jevAsk fails open and never writes the key to the ledger", async () => {
    const ledger = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lc-jev-")), "jev.jsonl");
    const env = { ...process.env };
    Object.assign(process.env, { LOOKACRAWLER_JEV: "on", TYPESAFE_API_KEY: "sk-secret\nbad", TYPESAFE_LEDGER_PATH: ledger });
    try {
      // A newline in the key fails header validation locally, before any network.
      expect(await jevAsk("t", { a: 1 }, { q: { type: "noul", instructions: "?" } })).toBeNull();
      expect(await jevAsk("t", { big: 1n }, { q: { type: "noul", instructions: "?" } })).toBeNull();
      expect(fs.readFileSync(ledger, "utf8")).not.toContain("sk-secret");
    } finally {
      process.env = env;
    }
  });

  test("niche gate skips clear misses and fails open", async () => {
    const leads = [{ title: "Sorriso Odonto" }, { title: "Dental Cremer Distribuidora" }];
    const r = await splitByNiche(leads, "dentista", "Goiânia", answer({ fit_0: { type: "noul", noul: 0.97 }, fit_1: { type: "noul", noul: 0.04 } }));
    expect(r.keep.map((l) => l.title)).toEqual(["Sorriso Odonto"]);
    expect(r.skipped).toEqual([{ title: "Dental Cremer Distribuidora", category: undefined, nicheFit: 0.04 }]);
    expect((await splitByNiche(leads, "dentista", undefined, answer(null))).keep).toHaveLength(2);
  });
});
