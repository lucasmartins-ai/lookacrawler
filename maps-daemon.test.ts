import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMapsDaemonStatus, startMapsDaemon, stopMapsDaemon } from "./maps-daemon.js";

// A stand-in for `maps-leads serve -addr host:port ...`: answers /healthz on the
// -addr it was given and records its argv, so the flags we pass are checked
// without Go, Chromium or network.
const FAKE = `#!/usr/bin/env bun
const a = process.argv.slice(2);
const addr = a[a.indexOf("-addr") + 1];
const [hostname, port] = addr.split(":");
await Bun.write(process.env.FAKE_ARGS_FILE, JSON.stringify(a));
Bun.serve({ hostname, port: Number(port), fetch: () => Response.json({ status: "ok", version: "fake-1" }) });
`;

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port!;
  s.stop(true);
  return port;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-daemon-test-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("maps-daemon", () => {
  test("status is not running on an idle port", async () => {
    const port = await freePort();
    const s = await getMapsDaemonStatus(port);
    expect(s.running).toBe(false);
    expect(s.url).toBe(`http://127.0.0.1:${port}`);
  });

  test.skipIf(process.platform === "win32")("start spawns `serve` bound to 127.0.0.1, then stop ends it", async () => {
    const bin = path.join(dir, "fake-maps-leads");
    fs.writeFileSync(bin, FAKE, { mode: 0o755 });
    const argsFile = path.join(dir, "args.json");
    process.env.FAKE_ARGS_FILE = argsFile;
    const port = await freePort();
    const dataFolder = path.join(dir, "data");
    try {
      const up = await startMapsDaemon({ port, customBinaryPath: bin, dataFolder, timeoutMs: 10_000 });
      expect(up.running).toBe(true);
      expect(up.version).toBe("fake-1");
      expect(up.pid).toBeGreaterThan(0);

      const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
      expect(args[0]).toBe("serve");
      expect(args[args.indexOf("-addr") + 1]).toBe(`127.0.0.1:${port}`);
      expect(args[args.indexOf("-data-folder") + 1]).toBe(dataFolder);
      expect(fs.existsSync(dataFolder)).toBe(true);

      // Idempotent: a second start returns the running daemon.
      expect((await startMapsDaemon({ port, customBinaryPath: bin })).running).toBe(true);

      expect(await stopMapsDaemon(port)).toEqual({ stopped: true });
      expect((await getMapsDaemonStatus(port)).running).toBe(false);
      expect((await getMapsDaemonStatus(port)).pid).toBeUndefined(); // state file removed
    } finally {
      await stopMapsDaemon(port);
      delete process.env.FAKE_ARGS_FILE;
    }
  }, 20_000);

  test("stop refuses to signal a daemon it did not start", async () => {
    const port = await freePort();
    const foreign = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => Response.json({ ok: 1 }) });
    try {
      const r = await stopMapsDaemon(port);
      expect(r.stopped).toBe(false);
      expect(r.error).toContain("not started by this tool");
    } finally {
      foreign.stop(true);
    }
  });

  test("stop on an idle port is a no-op success", async () => {
    expect(await stopMapsDaemon(await freePort())).toEqual({ stopped: true });
  });
});
