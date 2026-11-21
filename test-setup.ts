import { mock, setDefaultTimeout } from "bun:test";

// Several suites spawn `bun cli.ts`; on a cold CI runner the first spawn has
// taken over 5 s (bun's default), failing tests that finish in ~30 ms locally.
// Bun 1.3.14 does not apply this to every file when several run (the first
// file kept 5 s), so `bun test --timeout 20000` in package.json and CI is what
// holds; bunfig's [test] timeout key had no effect either.
setDefaultTimeout(20_000);

// Hermetic tests: never touch the real on-disk cache (clearCache() would wipe it,
// and the spawned MCP server inherits this env so it gets its own in-memory DB).
process.env.LOOKACRAWLER_DB_PATH = ":memory:";
// No real Jev calls (this machine has a Keychain key); Jev paths take an injected ask.
process.env.LOOKACRAWLER_JEV = "off";

// No real DNS: every hostname resolves to a public documentation IP, except
// *.private-test which resolves to RFC 1918 space for SSRF tests.
mock.module("node:dns/promises", () => ({
  lookup: async (hostname: string) => [
    { address: hostname.endsWith(".private-test") ? "10.0.0.5" : "93.184.215.14", family: 4 },
  ],
}));
