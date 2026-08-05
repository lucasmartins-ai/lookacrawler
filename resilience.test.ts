import { describe, expect, test } from "bun:test";
import {
  detectAntiBot,
  RateLimiter,
  ProxyManager,
  retryWithBackoff,
} from "./resilience.js";

describe("Resilience Module (resilience.ts)", () => {
  describe("detectAntiBot", () => {
    test("should flag HTTP status 403, 429, and 503 as blocked", () => {
      expect(detectAntiBot(403, "<html>Forbidden</html>").isBlocked).toBe(true);
      expect(detectAntiBot(429, "<html>Rate limit</html>").isBlocked).toBe(true);
      expect(detectAntiBot(503, "<html>Service Unavailable</html>").isBlocked).toBe(true);
      expect(detectAntiBot(200, "<html>Clean page content</html>").isBlocked).toBe(false);
    });

    test("should detect Cloudflare & CAPTCHA signatures in HTML text", () => {
      const cfHtml = "<html><head><title>Just a moment...</title></head><body>cf-browser-verification</body></html>";
      const result = detectAntiBot(200, cfHtml);
      expect(result.isBlocked).toBe(true);
      expect(result.reason).toContain("cf-browser-verification");
    });

    test("should detect Turnstile and hCaptcha signatures", () => {
      const captchaHtml = "<div class='cf-turnstile'></div>";
      expect(detectAntiBot(200, captchaHtml).isBlocked).toBe(true);
    });
  });

  describe("RateLimiter", () => {
    test("should throttle requests per domain", async () => {
      const limiter = new RateLimiter(50);
      const url = "https://example.com/test1";

      const start = Date.now();
      await limiter.throttle(url);
      await limiter.throttle(url);
      const duration = Date.now() - start;

      expect(duration).toBeGreaterThanOrEqual(40);
    });
  });

  describe("ProxyManager", () => {
    test("should rotate proxies in round-robin fashion", () => {
      const manager = new ProxyManager(["http://proxy1.com:8080", "http://proxy2.com:8080"]);
      expect(manager.getProxy()).toBe("http://proxy1.com:8080");
      expect(manager.getProxy()).toBe("http://proxy2.com:8080");
      expect(manager.getProxy()).toBe("http://proxy1.com:8080");
    });

    test("should prefer specific proxy if provided", () => {
      const manager = new ProxyManager(["http://proxy1.com:8080"]);
      expect(manager.getProxy("http://override.com:8080")).toBe("http://override.com:8080");
    });
  });

  describe("retryWithBackoff", () => {
    test("should succeed on first attempt if no error", async () => {
      let calls = 0;
      const res = await retryWithBackoff(async () => {
        calls++;
        return "success";
      });
      expect(res).toBe("success");
      expect(calls).toBe(1);
    });

    test("should retry until success or max retries exceeded", async () => {
      let calls = 0;
      const res = await retryWithBackoff(
        async () => {
          calls++;
          if (calls < 3) throw new Error("Transient error");
          return "recovered";
        },
        { maxRetries: 3, initialDelayMs: 10, backoffFactor: 1.5 }
      );
      expect(res).toBe("recovered");
      expect(calls).toBe(3);
    });

    test("should throw error if max retries exceeded", async () => {
      let calls = 0;
      expect(
        retryWithBackoff(
          async () => {
            calls++;
            throw new Error("Persistent error");
          },
          { maxRetries: 2, initialDelayMs: 5 }
        )
      ).rejects.toThrow("Persistent error");
    });
  });
});
