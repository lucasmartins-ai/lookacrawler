import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { registerCleanup, runCleanups } from "./lifecycle.js";

describe("lifecycle cleanups", () => {
  it("runs every registered cleanup once and tolerates failures", async () => {
    const calls: string[] = [];
    registerCleanup(() => { calls.push("a"); });
    registerCleanup(async () => { calls.push("b"); throw new Error("boom"); });
    await runCleanups();
    await runCleanups();
    expect(calls.sort()).toEqual(["a", "b"]);
  });

  it("does not wait forever on a cleanup that hangs", async () => {
    registerCleanup(() => new Promise(() => {}));
    const started = Date.now();
    await runCleanups(200);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe("CLI process exit", () => {
  it.skipIf(!hasChromium)("exits after a deep-mode extraction", async () => {
    const site = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><head><title>t</title></head><body><main><h1>Hello exit</h1><p>Some paragraph text for readability.</p></main></body></html>");
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
    const { port } = site.address() as AddressInfo;
    try {
      const proc = Bun.spawn(
        ["bun", "cli.ts", "extract", `http://127.0.0.1:${port}/`, "--mode", "deep", "--no-cache"],
        { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, LOOKACRAWLER_ALLOW_LOCAL: "true" } }
      );
      const timer = setTimeout(() => proc.kill(), 45_000);
      const code = await proc.exited;
      clearTimeout(timer);
      const out = await new Response(proc.stdout).text();
      expect(out).toContain("Hello exit");
      expect(code).toBe(0);
    } finally {
      site.close();
    }
  }, 60_000);
});
