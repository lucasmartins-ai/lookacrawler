/**
 * Optional TypeSafe System One (Jev) judgments. Off unless a key is found:
 * TYPESAFE_API_KEY env, then the macOS Keychain item "typesafe". Set
 * LOOKACRAWLER_JEV=off to disable it. Every call is best-effort: any failure
 * returns null and callers keep their deterministic path.
 *
 * Calls append one JSON line to TYPESAFE_LEDGER_PATH, or the shared
 * ~/Downloads/LOOKAORCHESTRATOR/logs/typesafe/jev.jsonl when that folder exists,
 * or ./logs/typesafe/jev.jsonl next to this file. Appends never throw.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer = { type: string; choice?: string; noul?: number; score?: number; confidence?: number };
export type JevAsk = (
  feature: string,
  state: Record<string, unknown>,
  questions: Record<string, JevQuestion>
) => Promise<Record<string, JevAnswer> | null>;

let cachedKey: string | null | undefined;

function apiKey(): string | null {
  if (process.env.LOOKACRAWLER_JEV === "off") return null;
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
  if (cachedKey !== undefined) return cachedKey;
  cachedKey = null;
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("security", ["find-generic-password", "-s", "typesafe", "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2500,
      }).trim();
      if (out) cachedKey = out;
    } catch {
      /* no keychain item */
    }
  }
  return cachedKey;
}

export function jevEnabled(): boolean {
  return apiKey() !== null;
}

function ledgerFile(): string {
  if (process.env.TYPESAFE_LEDGER_PATH) return process.env.TYPESAFE_LEDGER_PATH;
  const shared = path.join(os.homedir(), "Downloads", "LOOKAORCHESTRATOR", "logs", "typesafe");
  if (fs.existsSync(shared)) return path.join(shared, "jev.jsonl");
  return path.join(import.meta.dir, "logs", "typesafe", "jev.jsonl");
}

function ledger(entry: Record<string, unknown>): void {
  try {
    const file = ledgerFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), model: "jev-latest", ...entry }) + "\n");
  } catch {
    /* monitoring never breaks a call */
  }
}

export const jevAsk: JevAsk = async (feature, state, questions) => {
  const key = apiKey();
  if (!key) return null;
  const started = Date.now();
  // Error text can echo the Authorization header; never let the key reach the ledger.
  const redact = (s: string) => s.split(key).join("[redacted]").slice(0, 300);
  let stateChars = -1;
  try {
    const body = JSON.stringify({ model: "jev-latest", state, questions });
    stateChars = JSON.stringify(state).length;
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const error = redact(await res.text().catch(() => ""));
      ledger({ feature, status: "error", http_status: res.status, error, latency_ms: Date.now() - started, state_chars: stateChars });
      return null;
    }
    const data = (await res.json()) as { answers?: Record<string, JevAnswer>; usage?: { input_tokens?: number; output_tokens?: number } };
    const answers = data.answers ?? {};
    ledger({
      feature,
      status: "ok",
      latency_ms: Date.now() - started,
      input_tokens: data.usage?.input_tokens ?? 0,
      output_tokens: data.usage?.output_tokens ?? 0,
      state_chars: stateChars,
      answers,
    });
    return answers;
  } catch (err) {
    ledger({ feature, status: "error", error: redact(`network: ${err instanceof Error ? err.message : String(err)}`), latency_ms: Date.now() - started, state_chars: stateChars });
    return null;
  }
};
