import { describe, it, expect } from "bun:test";
import { buildStealthInit, stealthInit } from "./stealth.js";

describe("Stealth Module (stealth.ts)", () => {
  it("should export a stealthInit function", () => {
    expect(typeof stealthInit).toBe("function");
  });

  it("should produce a fresh callable function from buildStealthInit", () => {
    const fn = buildStealthInit();
    expect(typeof fn).toBe("function");
  });

  it("should be self-contained and serializable (convertible to string without syntax error)", () => {
    const fnStr = buildStealthInit().toString();
    expect(fnStr.length).toBeGreaterThan(100);
    expect(fnStr).toContain("webdriver");
    expect(fnStr).toContain("plugins");
    expect(fnStr).toContain("languages");
    expect(fnStr).toContain("chrome");
    // Verify that the function can be parsed
    expect(() => new Function(`return (${fnStr});`)()).not.toThrow();
  });

  it("should safely apply stealth overrides to global navigator/window mock", () => {
    const mockNavigator: any = {
      webdriver: true,
      languages: ["pt-BR"],
      language: "pt-BR",
      plugins: [],
    };
    const mockWindow: any = {
      navigator: mockNavigator,
    };

    // Run the inner spoof logic inside an isolated sandbox
    const spoofFn = buildStealthInit();
    
    // Save original globals if present
    const origNav = (globalThis as any).navigator;
    const origWin = (globalThis as any).window;
    const origToStr = Function.prototype.toString;

    try {
      (globalThis as any).navigator = mockNavigator;
      (globalThis as any).window = mockWindow;

      // Executing stealthInit must not throw
      expect(() => spoofFn()).not.toThrow();

      // Check spoofed values
      expect(mockNavigator.webdriver).toBe(false);
      expect(mockNavigator.languages).toEqual(["en-US", "en"]);
      expect(mockNavigator.language).toBe("en-US");
      expect(mockNavigator.plugins.length).toBe(3);
      expect(mockNavigator.plugins[0].name).toBe("PDF Viewer");
      expect(mockWindow.chrome).toBeDefined();
    } finally {
      (globalThis as any).navigator = origNav;
      (globalThis as any).window = origWin;
      Function.prototype.toString = origToStr;
    }
  });
});
