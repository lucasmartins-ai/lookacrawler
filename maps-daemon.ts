import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveMapsLeadsBinary } from "./maps-bridge.js";

/**
 * Start/stop/status for the vendored scraper's web mode (`maps-leads serve`).
 * maps-bridge.ts already prefers a daemon on 127.0.0.1:8088 when one answers
 * /healthz, so a started daemon speeds up `maps`, `gtm` and `intel` without
 * any other change. Bound to loopback only, always.
 */

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8088;

export interface MapsDaemonOptions {
  port?: number;
  /** Scraper data folder. Default: ~/.lookacrawler/maps-daemon/data-<port>. */
  dataFolder?: string;
  concurrency?: number;
  customBinaryPath?: string;
  timeoutMs?: number;
}

export interface MapsDaemonStatus {
  running: boolean;
  port: number;
  host: string;
  url: string;
  pid?: number;
  version?: string;
  dataFolder?: string;
}

interface DaemonState {
  pid: number;
  port: number;
  dataFolder: string;
  startedAt: string;
}

// Per-user, owner-only: a shared /tmp would let another local user plant the
// state file (a PID for `stop` to signal) or a symlink for us to write through.
const stateDir = () => {
  const dir = path.join(os.homedir(), ".lookacrawler", "maps-daemon");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};
const stateFile = (port: number) => path.join(stateDir(), `${port}.json`);

function readState(port: number): DaemonState | null {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(port), "utf8"));
    // pid 0 or negative would make kill(-pid) hit our own process group.
    return Number.isInteger(state?.pid) && state.pid > 1 ? state : null;
  } catch {
    return null;
  }
}

function removeState(port: number): void {
  try {
    fs.unlinkSync(stateFile(port));
  } catch {}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Is a daemon answering /healthz on this port? */
export async function getMapsDaemonStatus(port = DEFAULT_PORT): Promise<MapsDaemonStatus> {
  const url = `http://${HOST}:${port}`;
  const state = readState(port);
  let running = false;
  let version: string | undefined;
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1200) });
    if (res.ok) {
      running = true;
      version = ((await res.json().catch(() => ({}))) as { version?: string }).version;
    }
  } catch {}
  return { running, port, host: HOST, url, pid: state?.pid, version, dataFolder: state?.dataFolder };
}

/** Start the daemon in the background; resolves once /healthz answers. */
export async function startMapsDaemon(options: MapsDaemonOptions = {}): Promise<MapsDaemonStatus> {
  const port = options.port ?? DEFAULT_PORT;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const current = await getMapsDaemonStatus(port);
  if (current.running) return current;

  const binary = resolveMapsLeadsBinary(options.customBinaryPath);
  if (!binary) {
    throw new Error("maps-leads binary not found. Run `bun run build:maps` or set MAPS_LEADS_BIN.");
  }

  const dataFolder = options.dataFolder ?? path.join(stateDir(), `data-${port}`);
  fs.mkdirSync(dataFolder, { recursive: true, mode: 0o700 });

  // Flags per google-maps-scraper/runner/runner.go ParseConfigArgs: `serve` is
  // the web mode; -addr is the listen address; -c the worker count.
  const args = ["serve", "-addr", `${HOST}:${port}`, "-data-folder", dataFolder, "-c", String(options.concurrency ?? 4)];
  const child = spawn(binary, args, { detached: true, stdio: "ignore", env: process.env });
  child.on("error", () => {});
  const pid = child.pid;
  if (!pid) throw new Error("Failed to start the maps-leads daemon (no PID).");
  child.unref();

  fs.writeFileSync(stateFile(port), JSON.stringify({ pid, port, dataFolder, startedAt: new Date().toISOString() } satisfies DaemonState), { mode: 0o600 });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getMapsDaemonStatus(port);
    if (status.running) return { ...status, pid };
    await sleep(250);
  }

  killTree(pid, "SIGTERM");
  removeState(port);
  throw new Error(`Daemon did not answer ${current.url}/healthz within ${timeoutMs}ms.`);
}

/** Signal the daemon's process group (it owns Chromium children), else the process. */
function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

/**
 * Stop the daemon recorded by `startMapsDaemon`. Only signals the saved PID
 * while the port still answers /healthz, so a stale state file (PID reused by
 * another program) is never acted on.
 */
export async function stopMapsDaemon(port = DEFAULT_PORT): Promise<{ stopped: boolean; error?: string }> {
  const state = readState(port);
  const status = await getMapsDaemonStatus(port);
  if (!status.running) {
    removeState(port);
    return { stopped: true };
  }
  if (!state?.pid) {
    return { stopped: false, error: `A daemon answers on port ${port} but was not started by this tool (no PID on record).` };
  }

  killTree(state.pid, "SIGTERM");
  for (const [signal, waitMs] of [["SIGTERM", 5000], ["SIGKILL", 2000]] as const) {
    if (signal === "SIGKILL") killTree(state.pid, signal);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (!(await getMapsDaemonStatus(port)).running) {
        removeState(port);
        return { stopped: true };
      }
      await sleep(200);
    }
  }
  return { stopped: false, error: `Daemon on port ${port} still answers after SIGKILL.` };
}
