/**
 * LookaCrawler CSV Safety Module
 * Neutralizes CSV Formula Injection (DDE) vectors to protect spreadsheets (Excel, Calc, Google Sheets).
 */

const FORMULA_PREFIXES = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * Sanitizes a single cell value. If the string starts with a formula trigger,
 * it prefixes it with a single quote (') to force Excel/Calc to treat it as plain text.
 */
export function sanitizeCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }

  const str = String(value);
  if (str.length === 0) {
    return str;
  }

  const firstRaw = str[0];
  if (firstRaw === "\t" || firstRaw === "\r") {
    return `'${str}`;
  }

  const trimmed = str.trimStart();
  if (trimmed.length === 0) {
    return str;
  }

  if (FORMULA_PREFIXES.has(trimmed[0])) {
    return `'${str}`;
  }

  return str;
}

/**
 * Sanitizes an array of cell values forming a CSV row.
 */
export function sanitizeCsvRow(row: (string | number | boolean | null | undefined)[]): string[] {
  return row.map(sanitizeCsvCell);
}

/**
 * Converts headers and row data into a RFC 4180-compliant, formula-injection-safe CSV string.
 */
export function toSafeCsv(
  headers: string[],
  rows: (string | number | boolean | null | undefined)[][]
): string {
  function escapeField(field: string): string {
    const sanitized = sanitizeCsvCell(field);
    if (
      sanitized.includes(",") ||
      sanitized.includes('"') ||
      sanitized.includes("\n") ||
      sanitized.includes("\r")
    ) {
      return `"${sanitized.replace(/"/g, '""')}"`;
    }
    return sanitized;
  }

  const headerLine = headers.map(escapeField).join(",");
  const rowLines = rows.map((row) => row.map((val) => escapeField(String(val ?? ""))).join(","));

  return [headerLine, ...rowLines].join("\r\n");
}
