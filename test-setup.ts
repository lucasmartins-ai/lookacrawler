import { mock, setDefaultTimeout } from "bun:test";

// Several suites spawn `bun cli.ts`; on a cold CI runner the first spawn has
// taken over 5 s (bun's default), failing tests that finish in ~30 ms locally.
setDefaultTimeout(20_000);

// Hermetic tests: never touch the real on-disk cache (clearCache() would wipe it,
// and the spawned MCP server inherits this env so it gets its own in-memory DB).
process.env.LOOKACRAWLER_DB_PATH = ":memory:";

// No real DNS: every hostname resolves to a public documentation IP, except
// *.private-test which resolves to RFC 1918 space for SSRF tests.
mock.module("node:dns/promises", () => ({
  lookup: async (hostname: string) => [
    { address: hostname.endsWith(".private-test") ? "10.0.0.5" : "93.184.215.14", family: 4 },
  ],
}));
