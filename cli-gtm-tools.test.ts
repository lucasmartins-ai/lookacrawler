import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cli = async (args: string[], stdin?: string) => {
  const proc = Bun.spawn(["bun", "run", "cli.ts", ...args], {
    cwd: import.meta.dir,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
};

describe("CLI: antislop / intent / daemon / gtm-family commands", () => {
  test("antislop reads an argument", async () => {
    const r = await cli(["antislop", "No cenário atual, uma solução revolucionária."]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.isSlop).toBe(true);
    expect(out.violationsCount).toBeGreaterThan(0);
  }, 15_000);

  test("antislop reads stdin and honours --lang", async () => {
    const r = await cli(["antislop", "--lang", "en"], "Let's delve into it.");
    expect(JSON.parse(r.stdout).violationsCount).toBe(1);
    const pt = await cli(["antislop", "--lang", "pt"], "Let's delve into it.");
    expect(JSON.parse(pt.stdout).violationsCount).toBe(0);
  }, 20_000);

  test("antislop without text fails", async () => {
    const r = await cli(["antislop"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Missing text");
  }, 15_000);

  test("intent scores with the generic lexicon and the car vertical", async () => {
    const generic = JSON.parse((await cli(["intent", "Procuro um sofá até R$ 2.500"])).stdout);
    expect(generic).toMatchObject({ kind: "buyer", isLead: true, budget: 2500 });
    const car = JSON.parse((await cli(["intent", "procuro um sofá", "--vertical", "car"])).stdout);
    expect(car.isLead).toBe(false);
    const bad = await cli(["intent", "x", "--vertical", "boats"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Unknown vertical");
  }, 25_000);

  test("daemon status on an idle port; bad subcommand is rejected", async () => {
    const s = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = s.port!;
    s.stop(true);
    const r = await cli(["daemon", "status", "--port", String(port)]);
    expect(JSON.parse(r.stdout)).toMatchObject({ running: false, host: "127.0.0.1", port });
    expect((await cli(["daemon", "restart"])).code).toBe(1);
  }, 20_000);

  test("required arguments are enforced", async () => {
    for (const args of [["audit"], ["intel", "--site", "https://example.com"], ["gtm"], ["social-lookup"], ["intent-search"]]) {
      const r = await cli(args);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/Error:/);
    }
  }, 40_000);

  test("audit refuses a private host before any request", async () => {
    const r = await cli(["audit", "http://127.0.0.1:9/"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not allowed");
  }, 15_000);

  test("--help documents the new commands", async () => {
    const { stdout } = await cli(["--help"]);
    for (const c of ["audit <url>", "intel --site", "gtm --niche", "antislop", "intent \"<text>\"", "social-lookup", "intent-search", "daemon <start|stop|status>"]) {
      expect(stdout).toContain(c);
    }
  }, 15_000);
});

describe("MCP: new tools", () => {
  let client: Client;
  beforeAll(async () => {
    client = new Client({ name: "gtm-tools-test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: "bun", args: ["index.ts"], cwd: import.meta.dir, stderr: "ignore" }));
  }, 20_000);
  afterAll(async () => {
    await client?.close();
  });

  test("registers the tools and lint_anti_slop works", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["lint_anti_slop", "lookup_social_profile", "search_social_intent", "audit_company_website", "analyze_competitors", "generate_growth_plan", "gtm_pipeline_run"]) {
      expect(names).toContain(n);
    }
    const res: any = await client.callTool({ name: "lint_anti_slop", arguments: { text: "Uma solução revolucionária.", language: "pt" } });
    expect(JSON.parse(res.content[0].text).violationsCount).toBe(1);
  });

  test("tools reject unsafe input", async () => {
    const bad: any = await client.callTool({ name: "audit_company_website", arguments: { url: "http://127.0.0.1:9/" } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("not allowed");
    const sub: any = await client.callTool({ name: "search_social_intent", arguments: { query: "x", subreddit: "../x" } });
    expect(sub.isError).toBe(true);
    expect(sub.content[0].text).toMatch(/subreddit/i);
  });
});
