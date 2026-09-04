import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Initialize local SQLite database for caching scraped web pages.
 * Defaults to the LookaCrawler project directory or LOOKACRAWLER_DB_PATH.
 */
const dbPath = process.env.LOOKACRAWLER_DB_PATH || join(import.meta.dir, "crawler_cache.sqlite");
export const db = new Database(dbPath, { create: true });
db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA busy_timeout = 5000;");

// Create table if it does not exist
db.run(`
  CREATE TABLE IF NOT EXISTS pages (
    url TEXT PRIMARY KEY,
    content TEXT,
    timestamp INTEGER
  )
`);

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
  });
  return createHash("sha256").update(canonical).digest("hex");
}

interface PageRecord {
  url: string;
  content: string;
  timestamp: number;
}

// Prepared statements for maximum performance
const selectQuery = db.query<PageRecord, [string]>(
  "SELECT url, content, timestamp FROM pages WHERE url = ?"
);
const deleteQuery = db.query("DELETE FROM pages WHERE url = ?");
const upsertQuery = db.query(
  "INSERT OR REPLACE INTO pages (url, content, timestamp) VALUES (?, ?, ?)"
);
const pruneQuery = db.query("DELETE FROM pages WHERE ? - timestamp > ?");

/**
 * Retrieve cached page content if present and within TTL
 * @param url The page URL / cache key to query
 * @returns Cached content string if valid, null if not found or expired
 */
export function getCachedPage(url: string): string | null {
  const row = selectQuery.get(url);

  if (!row) {
    return null;
  }

  if (Date.now() - row.timestamp < TTL_MS) {
    return row.content;
  }

  deleteQuery.run(url);
  return null;
}

/**
 * Store or overwrite page content in local SQLite cache with current or custom timestamp
 * @param url The page URL / cache key
 * @param content Fresh Markdown content to store
 * @param timestamp Optional timestamp in ms (defaults to Date.now())
 */
export function setCachedPage(url: string, content: string, timestamp = Date.now()): void {
  upsertQuery.run(url, content, timestamp);
}

export function clearCache(): void {
  db.run("DELETE FROM pages");
}

export function pruneExpiredCache(): number {
  const res = pruneQuery.run(Date.now(), TTL_MS);
  return (res as any)?.changes || 0;
}

export const pruneExpired = pruneExpiredCache;

