import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";

describe("LookaCrawler CLI Suite", () => {
  test("lookacrawler --help outputs usage instructions", () => {
    const proc = spawnSync("bun", ["run", "cli.ts", "--help"], { encoding: "utf8" });
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain("LookaCrawler CLI v1.1.2");
    expect(proc.stdout).toContain("Usage:");
  });

  test("lookacrawler --version outputs version number", () => {
    const proc = spawnSync("bun", ["run", "cli.ts", "--version"], { encoding: "utf8" });
    expect(proc.status).toBe(0);
    expect(proc.stdout.trim()).toBe("v1.1.2");
  });

  test("lookacrawler extract without URL fails with error code", () => {
    const proc = spawnSync("bun", ["run", "cli.ts", "extract"], { encoding: "utf8" });
    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain("Error: Missing target URL");
  });

  test("lookacrawler extract correctly parses URL when flags precede it", async () => {
    // Local fixture instead of example.com: the test must not depend on the network.
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("<html><body><h1>example fixture</h1><p>Local page body.</p></body></html>", {
        headers: { "content-type": "text/html" },
      }),
    });
    try {
      const proc = Bun.spawn(
        ["bun", "run", "cli.ts", "extract", "--mode", "fast", "--no-cache", `http://127.0.0.1:${server.port}/`],
        { cwd: import.meta.dir, env: { ...process.env, LOOKACRAWLER_ALLOW_LOCAL: "true" }, stdout: "pipe", stderr: "pipe" }
      );
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(stdout).toContain("example fixture");
    } finally {
      server.stop(true);
    }
    // Spawns the CLI (~1-3 s cold start); the default 5 s fails on a loaded machine.
  }, 15_000);
});
