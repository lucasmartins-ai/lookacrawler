/**
 * Resilience, Proxying, and Anti-Bot Module for LookaCrawler
 */

export interface AntiBotCheckResult {
  isBlocked: boolean;
  reason?: string;
}

/**
 * Common Cloudflare and CAPTCHA challenge signatures in HTML/headers
 */
const ANTI_BOT_SIGNATURES = [
  "cf-browser-verification",
  "cloudflare",
  "just a moment...",
  "attention required!",
  "ddos-guard",
  "g-recaptcha",
  "hcaptcha",
  "cf-turnstile",
  "enable javascript and cookies to continue",
  "access denied",
  "robot check",
  "security check",
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
    const last = this.lastRequestMap.get(domain) || 0;
    const now = Date.now();
    const elapsed = now - last;

    if (elapsed < delayMs) {
      const waitTime = delayMs - elapsed;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.lastRequestMap.set(domain, Date.now());
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
      // If error indicates permanent bot block or 404, don't retry uselessly
      if (error.message && error.message.includes("HTTP 404")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= backoffFactor;
    }
  }
}
