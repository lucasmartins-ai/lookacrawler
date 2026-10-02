import { describe, expect, test } from "bun:test";
import { sanitizeCsvCell, sanitizeCsvRow, toSafeCsv } from "./csv-safe.js";

describe("CSV Safety & Formula Injection Prevention (csv-safe.ts)", () => {
  test("should prefix formula triggers (=, +, -, @, \\t, \\r) with an apostrophe", () => {
    expect(sanitizeCsvCell("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
    expect(sanitizeCsvCell("+12345")).toBe("'+12345");
    expect(sanitizeCsvCell("-50")).toBe("'-50");
    expect(sanitizeCsvCell("@SUM(A1:A10)")).toBe("'@SUM(A1:A10)");
    expect(sanitizeCsvCell("\tmalicious")).toBe("'\tmalicious");
  });

  test("should leave safe strings, numbers, and empty values untouched", () => {
    expect(sanitizeCsvCell("Lucas Martins")).toBe("Lucas Martins");
    expect(sanitizeCsvCell("contato@lookadev.com")).toBe("contato@lookadev.com");
    expect(sanitizeCsvCell(1234)).toBe("1234");
    expect(sanitizeCsvCell(null)).toBe("");
    expect(sanitizeCsvCell(undefined)).toBe("");
    expect(sanitizeCsvCell("")).toBe("");
  });

  test("should correctly sanitize an entire row array", () => {
    const rawRow = ["=SUM(A1)", "Normal Text", "@danger"];
    const sanitized = sanitizeCsvRow(rawRow);
    expect(sanitized).toEqual(["'=SUM(A1)", "Normal Text", "'@danger"]);
  });

  test("should format full CSV with quotes around fields with commas or quotes", () => {
    const headers = ["Name", "Payload", "City"];
    const rows = [
      ["Empresa Alpha, S/A", "=calc", "São Paulo"],
      ["Beta Tech", 'Quote "Inside"', "Rio de Janeiro"],
    ];

    const csvOutput = toSafeCsv(headers, rows);
    expect(csvOutput).toContain('"Empresa Alpha, S/A"');
    expect(csvOutput).toContain("'=calc");
    expect(csvOutput).toContain('"Quote ""Inside"""');
  });
});
