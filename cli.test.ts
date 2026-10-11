import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import pkg from "./package.json";

describe("LookaCrawler CLI Suite", () => {
  test("lookacrawler --help outputs usage instructions", () => {
    const proc = spawnSync("bun", ["run", "cli.ts", "--help"], { encoding: "utf8" });
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain(`LookaCrawler CLI v${pkg.version}`);
    expect(proc.stdout).toContain("Usage:");
  });

  test("lookacrawler --version outputs version number", () => {
    const proc = spawnSync("bun", ["run", "cli.ts", "--version"], { encoding: "utf8" });
    expect(proc.status).toBe(0);
    expect(proc.stdout.trim()).toBe(`v${pkg.version}`);
  });

  test("lookacrawler extract without URL fails with error code", () => {
    const proc = spawnSync("bun", ["run", "cli.ts", "extract"], { encoding: "utf8" });
    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain("Error: Missing target URL");
  });

  test("lookacrawler extract correctly parses URL when flags precede it", () => {
    const proc = spawnSync(
      "bun",
      ["run", "cli.ts", "extract", "--mode", "fast", "--no-cache", "https://example.com"],
      { encoding: "utf8" }
    );
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain("example");
  });
});
