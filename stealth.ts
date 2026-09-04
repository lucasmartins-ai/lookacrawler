/**
 * Stealth module for LookaCrawler.
 *
 * Cloudflare and other bot-mitigation stacks fingerprint headless browsers and
 * decide to serve the real page or a challenge based on:
 *   - `navigator.webdriver`    Playwright headless leaks this as `true`.
 *   - `navigator.plugins`      headless Chromium exposes an unrealistic list.
 *   - `navigator.languages` / `language`
 *   - the absence of `window.chrome` (a real Chrome-only object)
 *   - WebGL vendor/renderer strings unwrapped from the GPU process
 *   - `navigator.permissions.query` return shape
 *   - CDP/devtools leak globals (`_phantom`, `__nightmare`, etc.)
 *
 * `applyStealthInit()` returns a function Playwright runs *at the top of every
 * page* via `context.addInitScript`, before any page script executes, so the
 * fingerprint is already "human-like" when the page's own probes read it.
 *
 * The patches are defensive: every override is wrapped in try/catch so a future
 * Chromium that removes an API degrades to the built-in value rather than
 * throwing. Nothing here depends on a specific Chromium build.
 */

export interface StealthOptions {
  /** Google PDF viewer plugin names (matches real Chrome on macOS). */
  languages?: string[];
}

/**
 * Build the init-script function to install into a Playwright context.
 * Playwright serialises this function to the browser, so it must be
 * self-contained (no closures over imported bindings).
 */
export function buildStealthInit(): () => void {
  return () => {
    const spoof = () => {
      // 1. webdriver — the #1 headless giveaway.
      try { Object.defineProperty(navigator, "webdriver", { get: () => false }); } catch { /* noop */ }

      // 2. plugins — mimic a real Chrome plugin surface.
      try {
        const proto = (navigator.plugins?.[0] as any)?.constructor?.prototype || {};
        const make = (name: string) =>
          Object.setPrototypeOf(
            { name, filename: "internal-pdf-viewer", description: "" },
            proto,
          );
        const arr: any = [make("PDF Viewer"), make("Chrome PDF Viewer"), make("Chromium PDF Viewer")];
        arr.item = (i: number) => arr[i];
        arr.namedItem = (n: string) => arr.find((p: any) => p.name === n) || null;
        arr.refresh = () => {};
        Object.defineProperty(navigator, "plugins", { get: () => arr });
      } catch { /* noop */ }

      // 3. language surface.
      try { Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] }); } catch { /* noop */ }
      try { Object.defineProperty(navigator, "language", { get: () => "en-US" }); } catch { /* noop */ }

      // 4. realistic device signals (common in normal Chrome).
      try { Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 }); } catch { /* noop */ }
      try { Object.defineProperty(navigator, "deviceMemory", { get: () => 8 }); } catch { /* noop */ }
      try { Object.defineProperty(navigator, "connection", { get: () => ({ effectiveType: "4g", rtt: 50, downlink: 10, saveData: false }) }); } catch { /* noop */ }

      // 5. permissions.query shape — headless returns a non-matching object.
      try {
        (window.navigator.permissions.query as any) = (p: any) =>
          p.name === "notifications"
            ? Promise.resolve({ state: Notification.permission })
            : Promise.resolve({ state: "prompt" });
      } catch { /* noop */ }

      // 6. chrome object — present in real Chrome, absent in headless Chromium.
      try {
        (window as any).chrome = { runtime: {}, loadTimes: undefined, csi: undefined, app: {} };
        (window as any).chrome.runtime = { id: undefined };
      } catch { /* noop */ }

      // 7. WebGL vendor/renderer spoofing (unwrapped in headless).
      try {
        const glGet = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (p: any) {
          if (p === 37445) return "Google Inc.";
          if (p === 37446) return "ANGLE (Google, Inc)";
          return glGet.call(this, p);
        };
        const gl2 = (WebGL2RenderingContext as any)?.prototype?.getParameter;
        if (gl2) {
          WebGL2RenderingContext.prototype.getParameter = function (p: any) {
            if (p === 37445) return "Google Inc.";
            if (p === 37446) return "ANGLE (Google, Inc)";
            return gl2.call(this, p);
          };
        }
      } catch { /* noop */ }

      // 8. function toString for probed natives.
      try {
        const toStr = Function.prototype.toString;
        Function.prototype.toString = function (this: any) {
          try {
            if (typeof window !== "undefined" && ((window as any)?.navigator?.permissions?.query as any) === this) {
              return "function query() { [native code] }";
            }
          } catch { /* noop */ }
          return toStr.call(this);
        };
      } catch { /* noop */ }

      // 9. strip CDP/devtools leak globals.
      try {
        for (const k of ["_phantom", "__nightmare", "callPhantom", "chrome"]) {
          if (k !== "chrome") try { delete (window as any)[k]; } catch { /* noop */ }
        }
      } catch { /* noop */ }
    };

    // Hook into every navigation/frame.
    spoof();
    try { document.addEventListener("DOMContentLoaded", spoof); } catch { /* noop */ }
  };
}

/** Convenience: a pre-built init-script function for `context.addInitScript`. */
export const stealthInit = buildStealthInit();
