import { describe, it, expect, beforeAll, afterAll } from "bun:test";

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
    while (attempts < 30) {
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

  it("should support CORS preflight with 204 No Content and appropriate headers", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-headers")).toContain("Content-Type");
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
    while (attempts < 30) {
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
