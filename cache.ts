import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Local SQLite cache for scraped pages. Lives in the user cache dir
 * (~/.cache/lookacrawler) or LOOKACRAWLER_DB_PATH, not next to the source:
 * on macOS something hard-links the -wal/-shm files of a DB under ~/Downloads
 * while a connection is open, and Apple's SQLite then fails every write with
 * SQLITE_IOERR_VNODE ("disk I/O error").
 *
 * The cache is best-effort: any SQLite error is reported once on stderr and the
 * call behaves as a cache miss, so a broken cache never fails an extraction.
 */
const dbPath =
  process.env.LOOKACRAWLER_DB_PATH ||
  join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "lookacrawler", "crawler_cache.sqlite");

let warned = false;
function cacheError(err: unknown): void {
  if (warned) return;
  warned = true;
  const e = err as { code?: string; message?: string };
  console.error(`lookacrawler: cache unavailable (${e.code || e.message || err}); continuing without cache.`);
}

function safe<T>(fn: (d: Database) => T, fallback: T): T {
  if (!db) return fallback;
  try {
    return fn(db);
  } catch (err) {
    cacheError(err);
    return fallback;
  }
}

function openDb(): Database | null {
  try {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    const d = new Database(dbPath, { create: true });
    d.run("PRAGMA journal_mode = WAL;");
    d.run("PRAGMA busy_timeout = 5000;");
    d.run(`
      CREATE TABLE IF NOT EXISTS pages (
        url TEXT PRIMARY KEY,
        content TEXT,
        timestamp INTEGER
      )
    `);
    d.run("CREATE INDEX IF NOT EXISTS idx_pages_timestamp ON pages (timestamp)");
    return d;
  } catch (err) {
    cacheError(err);
    return null;
  }
}

export const db = openDb();

/**
 * Cache TTL: 24 hours in milliseconds
 */
export const TTL_MS = 24 * 60 * 60 * 1000;

export interface CacheKeyOptions {
  url: string;
  mode?: "fast" | "deep";
  cssSelector?: string;
  pipelineVersion?: string;
  variant?: unknown;
  linkFormat?: string;
  imageMode?: string;
}

function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    const trackingKeys = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
    ];
    for (const k of trackingKeys) u.searchParams.delete(k);
    u.searchParams.sort();
    return u.toString();
  } catch {
    return rawUrl;
  }
}

export function buildCacheKey(options: CacheKeyOptions): string {
  const canonical = JSON.stringify({
    url: normalizeUrl(options.url),
    mode: options.mode || "fast",
    cssSelector: options.cssSelector || "",
    pipelineVersion: options.pipelineVersion || "1",
    variant: options.variant || null,
    linkFormat: options.linkFormat || null,
    imageMode: options.imageMode || null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

interface PageRecord {
  url: string;
  content: string;
  timestamp: number;
}

// db.query() caches the compiled statement, so these stay prepared.
/**
 * Retrieve cached page content if present and within TTL
 * @param url The page URL / cache key to query
 * @returns Cached content string if valid, null if not found, expired or the cache is unavailable
 */
export function getCachedPage(url: string): string | null {
  return safe((d) => {
    const row = d
      .query<PageRecord, [string]>("SELECT url, content, timestamp FROM pages WHERE url = ?")
      .get(url);
    if (!row) return null;
    if (Date.now() - row.timestamp < TTL_MS) return row.content;
    d.query("DELETE FROM pages WHERE url = ?").run(url);
    return null;
  }, null);
}

/**
 * Store or overwrite page content in local SQLite cache with current or custom timestamp
 * @param url The page URL / cache key
 * @param content Fresh Markdown content to store
 * @param timestamp Optional timestamp in ms (defaults to Date.now())
 */
export function setCachedPage(url: string, content: string, timestamp = Date.now()): void {
  safe((d) => {
    d.query("INSERT OR REPLACE INTO pages (url, content, timestamp) VALUES (?, ?, ?)").run(url, content, timestamp);
  }, undefined);
}

export function clearCache(): void {
  safe((d) => d.run("DELETE FROM pages"), undefined);
}

export function pruneExpiredCache(): number {
  // `timestamp < cutoff` can use idx_pages_timestamp; `? - timestamp > ?` cannot.
  return safe((d) => d.query("DELETE FROM pages WHERE timestamp < ?").run(Date.now() - TTL_MS).changes, 0);
}

export const pruneExpired = pruneExpiredCache;
