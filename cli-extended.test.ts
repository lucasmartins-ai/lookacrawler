import { describe, it, expect } from "bun:test";

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "cli.ts", ...args], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

describe("CLI Extended Integration Suite (cli.ts)", () => {
  it("should output full help information for lookacrawler --help and -h", async () => {
    const res1 = await runCli(["--help"]);
    expect(res1.exitCode).toBe(0);
    expect(res1.stdout).toContain("LookaCrawler CLI");
    expect(res1.stdout).toContain("extract <url>");
    expect(res1.stdout).toContain("map <url>");
    expect(res1.stdout).toContain("crawl <url>");
    expect(res1.stdout).toContain("batch <url1>");
    expect(res1.stdout).toContain("structured <url>");

    const res2 = await runCli(["-h"]);
    expect(res2.exitCode).toBe(0);
    expect(res2.stdout).toContain("LookaCrawler CLI");
  });

  it("should output version for --version and -v", async () => {
    const res1 = await runCli(["--version"]);
    expect(res1.exitCode).toBe(0);
    expect(res1.stdout.trim()).toBe("v1.0.0");

    const res2 = await runCli(["-v"]);
    expect(res2.exitCode).toBe(0);
    expect(res2.stdout.trim()).toBe("v1.0.0");
  });

  it("should fail with code 1 and error message if extract has no URL", async () => {
    const res = await runCli(["extract"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Missing target URL");
  });

  it("should fail with code 1 and error message if map has no URL", async () => {
    const res = await runCli(["map"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Missing target URL");
  });

  it("should fail with code 1 and error message if crawl has no URL", async () => {
    const res = await runCli(["crawl"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Missing target URL");
  });

  it("should fail with code 1 and error message if batch has no URLs", async () => {
    const res = await runCli(["batch"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Missing target URLs");
  });

  it("should fail with code 1 and error message if structured has no URL", async () => {
    const res = await runCli(["structured"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Missing target URL");
  });

  it("should fail with code 1 and error message if structured receives invalid JSON schema", async () => {
    const res = await runCli(["structured", "https://example.com", "--schema", "{not-valid-json}"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Invalid JSON schema string");
  });

  it("should fail with code 1 on unknown command", async () => {
    const res = await runCli(["unsupported_cmd"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Unknown command: unsupported_cmd");
  });

  it("should successfully extract URL in JSON format with --json flag", async () => {
    const res = await runCli(["extract", "https://example.com", "--mode", "fast", "--json", "--no-cache"]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.url).toBe("https://example.com");
    expect(parsed.mode).toBe("fast");
    expect(parsed.cached).toBe(false);
    expect(typeof parsed.content).toBe("string");
    expect(parsed.content.length).toBeGreaterThan(0);
  }, 15000);

  it("should successfully extract URL when flags precede the target URL", async () => {
    const res = await runCli(["extract", "--mode", "fast", "--no-cache", "https://example.com"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("This domain is for use in documentation examples");
  }, 15000);
});
