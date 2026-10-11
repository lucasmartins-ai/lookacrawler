import { expect, test } from "bun:test";
import { processHtmlToMarkdown } from "./extractor.js";
import { validateTargetUrl } from "./security.js";

test("hostnames resolving to private IPs are rejected (stubbed DNS)", async () => {
  await expect(validateTargetUrl("http://metadata.private-test/")).rejects.toThrow("private");
});

test("link-heavy pages fall back to unpruned extraction instead of returning empty", () => {
  const cards = Array.from({ length: 12 }, (_, i) =>
    `<div><a href="/news/${i}"><h2>Headline number ${i} about a developing story</h2></a></div>`
  ).join("");
  const md = processHtmlToMarkdown(`<html><body><div id="wrap">${cards}</div></body></html>`, { url: "https://news.test/" });
  expect(md).toContain("Headline number 3");
});
