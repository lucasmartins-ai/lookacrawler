import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

describe("LookaCrawler MCP Server HTTP/SSE Transport (index.ts)", () => {
  const PORT = 3999;
  let serverProcess: any = null;

  beforeAll(async () => {
    serverProcess = Bun.spawn(
      ["bun", "index.ts", "--transport", "sse", "--port", String(PORT), "--host", "127.0.0.1"],
      {
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    // Wait for the server to be ready
    let attempts = 0;
    // Up to ~14s: a cold start under a parallel test run can exceed 6s.
    while (attempts < 70) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/health`);
        if (res.ok) break;
      } catch {
        // Server not yet accepting connections
      }
      await new Promise((r) => setTimeout(r, 200));
      attempts++;
    }
  }, 15000);

  afterAll(() => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });

  it("should respond with 200 OK and metrics on GET /health", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(data.metrics).toBeDefined();
    expect(typeof data.metrics.requests).toBe("number");
  });

  it("should respond with 200 OK on GET /metrics", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/metrics`);
    expect(res.status).toBe(200);

    const metrics = await res.json();
    expect(typeof metrics.cacheHits).toBe("number");
    expect(typeof metrics.bytesFetched).toBe("number");
  });

  it("should not grant CORS to arbitrary origins", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("should refuse requests sent by a web page (Origin header) unless allowlisted", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/sse`, { headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Origin not allowed");
  });

  it("should refuse a non-loopback Host header (DNS rebinding) when running without a token", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: { Host: "rebind.evil.example:3999" } });
    expect(res.status).toBe(403);
  });

  it("should accept a new SSE session after the previous client disconnects", async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${PORT}/sse`, { signal: controller.signal });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain("/messages?sessionId=");
      controller.abort();
      await reader.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
  });

  it("should return 400 Bad Request when POSTing to /messages without active SSE session", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("SSE session not established");
  });

  it("should return 404 Not Found for undefined routes", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/undefined-endpoint-path`);
    expect(res.status).toBe(404);
  });
});

describe("LookaCrawler MCP Server Bearer Authentication", () => {
  const AUTH_PORT = 3998;
  const SECRET_TOKEN = "super-secret-mcp-token-12345";
  let authServerProcess: any = null;

  beforeAll(async () => {
    authServerProcess = Bun.spawn(
      ["bun", "index.ts", "--transport", "sse", "--port", String(AUTH_PORT), "--host", "127.0.0.1"],
      {
        cwd: import.meta.dir,
        env: {
          ...process.env,
          LOOKACRAWLER_SSE_TOKEN: SECRET_TOKEN,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    let attempts = 0;
    // Up to ~14s: a cold start under a parallel test run can exceed 6s.
    while (attempts < 70) {
      try {
        const res = await fetch(`http://127.0.0.1:${AUTH_PORT}/health`, {
          headers: { Authorization: `Bearer ${SECRET_TOKEN}` },
        });
        if (res.ok) break;
      } catch {
        // Wait for server
      }
      await new Promise((r) => setTimeout(r, 200));
      attempts++;
    }
  }, 15000);

  afterAll(() => {
    if (authServerProcess) {
      authServerProcess.kill();
    }
  });

  it("should reject unauthenticated request with 401 Unauthorized", async () => {
    const res = await fetch(`http://127.0.0.1:${AUTH_PORT}/health`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("should accept request with valid Bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${AUTH_PORT}/health`, {
      headers: { Authorization: `Bearer ${SECRET_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

describe("LookaCrawler MCP Server on a non-loopback address", () => {
  const PORT = 3997;
  let proc: any = null;
  let stderr = "";

  beforeAll(async () => {
    const env = { ...process.env };
    delete env.LOOKACRAWLER_SSE_TOKEN;
    proc = Bun.spawn(["bun", "index.ts", "--transport", "sse", "--port", String(PORT), "--host", "0.0.0.0"], {
      cwd: import.meta.dir,
      env: { ...env, LOOKACRAWLER_SSE_ALLOWED_ORIGINS: "https://app.example" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = proc.stderr.getReader();
    const deadline = Date.now() + 14000;
    while (!stderr.includes("Bearer ") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      stderr += new TextDecoder().decode(value);
    }
    for (let i = 0; i < 70; i++) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/health`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }, 15000);

  afterAll(() => proc?.kill());

  it("requires a token even when none is configured, generating one at startup", async () => {
    const token = /Bearer ([A-Za-z0-9_-]+)/.exec(stderr)?.[1];
    expect(token).toBeDefined();
    expect((await fetch(`http://127.0.0.1:${PORT}/health`)).status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: { Authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
  });

  it("grants CORS only to allowlisted origins", async () => {
    const allowed = await fetch(`http://127.0.0.1:${PORT}/health`, {
      method: "OPTIONS",
      headers: { Origin: "https://app.example" },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example");

    const denied = await fetch(`http://127.0.0.1:${PORT}/health`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    expect(denied.status).toBe(403);
  });
});

describe("LookaCrawler MCP Server concurrent SSE sessions", () => {
  const PORT = 3996;
  const MAX = 2;
  let proc: any = null;

  const connect = async () => {
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${PORT}/sse`)));
    return client;
  };

  beforeAll(async () => {
    const env = { ...process.env };
    delete env.LOOKACRAWLER_SSE_TOKEN;
    proc = Bun.spawn(["bun", "index.ts", "--transport", "sse", "--port", String(PORT), "--host", "127.0.0.1"], {
      cwd: import.meta.dir,
      env: { ...env, LOOKACRAWLER_SSE_MAX_SESSIONS: String(MAX) },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let i = 0; i < 70; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 15000);

  afterAll(() => proc?.kill());

  it("serves several clients at the same time, each with its own session", async () => {
    const a = await connect();
    const b = await connect();
    try {
      const [toolsA, toolsB] = await Promise.all([a.listTools(), b.listTools()]);
      expect(toolsA.tools.map((t) => t.name)).toContain("extract_web_content");
      expect(toolsB.tools.length).toBe(toolsA.tools.length);
      expect(a.getServerVersion()?.name).toBe("lookacrawler");
    } finally {
      await a.close();
      await b.close();
    }
  }, 20000);

  it("caps the number of open sessions and frees a slot when a client leaves", async () => {
    const a = await connect();
    const b = await connect();
    try {
      const refused = await fetch(`http://127.0.0.1:${PORT}/sse`);
      expect(refused.status).toBe(503);
      await refused.body?.cancel();

      await b.close();
      await new Promise((r) => setTimeout(r, 300));
      const c = await connect();
      expect((await c.listTools()).tools.length).toBeGreaterThan(0);
      await c.close();
    } finally {
      await a.close();
      await b.close().catch(() => {});
    }
  }, 20000);

  it("does not route messages to a session id that does not exist", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/messages?sessionId=not-a-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    expect(res.status).toBe(400);
  });
});
