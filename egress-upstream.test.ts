import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import net from "node:net";
import { getEgressGuard, stopEgressGuard } from "./egress-guard.js";
import { fetchHtml } from "./extractor.js";

// Every public hostname resolves to 93.184.215.14 under test-setup.ts; the
// fake upstreams record what they were asked for and then splice the tunnel
// onto a local server, standing in for "the internet".

const target = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) =>
    new Response(`<html><body><p>host=${req.headers.get("host")} path=${new URL(req.url).pathname} guardauth=${req.headers.get("proxy-authorization")}</p></body></html>`, {
      headers: { "content-type": "text/html" },
    }),
});

const echo = net.createServer((sock) => sock.on("data", (d) => sock.write(`echo:${d}`)));
await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
const echoPort = (echo.address() as net.AddressInfo).port;

// Target that lies about Content-Length and appends a fake second response.
const liar = net.createServer((sock) =>
  sock.once("data", () => sock.end("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhelloHTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nEVIL"))
);
await new Promise<void>((r) => liar.listen(0, "127.0.0.1", r));
const liarPort = (liar.address() as net.AddressInfo).port;

function splice(client: net.Socket, port: number, leftover: Buffer) {
  // Hold the client's bytes until the onward socket is up; a flowing socket with
  // no "data" listener would drop whatever the guard sends in between.
  client.pause();
  const out = net.connect({ host: "127.0.0.1", port }, () => {
    if (leftover.length) out.write(leftover);
    client.pipe(out);
    out.pipe(client);
  });
  out.on("error", () => client.destroy());
  client.on("error", () => out.destroy());
}

/** Fake HTTP proxy: records CONNECT targets and Proxy-Authorization. */
const httpSeen: { target: string; auth: string | undefined }[] = [];
const httpUpstream = net.createServer((client) => {
  let buf = Buffer.alloc(0);
  const onData = (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    client.off("data", onData);
    const [line, ...headers] = buf.subarray(0, end).toString().split("\r\n");
    const [method, authority] = line.split(" ");
    const auth = headers.find((h) => h.toLowerCase().startsWith("proxy-authorization:"))?.split(": ")[1];
    httpSeen.push({ target: authority, auth });
    if (method !== "CONNECT") return void client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const dest = authority.endsWith(":80") ? target.port! : authority.endsWith(":81") ? liarPort : echoPort;
    splice(client, dest, buf.subarray(end + 4));
  };
  client.on("data", onData);
});

/** Fake SOCKS5 proxy (user/pass auth) that records the requested address. */
const socksSeen: { atyp: number; addr: string; port: number; user: string; pass: string }[] = [];
const socksUpstream = net.createServer((client) => {
  let buf = Buffer.alloc(0);
  let stage = 0;
  let user = "";
  let pass = "";
  const onData = (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    if (stage === 0 && buf.length >= 2 + buf[1]) {
      const offersUserPass = [...buf.subarray(2, 2 + buf[1])].includes(2);
      buf = buf.subarray(2 + buf[1]);
      client.write(Buffer.from([5, offersUserPass ? 2 : 0xff]));
      stage = 1;
    }
    if (stage === 1 && buf.length >= 2 && buf.length >= 3 + buf[1] && buf.length >= 3 + buf[1] + buf[2 + buf[1]]) {
      const ulen = buf[1];
      const plen = buf[2 + ulen];
      user = buf.subarray(2, 2 + ulen).toString();
      pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
      buf = buf.subarray(3 + ulen + plen);
      client.write(Buffer.from([1, 0]));
      stage = 2;
    }
    if (stage === 2 && buf.length >= 10) {
      const atyp = buf[3];
      const len = atyp === 1 ? 4 : 16;
      if (buf.length < 4 + len + 2) return;
      const raw = buf.subarray(4, 4 + len);
      const addr = atyp === 1 ? [...raw].join(".") : raw.toString("hex");
      const port = buf.readUInt16BE(4 + len);
      socksSeen.push({ atyp, addr, port, user, pass });
      client.off("data", onData);
      client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      splice(client, echoPort, buf.subarray(4 + len + 2));
    }
  };
  client.on("data", onData);
});

