import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { extractContacts } from "./contacts.js";

describe("Contact & Social Extraction Module (contacts.ts)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let serverUrl: string;

  beforeAll(() => {
    process.env.LOOKACRAWLER_ALLOW_LOCAL = "true";

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/") {
          return new Response(
            `<!DOCTYPE html>
            <html>
              <head><title>Corporate Portal</title></head>
              <body>
                <h1>LookADev Solutions</h1>
                <p>Welcome to our tech company. Reach us via <a href="mailto:comercial@lookadev.com">email</a> or call (11) 98765-4321.</p>
                <p>Fake email to ignore: user@example.com or image: header.png@2x</p>
                <p>Direct chat: <a href="https://wa.me/5511988887777?text=Ola">WhatsApp Chat</a></p>
                
                <footer>
                  <a href="https://instagram.com/lookadev?igshid=xyz">Instagram</a>
                  <a href="https://linkedin.com/company/lookadev">LinkedIn</a>
                  <a href="/fale-conosco">Fale Conosco</a>
                </footer>
              </body>
            </html>`,
            { headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }

        if (url.pathname === "/fale-conosco") {
          return new Response(
            `<!DOCTYPE html>
            <html>
              <body>
                <h1>Fale Conosco</h1>
                <p>Suporte técnico: <a href="mailto:suporte@lookadev.com">suporte@lookadev.com</a></p>
                <p>Telefone central: +55 (11) 4004-1234</p>
                <a href="https://facebook.com/lookadev">Facebook</a>
              </body>
            </html>`,
            { headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }

        if (url.pathname === "/edge-cases") {
          return new Response(
            `<!DOCTYPE html>
            <html>
              <body>
                <p><span>(62) 99999-9999</span><span>vendas@lookadev.com</span></p>
                <a href="mailto:%20financeiro@lookadev.com">Financeiro</a>
                <p>${"a1b2-c3d4.".repeat(10000)}</p>
                <a href="https://www.dropbox.com/s/abc/catalogo.pdf">Catálogo</a>
                <a href="https://x.com/lookadev">X</a>
                <script>window.__CONFIG__ = { tracking: "pixel@tracker-cdn.io" };</script>
              </body>
            </html>`,
            { headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    serverUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    delete process.env.LOOKACRAWLER_ALLOW_LOCAL;
    server.stop(true);
  });

  test("should extract verified emails and ignore fake/placeholder patterns", async () => {
    const result = await extractContacts({
      url: serverUrl,
      deepScan: false,
    });

    expect(result.emails).toContain("comercial@lookadev.com");
    // Should NOT contain dummy/asset emails
    expect(result.emails).not.toContain("user@example.com");
    expect(result.emails.some((e) => e.includes(".png"))).toBe(false);
  });

  test("should extract WhatsApp numbers and telephone numbers", async () => {
    const result = await extractContacts({
      url: serverUrl,
      deepScan: false,
    });

    expect(result.whatsapps).toContain("5511988887777");
    expect(result.phones.some((p) => p.includes("98765-4321"))).toBe(true);
  });

  test("should extract social profiles without tracking query parameters", async () => {
    const result = await extractContacts({
      url: serverUrl,
      deepScan: false,
    });

    expect(result.socials.instagram).toBe("https://instagram.com/lookadev");
    expect(result.socials.linkedin).toBe("https://linkedin.com/company/lookadev");
  });

  test("should not merge text from adjacent elements into one email", async () => {
    const result = await extractContacts({ url: `${serverUrl}/edge-cases`, deepScan: false });

    expect(result.emails).toContain("vendas@lookadev.com");
    expect(result.emails.some((e) => e.includes("9999vendas"))).toBe(false);
  });

  test("should decode mailto links and skip emails inside scripts", async () => {
    const result = await extractContacts({ url: `${serverUrl}/edge-cases`, deepScan: false });

    expect(result.emails).toContain("financeiro@lookadev.com");
    expect(result.emails).not.toContain("pixel@tracker-cdn.io");
  });

  test("should scan long tokens without an @ in linear time", async () => {
    const started = performance.now();
    await extractContacts({ url: `${serverUrl}/edge-cases`, deepScan: false });

    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("should match social networks by hostname, not substring", async () => {
    const result = await extractContacts({ url: `${serverUrl}/edge-cases`, deepScan: false });

    expect(result.socials.twitter).toBe("https://x.com/lookadev");
  });

  test("should perform deep scan visiting dedicated contact subpages", async () => {
    const result = await extractContacts({
      url: serverUrl,
      deepScan: true,
    });

    expect(result.contactPagesScanned.length).toBeGreaterThan(1);
    // Discovered on subpage /fale-conosco
    expect(result.emails).toContain("suporte@lookadev.com");
    expect(result.socials.facebook).toBe("https://facebook.com/lookadev");
  });
});
