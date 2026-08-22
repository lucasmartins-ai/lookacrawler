/**
 * Resilience, Proxying, and Anti-Bot Module for LookaCrawler
 */

export interface AntiBotCheckResult {
  isBlocked: boolean;
  reason?: string;
}

/**
 * Common Cloudflare/CAPTCHA challenge markers. These must identify an actual
 * CHALLENGE / interstitial page, NOT a site that merely references "cloudflare"
 * in a CDN URL or config string — otherwise a real, fully-loaded page is
 * rejected as a false positive (the bug that made n8n/FB-docs fail even though
 * the real content rendered). Prefer markers unique to the challenge page.
 */
const ANTI_BOT_SIGNATURES = [
  // Cloudflare challenge interstitial (title/body of the JS-check page).
  "just a moment...",
  "attention required!",
  "checking your browser before accessing",
  "verify you are human",
  "cf-browser-verification",
  "cf-chl-",
  // Dedicated bot-protection products.
  "ddos-guard",
  "g-recaptcha",
  "hcaptcha",
  "cf-turnstile",
  "enable javascript and cookies to continue",
  "access denied",
  "robot check",
  "security check",
  // Cloudflare's "Verify you are human" turnstile gate.
  "cf-turnstile-widget",
  "cloudflarecaptcha",
];

/**
 * Inspect HTTP status code and HTML body for anti-bot or CAPTCHA blocks.
 */
export function detectAntiBot(status: number, htmlContent: string): AntiBotCheckResult {
  if (status === 403 || status === 429 || status === 503) {
    return {
      isBlocked: true,
      reason: `HTTP Status ${status} (Forbidden/Rate Limited/Service Unavailable)`,
    };
  }

  const lowerHtml = htmlContent.toLowerCase();
  for (const sig of ANTI_BOT_SIGNATURES) {
    if (lowerHtml.includes(sig.toLowerCase())) {
      return {
        isBlocked: true,
        reason: `Anti-bot / CAPTCHA signature detected: "${sig}"`,
      };
    }
  }

  return { isBlocked: false };
}

/**
 * Simple in-memory Per-Domain Rate Limiter
 */
export class RateLimiter {
  private lastRequestMap = new Map<string, number>();
  private domainQueues = new Map<string, Promise<void>>();
  private defaultDelayMs: number;

  constructor(defaultDelayMs = 500) {
    this.defaultDelayMs = defaultDelayMs;
  }

  /**
   * Extract hostname domain from URL
   */
  private getDomain(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return "default";
    }
  }

  /**
   * Enforce rate limit delay before executing request for a domain
   */
  async throttle(url: string, delayMs = this.defaultDelayMs): Promise<void> {
    const domain = this.getDomain(url);
    const previous = this.domainQueues.get(domain) || Promise.resolve();
    const scheduled = previous.then(async () => {
      const elapsed = Date.now() - (this.lastRequestMap.get(domain) || 0);
      if (elapsed < delayMs) {
        await new Promise((resolve) => setTimeout(resolve, delayMs - elapsed));
      }
      this.lastRequestMap.set(domain, Date.now());
    });
    this.domainQueues.set(domain, scheduled.catch(() => {}));
    await scheduled;
  }
}

export const globalRateLimiter = new RateLimiter(300);

/**
 * Proxy Manager for handling proxy URL selection and rotation
 */
export class ProxyManager {
  private proxies: string[];
  private currentIndex = 0;

  constructor(proxies: string[] = []) {
    this.proxies = proxies.filter((p) => p.trim().length > 0);
  }

  /**
   * Get current or next rotated proxy URL
   */
  getProxy(specificProxy?: string): string | undefined {
    if (specificProxy && specificProxy.trim().length > 0) {
      return specificProxy;
    }
    if (this.proxies.length === 0) {
      return undefined;
    }
    const proxy = this.proxies[this.currentIndex % this.proxies.length];
    this.currentIndex++;
    return proxy;
  }

  addProxy(proxyUrl: string): void {
    if (!this.proxies.includes(proxyUrl)) {
      this.proxies.push(proxyUrl);
    }
  }
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
}

/**
 * Retry an asynchronous function with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 500;
  const backoffFactor = options.backoffFactor ?? 2;

  let attempt = 0;
  let delay = initialDelayMs;

  while (true) {
    try {
      attempt++;
      return await fn();
    } catch (error: any) {
      if (attempt > maxRetries) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/HTTP (?:400|401|403|404|405|406|410|413|422)/.test(message) ||
          message.includes("Anti-Bot protection") || message.includes("Only HTTP/HTTPS") ||
          message.includes("private or local hosts") || message.includes("selector")) {
        throw error;
      }
      try {
        const { recordMetric } = await import("./metrics.js");
        recordMetric("retries");
      } catch {
        // Metrics must never change retry behavior.
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= backoffFactor;
    }
  }
}
