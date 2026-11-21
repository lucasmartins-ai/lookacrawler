/**
 * ICP benchmark: homepage scrape of small-business sites through any
 * Firecrawl v2-compatible endpoint (lookacrawler `--transport sse`, or
 * firecrawl-local `serve`). Every tool is measured the same way: one
 * POST /v2/scrape per site, sequential, tools interleaved per site.
 *
 *   bun bench/icp-benchmark.ts --sites sample.csv --out results/ \
 *     --tool lookacrawler=http://127.0.0.1:3900 [--tool firecrawl=http://127.0.0.1:3002]
 *
 * sample.csv columns: site_id,country,industry,url. A bearer token per tool
 * comes from BENCH_TOKEN_<NAME> (uppercase). Outputs: per-site.csv (no URLs,
 * join on site_id) and summary.md.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toSafeCsv } from "../csv-safe.js";

export const TIMEOUT_MS = 30_000;
/** A page counts as scraped when it returns at least this much visible text. */
export const MIN_CHARS = 100;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

/** Unique, lowercased e-mail addresses in the text, ignoring retina asset names (logo@2x.png). */
export function emailsIn(text: string): string[] {
  return [...new Set((text.match(EMAIL_RE) || []).filter((e) => !ASSET_RE.test(e)).map((e) => e.toLowerCase()))];
}

/** ponytail: chars/4, the same estimator for every tool; swap for a tokenizer if absolute counts matter. */
export const tokensOf = (text: string) => Math.ceil(text.length / 4);

/** Nearest-rank percentile; NaN on an empty list. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Minimal RFC 4180 line splitter (quoted fields, doubled quotes). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

interface Site { site_id: string; country: string; industry: string; url: string }
interface Row { site: Site; tool: string; ok: boolean; status: number; ms: number; chars: number; tokens: number; emails: number; error: string }

async function scrape(base: string, token: string | undefined, url: string) {
  const started = performance.now();
  try {
    const res = await fetch(`${base}/v2/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ url, formats: ["markdown"], timeout: TIMEOUT_MS }),
      signal: AbortSignal.timeout(TIMEOUT_MS + 5_000),
    });
    const body: any = await res.json().catch(() => ({}));
    const markdown: string = body?.data?.markdown || "";
    return { status: res.status, ms: performance.now() - started, markdown, error: body?.success ? "" : String(body?.error || `HTTP ${res.status}`) };
  } catch (err) {
    return { status: 0, ms: performance.now() - started, markdown: "", error: err instanceof Error ? err.name + ": " + err.message : String(err) };
  }
}

function summarise(rows: Row[], tools: string[]): string {
  const fmt = (n: number, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : "–");
  const lines = [
    "| Tool | Group | Sites | Success | P50 s | P95 s | Tokens/page (median) | Emails/site | Sites with an email |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const tool of tools) {
    for (const group of ["all", ...new Set(rows.map((r) => r.site.country))]) {
      const rs = rows.filter((r) => r.tool === tool && (group === "all" || r.site.country === group));
      if (!rs.length) continue;
      const ok = rs.filter((r) => r.ok);
      lines.push(
        `| ${tool} | ${group} | ${rs.length} | ${ok.length} (${fmt((100 * ok.length) / rs.length)}%) | ` +
          `${fmt(percentile(ok.map((r) => r.ms), 50) / 1000, 2)} | ${fmt(percentile(ok.map((r) => r.ms), 95) / 1000, 2)} | ` +
          `${fmt(percentile(ok.map((r) => r.tokens), 50))} | ${fmt(rs.reduce((s, r) => s + r.emails, 0) / rs.length, 2)} | ` +
          `${rs.filter((r) => r.emails > 0).length} |`
      );
    }
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
  const [sitesPath] = opt("--sites"), [outDir] = opt("--out");
  const tools = opt("--tool").map((t) => { const [name, base] = t.split("="); return { name, base: base.replace(/\/$/, "") }; });
  if (!sitesPath || !outDir || !tools.length) throw new Error("usage: --sites <csv> --out <dir> --tool name=baseUrl [--tool ...]");

  const [header, ...lines] = (await readFile(sitesPath, "utf8")).trim().split(/\r?\n/);
  const cols = splitCsvLine(header);
  const sites: Site[] = lines.map((l) => Object.fromEntries(splitCsvLine(l).map((v, i) => [cols[i], v])) as unknown as Site);

  const rows: Row[] = [];
  for (const [i, site] of sites.entries()) {
    // Interleave tools per site, alternating who goes first, so neither tool
    // always meets a site's cold cache or a transient outage.
    const order = i % 2 ? [...tools].reverse() : tools;
    for (const tool of order) {
      const r = await scrape(tool.base, process.env[`BENCH_TOKEN_${tool.name.toUpperCase()}`], site.url);
      const visible = r.markdown.replace(/\s+/g, "").length;
      rows.push({
        site, tool: tool.name, ok: r.status === 200 && visible >= MIN_CHARS, status: r.status, ms: Math.round(r.ms),
        chars: r.markdown.length, tokens: tokensOf(r.markdown), emails: emailsIn(r.markdown).length,
        error: r.error || (r.status === 200 && visible < MIN_CHARS ? `under ${MIN_CHARS} visible chars` : ""),
      });
      const last = rows[rows.length - 1];
      console.error(`${site.site_id} ${tool.name} ${last.ok ? "ok" : "FAIL"} ${last.ms}ms ${last.error.slice(0, 80)}`);
    }
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "per-site.csv"), toSafeCsv(
    ["site_id", "country", "industry", "tool", "ok", "status", "ms", "chars", "tokens", "emails", "error"],
    rows.map((r) => [r.site.site_id, r.site.country, r.site.industry, r.tool, r.ok, r.status, r.ms, r.chars, r.tokens, r.emails, r.error.slice(0, 200)])
  ));
  const summary = summarise(rows, tools.map((t) => t.name));
  await writeFile(join(outDir, "summary.md"), summary + "\n");
  console.log(summary);
}

if (import.meta.main) await main();
