import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression: a SQLite failure in the cache (seen as SQLITE_IOERR_VNODE,
// "disk I/O error") used to fail `lookacrawler extract`. The cache must
// degrade to a miss. Runs in a child process because cache.ts opens the DB
// at import time and the test preload pins it to :memory:.
function runWithDb(dbPath: string, script: string) {
  const proc = Bun.spawnSync(["bun", "-e", script], {
    cwd: import.meta.dir,
    env: { ...process.env, LOOKACRAWLER_DB_PATH: dbPath },
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("cache is best-effort", () => {
  test("unopenable DB path: get/set/prune act as a miss and warn once", () => {
    // A directory cannot be opened as a database file.
    const dir = mkdtempSync(join(tmpdir(), "lookacrawler-cache-"));
    const r = runWithDb(dir, `
      const c = await import("./cache.ts");
      c.setCachedPage("k", "v");
      console.log(JSON.stringify([c.getCachedPage("k"), c.pruneExpiredCache()]));
    `);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("[null,0]");
    expect(r.stderr.match(/cache unavailable/g)?.length).toBe(1);
  });

  test("DB failing mid-run: writes and reads stop throwing", () => {
    const r = runWithDb(":memory:", `
      const c = await import("./cache.ts");
      c.setCachedPage("k", "v");
      c.db.close();
      c.setCachedPage("k2", "v2");
      console.log(JSON.stringify(c.getCachedPage("k")));
    `);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("null");
    expect(r.stderr).toContain("cache unavailable");
  });
});