await new Promise<void>((r) => httpUpstream.listen(0, "127.0.0.1", r));
await new Promise<void>((r) => socksUpstream.listen(0, "127.0.0.1", r));
const httpProxy = `http://up%40user:p%3Ass@127.0.0.1:${(httpUpstream.address() as net.AddressInfo).port}`;
const socksProxy = `socks5://suser:spass@127.0.0.1:${(socksUpstream.address() as net.AddressInfo).port}`;

/** Raw CONNECT through the guard, then send "ping" inside the tunnel. */
async function connectThroughGuard(guardUrl: string, authority: string): Promise<{ status: string; reply: string }> {
  const u = new URL(guardUrl);
  const auth = Buffer.from(`${u.username}:${u.password}`).toString("base64");
  return await new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port: Number(u.port) }, () => {
      sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });
    let data = "";
    let status = "";
    sock.on("data", (d) => {
      data += d;
      if (!status && data.includes("\r\n\r\n")) {
        status = data.split(" ")[1];
        data = data.slice(data.indexOf("\r\n\r\n") + 4);
        if (status !== "200") return sock.destroy(), resolve({ status, reply: "" });
        sock.write("ping");
      }
      if (status === "200" && data.length) {
        sock.destroy();
        resolve({ status, reply: data });
      }
    });
    sock.on("error", reject);
  });
}

/** Raw plain-HTTP request through the guard; returns everything until close. */
async function rawThroughGuard(guardUrl: string, method: string, url: string): Promise<string> {
  const u = new URL(guardUrl);
  const auth = Buffer.from(`${u.username}:${u.password}`).toString("base64");
  return await new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port: Number(u.port) }, () =>
      sock.write(`${method} ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`)
    );
    let data = "";
    sock.on("data", (d) => (data += d));
    sock.on("close", () => resolve(data));
    sock.on("error", reject);
    setTimeout(() => (sock.destroy(), resolve(data)), 1000);
  });
}

