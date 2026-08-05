import { Database } from "bun:sqlite";

/**
 * Initialize local SQLite database for caching scraped web pages
 */
const db = new Database("crawler_cache.sqlite", { create: true });

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
