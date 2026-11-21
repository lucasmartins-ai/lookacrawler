import { chmod, copyFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `lookacrawler init`: register lookacrawler as an MCP server in the AI tools
 * found on this machine (Claude Code, Cursor, Codex).
 *
 * Rules: only files that already exist are touched; a file that does not parse
 * is left alone; an existing `lookacrawler` entry is left alone; each file is
 * backed up (mode 0600, it may hold API keys) before it is replaced atomically;
 * a file that changed while we were working is skipped.
 */

export interface McpEntry {
  command: string;
  args: string[];
}

interface Target {
  agent: string;
  path: string;
  kind: "json" | "toml";
}

export interface InitResult {
  agent: string;
  path: string;
  status: "added" | "would-add" | "already" | "missing" | "unparseable" | "changed";
  diff?: string;
  backup?: string;
}

const NAME = "lookacrawler";

export function initTargets(home: string): Target[] {
  return [
    { agent: "Claude Code", path: join(home, ".claude.json"), kind: "json" },
    { agent: "Cursor", path: join(home, ".cursor", "mcp.json"), kind: "json" },
    { agent: "Codex", path: join(home, ".codex", "config.toml"), kind: "toml" },
  ];
}

/** How an MCP client should start us: the compiled binary itself, or bun + cli.ts. */
export function defaultEntry(): McpEntry {
  const compiled = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN");
  return compiled
    ? { command: process.execPath, args: ["serve"] }
    : { command: process.execPath, args: [join(import.meta.dir, "cli.ts"), "serve"] };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** New file text, or a status explaining why there is none. */
function plan(text: string, kind: Target["kind"], entry: McpEntry): { next: string; diff: string } | InitResult["status"] {
  if (kind === "json") {
    let config: unknown;
    try {
      config = JSON.parse(text);
    } catch {
      return "unparseable";
    }
    if (!isObject(config) || (config.mcpServers !== undefined && !isObject(config.mcpServers))) return "unparseable";
    if (isObject(config.mcpServers) && NAME in config.mcpServers) return "already";
    const next = { ...config, mcpServers: { ...(config.mcpServers as object | undefined), [NAME]: entry } };
    const hunk = JSON.stringify({ [NAME]: entry }, null, 2).split("\n").slice(1, -1);
    return { next: JSON.stringify(next, null, 2) + "\n", diff: ["  mcpServers:", ...hunk.map((l) => `+ ${l}`)].join("\n") };
  }
  let config: unknown;
  try {
    config = Bun.TOML.parse(text);
  } catch {
    return "unparseable";
  }
  const servers = isObject(config) ? config.mcp_servers : undefined;
  if (servers !== undefined && !isObject(servers)) return "unparseable";
  if (isObject(servers) && NAME in servers) return "already";
  // JSON string literals are valid TOML basic strings.
  const block = `[mcp_servers.${NAME}]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n`;
  const next = `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}\n${block}`;
  // Appending a table can still clash (e.g. an inline `mcp_servers = {...}`); re-parse to be sure.
  try {
    const parsed = Bun.TOML.parse(next) as any;
    if (parsed?.mcp_servers?.[NAME]?.command !== entry.command) return "unparseable";
  } catch {
    return "unparseable";
  }
  return { next, diff: block.trimEnd().split("\n").map((l) => `+ ${l}`).join("\n") };
}

export async function runInit(opts: { home?: string; dryRun?: boolean; entry?: McpEntry; now?: Date } = {}): Promise<InitResult[]> {
  const entry = opts.entry ?? defaultEntry();
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const results: InitResult[] = [];
  for (const t of initTargets(opts.home ?? homedir())) {
    let text: string;
    try {
      text = await readFile(t.path, "utf8");
    } catch {
      results.push({ agent: t.agent, path: t.path, status: "missing" });
      continue;
    }
    const p = plan(text, t.kind, entry);
    if (typeof p === "string") {
      results.push({ agent: t.agent, path: t.path, status: p });
      continue;
    }
    if (opts.dryRun) {
      results.push({ agent: t.agent, path: t.path, status: "would-add", diff: p.diff });
      continue;
    }
    // Other tools rewrite these files (Claude Code does, constantly); never clobber a newer version.
    if ((await readFile(t.path, "utf8")) !== text) {
      results.push({ agent: t.agent, path: t.path, status: "changed" });
      continue;
    }
    const backup = `${t.path}.${NAME}-backup-${stamp}`;
    await copyFile(t.path, backup);
    await chmod(backup, 0o600);
    const tmp = `${t.path}.${NAME}-tmp-${process.pid}`;
    await writeFile(tmp, p.next, { mode: (await stat(t.path)).mode & 0o777 });
    await rename(tmp, t.path);
    results.push({ agent: t.agent, path: t.path, status: "added", diff: p.diff, backup });
  }
  return results;
}

const MESSAGES: Record<InitResult["status"], string> = {
  added: "added",
  "would-add": "would add (dry run)",
  already: "already configured, left as is",
  missing: "not found, skipped",
  unparseable: "could not parse, left untouched",
  changed: "changed while init was running, left untouched; run init again",
};

export async function runInitCli(args: string[]): Promise<void> {
  const results = await runInit({ dryRun: args.includes("--dry-run") });
  for (const r of results) {
    console.log(`${r.agent} (${r.path}): ${MESSAGES[r.status]}`);
    if (r.diff) console.log(r.diff);
    if (r.backup) console.log(`  backup: ${r.backup}`);
  }
  if (results.some((r) => r.status === "added")) console.log("Restart the tool to load the lookacrawler MCP server.");
  if (results.some((r) => r.status === "unparseable" || r.status === "changed")) process.exitCode = 1;
}
