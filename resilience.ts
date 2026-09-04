import { recordMetric } from "./metrics.js";

/**
 * Resilience, Proxying, and Anti-Bot Module for LookaCrawler
 */

export interface AntiBotCheckResult {
  isBlocked: boolean;
  reason?: string;
  isRetryable?: boolean;
}

/**
 * High-confidence challenge markers that indicate an active anti-bot interstitial.
 */
const CHALLENGE_SIGNATURES = [
  "just a moment...",
  "attention required!",
  "checking your browser before accessing",
  "verify you are human",
  "cf-browser-verification",
  "cf-chl-",
  "cf-turnstile",
  // Cloudflare's "Verify you are human" turnstile gate.
  "cf-turnstile-widget",
  "cloudflarecaptcha",
  "challenges.cloudflare.com",
  "ddos-guard",
];

const CAPTCHA_DOM_MARKERS = [
  "class=\"cf-turnstile\"",
  "class='cf-turnstile'",
  "id=\"cf-turnstile\"",
  "id='cf-turnstile'",
  "class=\"g-recaptcha\"",
  "class='g-recaptcha'",
  "class=\"h-captcha\"",
  "class='h-captcha'",
  "<form id=\"challenge-form\"",
  "<form id='challenge-form'",
];

/**
 * Inspect HTTP status code and HTML body for anti-bot or CAPTCHA blocks.
 */
export function detectAntiBot(status: number, htmlContent: string): AntiBotCheckResult {
  if (status === 403) {
    return {
      isBlocked: true,
      reason: `HTTP Status 403 (Forbidden / Bot Blocked)`,
      isRetryable: false,
    };
  }

  if (status === 429) {
    return {
      isBlocked: true,
      reason: `HTTP Status 429 (Rate Limited)`,
      isRetryable: true,
    };
  }

  if (status === 503) {
    return {
      isBlocked: true,
      reason: `HTTP Status 503 (Service Unavailable)`,
      isRetryable: true,
    };
  }

  const lowerHtml = htmlContent.toLowerCase();

  // Check high confidence challenge signatures
  for (const sig of CHALLENGE_SIGNATURES) {
    if (lowerHtml.includes(sig)) {
      return {
        isBlocked: true,
        reason: `Anti-bot / CAPTCHA signature detected: "${sig}"`,
        isRetryable: false,
      };
    }
  }

  // Check explicit captcha DOM widgets
  for (const marker of CAPTCHA_DOM_MARKERS) {
    if (lowerHtml.includes(marker.toLowerCase())) {
      return {
        isBlocked: true,
        reason: `Interactive CAPTCHA widget detected: "${marker}"`,
        isRetryable: false,
      };
    }
  }

  // Check page title for standalone block messages
  const titleMatch = htmlContent.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const pageTitle = titleMatch[1].trim().toLowerCase();
    if (
      pageTitle === "access denied" ||
      pageTitle === "robot check" ||
      pageTitle === "security check" ||
      pageTitle === "blocked" ||
      pageTitle.startsWith("just a moment")
    ) {
      return {
        isBlocked: true,
        reason: `Anti-bot challenge title detected: "${titleMatch[1].trim()}"`,
        isRetryable: false,
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
      const isRetryableStatus = message.includes("429") || message.includes("503") ||
        message.includes("Rate Limited") || message.includes("Service Unavailable");

      if (!isRetryableStatus) {
        if (/HTTP (?:400|401|403|404|405|406|410|413|422)/.test(message) ||
            message.includes("Anti-Bot protection") || message.includes("Only HTTP/HTTPS") ||
            message.includes("private or local hosts") || message.includes("selector")) {
          throw error;
        }
      }

      recordMetric("retries");
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= backoffFactor;
    }
  }
}
