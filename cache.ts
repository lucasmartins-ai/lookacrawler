import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

/**
 * Initialize local SQLite database for caching scraped web pages
 */
const db = new Database("crawler_cache.sqlite", { create: true });
db.run("PRAGMA busy_timeout = 5000");

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

export function buildCacheKey(options: CacheKeyOptions): string {
  const canonical = JSON.stringify({
    url: options.url,
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

/**
 * Retrieve cached page content if present and within TTL
 * @param url The page URL to query
 * @returns Cached content string if valid, null if not found or expired
 */
export function getCachedPage(url: string): string | null {
  const query = db.query<PageRecord, [string]>(
    "SELECT url, content, timestamp FROM pages WHERE url = ?"
  );
  const row = query.get(url);

  if (!row) {
    return null;
  }

  if (Date.now() - row.timestamp < TTL_MS) {
    return row.content;
  }

  db.query("DELETE FROM pages WHERE url = ?").run(url);

  return null;
}

/**
 * Store or overwrite page content in local SQLite cache with current timestamp
 * @param url The page URL key
 * @param content Fresh Markdown content to store
 */
export function setCachedPage(url: string, content: string): void {
  const query = db.query(
    "INSERT OR REPLACE INTO pages (url, content, timestamp) VALUES (?, ?, ?)"
  );
  query.run(url, content, Date.now());
}

export function clearCache(): void {
  db.run("DELETE FROM pages");
}
