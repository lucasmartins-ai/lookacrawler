import { expect, it } from "bun:test";
import { emailsIn, percentile, splitCsvLine } from "./icp-benchmark.js";

it("benchmark helpers count emails, percentiles and CSV fields the same way for every tool", () => {
  expect(emailsIn("Mail Info@Clinic.co.uk or info@clinic.co.uk, logo@2x.png, a@b")).toEqual(["info@clinic.co.uk"]);
  expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  expect(percentile([], 50)).toBeNaN();
  expect(splitCsvLine('UK-001,UK,"Health, care ""x""",https://a.co.uk/')).toEqual(["UK-001", "UK", 'Health, care "x"', "https://a.co.uk/"]);
});
