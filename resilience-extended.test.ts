import { describe, it, expect } from "bun:test";
import {
  RateLimiter,
  ProxyManager,
  detectAntiBot,
  retryWithBackoff,
} from "./resilience.js";

describe("Resilience Module Extended (resilience.ts)", () => {
  describe("RateLimiter advanced", () => {
    it("should allow independent domains to run concurrently without mutual blocking", async () => {
      const limiter = new RateLimiter(50); // 50ms interval per domain
      const start = Date.now();

      await Promise.all([
        limiter.throttle("https://domain-a.com/page1"),
        limiter.throttle("https://domain-b.com/page1"),
        limiter.throttle("https://domain-c.com/page1"),
      ]);

      const elapsed = Date.now() - start;
      // All 3 different domains should acquire the first slot immediately (< 40ms)
      expect(elapsed).toBeLessThan(45);
    });

    it("should sequence consecutive requests to the same domain", async () => {
      const limiter = new RateLimiter(60); // 60ms interval
      const start = Date.now();

      await limiter.throttle("https://same-domain.com/1");
      await limiter.throttle("https://same-domain.com/2");

      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(50);
    });
  });

  describe("ProxyManager advanced", () => {
    it("should return undefined when no proxies are provided or configured", () => {
      const pm = new ProxyManager();
      expect(pm.getProxy()).toBeUndefined();
      expect(pm.getProxy(undefined)).toBeUndefined();
    });

    it("should prioritize user-specified proxy over pool rotation", () => {
      const pm = new ProxyManager(["http://p1.com", "http://p2.com"]);
      expect(pm.getProxy("http://custom-proxy.com")).toBe("http://custom-proxy.com");
      // Rotation should remain untouched or continue
      expect(pm.getProxy()).toBe("http://p1.com");
    });

    it("should rotate indefinitely across all configured proxies", () => {
      const pm = new ProxyManager(["http://proxy1:8080", "http://proxy2:8080", "http://proxy3:8080"]);
      expect(pm.getProxy()).toBe("http://proxy1:8080");
      expect(pm.getProxy()).toBe("http://proxy2:8080");
      expect(pm.getProxy()).toBe("http://proxy3:8080");
      expect(pm.getProxy()).toBe("http://proxy1:8080");
      expect(pm.getProxy()).toBe("http://proxy2:8080");
    });
  });

  describe("detectAntiBot anti-scraping detection", () => {
    it("should detect Cloudflare challenge signatures", () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Just a moment...</title></head>
          <body>
            <div class="cf-browser-verification cf-im-under-attack">
              Ray ID: 7c8d9e0f1a2b3c4d
            </div>
          </body>
        </html>
      `;
      const result = detectAntiBot(200, html);
      expect(result.isBlocked).toBe(true);
      expect(result.reason).toBeDefined();
    });

    it("should detect DataDome challenge", () => {
      const html = `<script src="https://ct.datadome.co/tags.js"></script><div id="datadome-captcha"></div>`;
      const result = detectAntiBot(403, html);
      expect(result.isBlocked).toBe(true);
      expect(result.reason).toContain("403");
    });

    it("should detect PerimeterX challenge", () => {
      const html = `<html><head><title>Verify you are human</title></head><body><div id="px-captcha"></div></body></html>`;
      const result = detectAntiBot(200, html);
      expect(result.isBlocked).toBe(true);
      expect(result.reason?.toLowerCase()).toContain("captcha");
    });

    it("should detect Turnstile and hCaptcha challenges", () => {
      const turnstileHtml = `<div class="cf-turnstile" data-sitekey="0x4AAAAAA"></div>`;
      expect(detectAntiBot(200, turnstileHtml).isBlocked).toBe(true);

      const hcaptchaHtml = `<div class="h-captcha" data-sitekey="10000000-ffff-ffff-ffff-000000000001"></div>`;
      expect(detectAntiBot(200, hcaptchaHtml).isBlocked).toBe(true);
    });

    it("should NOT block a legitimate documentation or blog page about security", () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Understanding Web Application Firewalls - DevBlog</title></head>
          <body>
            <header><nav><a href="/">Home</a></nav></header>
            <main>
              <h1>Web Application Firewalls</h1>
              <p>When an attacker tries an exploit, they might see an HTTP 403 access denied or security check response.</p>
              <p>Modern services like Cloudflare help protect websites against distributed attacks.</p>
            </main>
          </body>
        </html>
      `;
      const result = detectAntiBot(200, html);
      expect(result.isBlocked).toBe(false);
      expect(result.reason).toBeUndefined();
    });
  });

  describe("retryWithBackoff retry logic", () => {
    it("should retry on 429 status and succeed when condition clears", async () => {
      let attempts = 0;
      const res = await retryWithBackoff(async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("HTTP 429 Too Many Requests");
        }
        return "SUCCESS_AFTER_429";
      }, 3, 20);

      expect(res).toBe("SUCCESS_AFTER_429");
      expect(attempts).toBe(2);
    });

    it("should retry on 503 status and succeed when service recovers", async () => {
      let attempts = 0;
      const res = await retryWithBackoff(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("503 Service Unavailable");
        }
        return "SUCCESS_AFTER_503";
      }, 3, 20);

      expect(res).toBe("SUCCESS_AFTER_503");
      expect(attempts).toBe(3);
    });

    it("should NOT retry permanent 404 errors", async () => {
      let attempts = 0;
      await expect(
        retryWithBackoff(async () => {
          attempts++;
          throw new Error("HTTP 404 Not Found");
        }, 3, 20)
      ).rejects.toThrow("HTTP 404 Not Found");

      expect(attempts).toBe(1);
    });
  });
});
