import { describe, expect, test } from "bun:test";
import { validateTargetUrl } from "./security.js";

describe("Target URL security", () => {
  test("accepts public HTTP and HTTPS URLs", async () => {
    await expect(validateTargetUrl("https://example.com/path")).resolves.toBeUndefined();
    await expect(validateTargetUrl("http://example.com")).resolves.toBeUndefined();
  });

  test("rejects non-web protocols and private hosts", async () => {
    await expect(validateTargetUrl("file:///etc/passwd")).rejects.toThrow("HTTP/HTTPS");
    await expect(validateTargetUrl("http://127.0.0.1:8080")).rejects.toThrow("private");
    await expect(validateTargetUrl("http://localhost")).rejects.toThrow("private");
  });
});
