import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";

describe("LookaCrawler CLI Suite", () => {
  test("lookacrawler --help outputs usage instructions", () => {
    const proc = spawnSync("bun", ["run", "cli.ts", "--help"], { encoding: "utf8" });
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain("LookaCrawler CLI v1.0.0");
    expect(proc.stdout).toContain("Usage:");
  });

  test("lookacrawler --version outputs version number", () => {
    const proc = spawnSync("bun", ["run", "cli.ts", "--version"], { encoding: "utf8" });
    expect(proc.status).toBe(0);
    expect(proc.stdout.trim()).toBe("v1.0.0");
  });

  test("lookacrawler extract without URL fails with error code", () => {
    const proc = spawnSync("bun", ["run", "cli.ts", "extract"], { encoding: "utf8" });
    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain("Error: Missing target URL");
  });
});
