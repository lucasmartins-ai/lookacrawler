import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "./init.js";

const entry = { command: "/opt/lookacrawler", args: ["serve"] };
const now = new Date("2026-11-21T10:00:00Z");
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "lookacrawler-init-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function seed(files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(home, rel, ".."), { recursive: true });
    await writeFile(join(home, rel), text);
  }
}

describe("lookacrawler init", () => {
  it("adds the server to every config it finds, backing each up first", async () => {
    const claude = JSON.stringify({ numStartups: 3, mcpServers: { other: { command: "x" } } });
    const codex = 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "y"\n';
    await seed({ ".claude.json": claude, ".codex/config.toml": codex });

    const results = await runInit({ home, entry, now });
    expect(results.map((r) => r.status)).toEqual(["added", "missing", "added"]);

    const written = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    expect(written.numStartups).toBe(3);
    expect(written.mcpServers).toEqual({ other: { command: "x" }, lookacrawler: entry });

    const toml = Bun.TOML.parse(await readFile(join(home, ".codex/config.toml"), "utf8")) as any;
    expect(toml.model).toBe("gpt");
    expect(toml.mcp_servers.other.command).toBe("y");
    expect(toml.mcp_servers.lookacrawler).toEqual(entry);

    const backup = results[0].backup!;
    expect(backup).toContain("lookacrawler-backup-2026-11-21T10-00-00-000Z");
    expect(await readFile(backup, "utf8")).toBe(claude);
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    expect(await readFile(results[2].backup!, "utf8")).toBe(codex);
  });

  it("dry run prints only the added lines and writes nothing", async () => {
    const cursor = JSON.stringify({ mcpServers: { secret: { env: { API_KEY: "sk-live-123" } } } });
    await seed({ ".cursor/mcp.json": cursor });

    const [, r] = await runInit({ home, entry, now, dryRun: true });
    expect(r.status).toBe("would-add");
    expect(r.diff).toMatch(/^\+ +"command": "\/opt\/lookacrawler"/m);
    expect(r.diff).not.toContain("sk-live-123");
    expect(await readFile(join(home, ".cursor/mcp.json"), "utf8")).toBe(cursor);
    expect(await readdir(join(home, ".cursor"))).toEqual(["mcp.json"]);
  });

  it("never touches a config it cannot parse or that already has the server", async () => {
    await seed({
      ".claude.json": "{ not json",
      ".cursor/mcp.json": JSON.stringify({ mcpServers: { lookacrawler: { command: "old" } } }),
      ".codex/config.toml": "mcp_servers = 3\n",
    });
    const results = await runInit({ home, entry, now });
    expect(results.map((r) => r.status)).toEqual(["unparseable", "already", "unparseable"]);
    expect(await readFile(join(home, ".claude.json"), "utf8")).toBe("{ not json");
    expect(JSON.parse(await readFile(join(home, ".cursor/mcp.json"), "utf8")).mcpServers.lookacrawler.command).toBe("old");
    expect((await readdir(home)).sort()).toEqual([".claude.json", ".codex", ".cursor"]);
  });

  it("is idempotent", async () => {
    await seed({ ".cursor/mcp.json": "{}" });
    await runInit({ home, entry, now });
    const again = await runInit({ home, entry, now: new Date("2026-11-22T10:00:00Z") });
    expect(again[1].status).toBe("already");
  });
});
