import { describe, expect, test } from "bun:test";
import { checkSseRequest, readBodyCapped, validateTargetUrl } from "./security.js";

describe("SSE request gate", () => {
  const base = { bindHost: "127.0.0.1", allowedOrigins: [] as string[] };

  test("loopback bind rejects non-loopback Host (DNS rebinding)", () => {
    expect(checkSseRequest({ ...base, headers: { host: "evil.com:3000" } })?.status).toBe(403);
    expect(checkSseRequest({ ...base, headers: { host: "127.0.0.1:3000" } })).toBeNull();
    expect(checkSseRequest({ ...base, headers: { host: "[::1]:3000" } })).toBeNull();
  });

  test("browser Origin is refused unless allow-listed", () => {
    const headers = { host: "localhost:3000", origin: "https://evil.com" };
    expect(checkSseRequest({ ...base, headers })?.status).toBe(403);
    expect(checkSseRequest({ ...base, allowedOrigins: ["https://evil.com"], headers })).toBeNull();
  });

  test("token is required when configured", () => {
    const gate = { bindHost: "0.0.0.0", token: "s3cret", allowedOrigins: [] };
    expect(checkSseRequest({ ...gate, headers: { host: "x" } })?.status).toBe(401);
    expect(checkSseRequest({ ...gate, headers: { host: "x", authorization: "Bearer wrong!" } })?.status).toBe(401);
    expect(checkSseRequest({ ...gate, headers: { host: "x", authorization: "Bearer s3cret" } })).toBeNull();
  });
});

describe("readBodyCapped", () => {
  test("aborts streams past the cap even without Content-Length", async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(600));
        c.enqueue(new Uint8Array(600));
        c.close();
      },
    });
    await expect(readBodyCapped(new Response(body), 1000)).rejects.toThrow("maximum size");
    await expect(readBodyCapped(new Response("hello"), 1000)).resolves.toBe("hello");
  });
});

test("hostnames resolving to private IPs are rejected", async () => {
  await expect(validateTargetUrl("http://metadata.private-test/")).rejects.toThrow("private");
});
