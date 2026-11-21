/**
 * One vocabulary for "why did this URL fail", shared by the CLI envelope,
 * enrichment results and anything that decides what to do next (retry,
 * mark the lead's domain dead, escalate, give up).
 *
 * ponytail: classification by message text, because every layer below
 * (Bun fetch, the egress guard, Playwright, dns) reports failures as strings.
 * Move to typed errors if a layer starts throwing its own classes.
 */
export type FailureStatus =
  | "dead_domain" //        DNS has no record: the site is gone or the URL is wrong
  | "blocked_private" //    resolves to a private/local address, refused by policy
  | "connection_failed" //  host refused or reset the connection
  | "timeout"
  | "anti_bot" //           403/challenge page from a bot wall
  | "http_error" //         any other non-2xx answer
  | "parse_error" //        page fetched but its HTML could not be converted
  | "invalid_input" //      bad URL, scheme, credentials in URL
  | "error";

const RULES: Array<[FailureStatus, RegExp]> = [
  // EAI_AGAIN is a resolver hiccup, not a missing domain: it must not mark a lead dead.
  ["connection_failed", /EAI_AGAIN/],
  // Our own "Connection to <host> failed" wins over any token inside the host or detail.
  ["connection_failed", /^Connection to \S+ failed/],
  // A site that answered is never dead, whatever its status text says.
  ["http_error", /^HTTP \d{3}/],
  ["parse_error", /^PDF could not be parsed/],
  ["dead_domain", /ENOTFOUND|Could not resolve|DNS lookup failed/i],
  ["blocked_private", /private or local hosts/i],
  ["invalid_input", /Target URL is invalid|Only HTTP\/HTTPS|cannot contain credentials|Missing target URL/i],
  ["timeout", /timed out|timeout/i],
  ["anti_bot", /Anti-Bot protection/i],
  ["connection_failed", /ECONNREFUSED|ECONNRESET|socket connection was closed|Connection to .* failed|socket hang up|EPIPE/i],
  ["http_error", /HTTP \d{3}/],
  ["parse_error", /HTML could not be converted/i],
];

export function classifyFailure(error: unknown): FailureStatus {
  const message = error instanceof Error ? error.message : String(error ?? "");
  for (const [status, re] of RULES) if (re.test(message)) return status;
  return "error";
}

export function failureEnvelope<T extends Record<string, unknown>>(error: unknown, extra?: T) {
  const reason = error instanceof Error ? error.message : String(error ?? "unknown error");
  return { ok: false as const, status: classifyFailure(reason), reason, ...extra } as {
    ok: false;
    status: FailureStatus;
    reason: string;
  } & T;
}