describe("Egress guard chained to an upstream proxy", () => {
  const prevAllowLocal = process.env.LOOKACRAWLER_ALLOW_LOCAL;
  const prevAllowed = process.env.LOOKACRAWLER_ALLOWED_PROXIES;

  beforeEach(() => {
    delete process.env.LOOKACRAWLER_ALLOW_LOCAL;
    // Operator-trusted local upstreams (a mitmproxy/Tor sidecar).
    process.env.LOOKACRAWLER_ALLOWED_PROXIES = `${httpProxy},${socksProxy}`;
    httpSeen.length = 0;
    socksSeen.length = 0;
  });

  afterEach(() => {
    if (prevAllowLocal === undefined) delete process.env.LOOKACRAWLER_ALLOW_LOCAL;
    else process.env.LOOKACRAWLER_ALLOW_LOCAL = prevAllowLocal;
    if (prevAllowed === undefined) delete process.env.LOOKACRAWLER_ALLOWED_PROXIES;
    else process.env.LOOKACRAWLER_ALLOWED_PROXIES = prevAllowed;
  });

  afterAll(async () => {
    await stopEgressGuard();
    target.stop(true);
    echo.close();
    liar.close();
    httpUpstream.close();
    socksUpstream.close();
  });

  it("refuses private destinations without ever contacting the upstream", async () => {
    const guard = await getEgressGuard(httpProxy);
    const res = await fetch("http://internal.private-test/", { proxy: guard.url } as any);
    expect(res.status).toBe(403);
    expect((await connectThroughGuard(guard.url, "internal.private-test:443")).status).toBe("403");
    expect((await connectThroughGuard(guard.url, `127.0.0.1:${target.port}`)).status).toBe("403");
    const socksGuard = await getEgressGuard(socksProxy);
    expect((await connectThroughGuard(socksGuard.url, "169.254.169.254:80")).status).toBe("403");
    expect(httpSeen).toHaveLength(0);
    expect(socksSeen).toHaveLength(0);
  });

  it("tunnels HTTPS as CONNECT <validated-ip>:<port> with the upstream's credentials", async () => {
    const guard = await getEgressGuard(httpProxy);
    const { status, reply } = await connectThroughGuard(guard.url, "public.example:443");
    expect(status).toBe("200");
    expect(reply).toBe("echo:ping");
    expect(httpSeen).toEqual([{ target: "93.184.215.14:443", auth: `Basic ${Buffer.from("up@user:p:ss").toString("base64")}` }]);
  });

  it("forwards plain HTTP through a CONNECT tunnel, keeping the original Host", async () => {
    const guard = await getEgressGuard(httpProxy);
    const res = await fetch("http://public.example/some/path", { proxy: guard.url } as any);
    expect(res.status).toBe(200);
    // The guard's own credentials never reach the upstream or the target.
    expect(await res.text()).toContain("host=public.example path=/some/path guardauth=null");
    expect(httpSeen).toHaveLength(1);
    expect(httpSeen[0].target).toBe("93.184.215.14:80");
    expect(httpSeen[0].auth).not.toContain(Buffer.from(`lc:${guard.password}`).toString("base64"));
  });

  it("speaks SOCKS5 with username/password and asks for the validated IP", async () => {
    const guard = await getEgressGuard(socksProxy);
    const { status, reply } = await connectThroughGuard(guard.url, "public.example:8443");
    expect(status).toBe("200");
    expect(reply).toBe("echo:ping");
    expect(socksSeen).toEqual([{ atyp: 1, addr: "93.184.215.14", port: 8443, user: "suser", pass: "spass" }]);
  });

  it("gives each upstream its own credentials and the default route none", async () => {
    const a = await getEgressGuard(httpProxy);
    const b = await getEgressGuard(socksProxy);
    const direct = await getEgressGuard();
    expect(new Set([a.password, b.password, direct.password]).size).toBe(3);
    expect(a.server).toBe(direct.server);
    expect((await getEgressGuard(httpProxy)).password).toBe(a.password);
  });

  it("routes fetchHtml with a proxy through the guard", async () => {
    const html = await fetchHtml("http://public.example/via-fast-path", { proxy: httpProxy });
    expect(html).toContain("host=public.example path=/via-fast-path");
    expect(httpSeen.map((s) => s.target)).toEqual(["93.184.215.14:80"]);
  });

  it("does not resolve a caller-supplied proxy name twice (rebinding)", async () => {
    // Not operator-listed and resolves to private space: refused at connect time.
    const guard = await getEgressGuard("http://evil.private-test:8080");
    expect((await connectThroughGuard(guard.url, "public.example:443")).status).toBe("502");
  });

  it("keeps a route's credentials stable after LRU eviction, so a running browser recovers", async () => {
    const before = await getEgressGuard(httpProxy);
    for (let i = 0; i < 1100; i++) await getEgressGuard(`http://1.1.1.1:${10000 + i}`);
    const after = await getEgressGuard(httpProxy);
    expect(after.password).toBe(before.password);
    expect((await connectThroughGuard(before.url, "public.example:443")).status).toBe("200");
  });

  it("closes the client connection instead of trusting the target's Content-Length", async () => {
    const guard = await getEgressGuard(httpProxy);
    const raw = (await rawThroughGuard(guard.url, "GET", "http://liar.example:81/")).toLowerCase();
    const [head, body] = [raw.slice(0, raw.indexOf("\r\n\r\n")), raw.slice(raw.indexOf("\r\n\r\n") + 4)];
    expect(head).not.toContain("content-length: 5");
    expect(head).toContain("connection: close");
    // Re-framed as chunked: the smuggled "second response" is just body bytes.
    expect(head).toContain("transfer-encoding: chunked");
    expect(body).toContain("hellohttp/1.1 200 ok");
    const headRes = await rawThroughGuard(guard.url, "HEAD", "http://liar.example:81/");
    expect(headRes.slice(headRes.indexOf("\r\n\r\n") + 4)).toBe("");
  });
});
