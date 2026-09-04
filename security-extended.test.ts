import { describe, it, expect } from "bun:test";
import { validateTargetUrl, isPrivateAddress } from "./security.js";

describe("Security Module Extended (security.ts)", () => {
  describe("validateTargetUrl protocol checks", () => {
    it("should allow valid public HTTP and HTTPS URLs", async () => {
      await expect(validateTargetUrl("https://example.com")).resolves.toBeUndefined();
      await expect(validateTargetUrl("http://example.org/page?query=1")).resolves.toBeUndefined();
      await expect(validateTargetUrl("https://1.1.1.1")).resolves.toBeUndefined();
    });

    it("should reject non-HTTP/HTTPS protocols", async () => {
      await expect(validateTargetUrl("ftp://ftp.example.com/file")).rejects.toThrow("Only HTTP/HTTPS");
      await expect(validateTargetUrl("file:///C:/Windows/System32/drivers/etc/hosts")).rejects.toThrow("Only HTTP/HTTPS");
      await expect(validateTargetUrl("javascript:alert(1)")).rejects.toThrow();
      await expect(validateTargetUrl("gopher://example.com")).rejects.toThrow("Only HTTP/HTTPS");
      await expect(validateTargetUrl("data:text/html,<h1>Hello</h1>")).rejects.toThrow();
    });

    it("should reject malformed URL strings", async () => {
      await expect(validateTargetUrl("not-a-valid-url")).rejects.toThrow();
      await expect(validateTargetUrl("")).rejects.toThrow();
      await expect(validateTargetUrl("http://")).rejects.toThrow();
    });
  });

  describe("isPrivateAddress comprehensive SSRF checks", () => {
    it("should identify localhost and loopback IPv4 addresses", () => {
      expect(isPrivateAddress("localhost")).toBe(true);
      expect(isPrivateAddress("127.0.0.1")).toBe(true);
      expect(isPrivateAddress("127.0.0.2")).toBe(true);
      expect(isPrivateAddress("127.255.255.255")).toBe(true);
    });

    it("should identify 0.0.0.0/8 current network addresses", () => {
      expect(isPrivateAddress("0.0.0.0")).toBe(true);
      expect(isPrivateAddress("0.1.2.3")).toBe(true);
    });

    it("should identify RFC 1918 private IPv4 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)", () => {
      // 10.0.0.0/8
      expect(isPrivateAddress("10.0.0.1")).toBe(true);
      expect(isPrivateAddress("10.254.1.1")).toBe(true);

      // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
      expect(isPrivateAddress("172.16.0.1")).toBe(true);
      expect(isPrivateAddress("172.25.10.5")).toBe(true);
      expect(isPrivateAddress("172.31.255.254")).toBe(true);
      // 172.15.x and 172.32.x are public
      expect(isPrivateAddress("172.15.0.1")).toBe(false);
      expect(isPrivateAddress("172.32.0.1")).toBe(false);

      // 192.168.0.0/16
      expect(isPrivateAddress("192.168.0.1")).toBe(true);
      expect(isPrivateAddress("192.168.100.254")).toBe(true);
      expect(isPrivateAddress("192.169.1.1")).toBe(false);
    });

    it("should identify link-local addresses (169.254.0.0/16) and cloud metadata", () => {
      expect(isPrivateAddress("169.254.169.254")).toBe(true);
      expect(isPrivateAddress("169.254.1.1")).toBe(true);
    });

    it("should identify CGNAT addresses (100.64.0.0/10)", () => {
      expect(isPrivateAddress("100.64.0.1")).toBe(true);
      expect(isPrivateAddress("100.100.50.1")).toBe(true);
      expect(isPrivateAddress("100.127.255.254")).toBe(true);
      // 100.63.x and 100.128.x are public
      expect(isPrivateAddress("100.63.255.255")).toBe(false);
      expect(isPrivateAddress("100.128.0.1")).toBe(false);
    });

    it("should identify benchmark networks (198.18.0.0/15)", () => {
      expect(isPrivateAddress("198.18.0.1")).toBe(true);
      expect(isPrivateAddress("198.19.255.254")).toBe(true);
      expect(isPrivateAddress("198.20.0.1")).toBe(false);
    });

    it("should identify multicast and reserved Class E networks (>= 224.0.0.0)", () => {
      expect(isPrivateAddress("224.0.0.1")).toBe(true);
      expect(isPrivateAddress("239.255.255.250")).toBe(true);
      expect(isPrivateAddress("240.0.0.1")).toBe(true);
      expect(isPrivateAddress("255.255.255.255")).toBe(true);
    });

    it("should identify IPv6 private, loopback, and IPv4-mapped addresses", () => {
      expect(isPrivateAddress("::1")).toBe(true);
      expect(isPrivateAddress("fe80::1")).toBe(true);
      expect(isPrivateAddress("fc00::1")).toBe(true);
      expect(isPrivateAddress("fd12:3456:789a::1")).toBe(true);
      expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
      expect(isPrivateAddress("::ffff:192.168.1.1")).toBe(true);
      expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
      expect(isPrivateAddress("::ffff:100.64.0.1")).toBe(true);
    });

    it("should allow public IPv4 and IPv6 addresses", () => {
      expect(isPrivateAddress("8.8.8.8")).toBe(false);
      expect(isPrivateAddress("1.1.1.1")).toBe(false);
      expect(isPrivateAddress("93.184.216.34")).toBe(false);
      expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
      expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
    });
  });

  describe("validateTargetUrl integration with host checks", () => {
    it("should block requests to localhost and private IPs", async () => {
      await expect(validateTargetUrl("http://localhost:8080")).rejects.toThrow("Requests to private or local hosts are not allowed");
      await expect(validateTargetUrl("http://127.0.0.1:3000")).rejects.toThrow("Requests to private or local hosts are not allowed");
      await expect(validateTargetUrl("http://192.168.1.1")).rejects.toThrow("Requests to private or local hosts are not allowed");
      await expect(validateTargetUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow("Requests to private or local hosts are not allowed");
      await expect(validateTargetUrl("http://[::1]/")).rejects.toThrow("Requests to private or local hosts are not allowed");
    });
  });
});
