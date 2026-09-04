/** Render extracted Markdown in the metadata-header format used by Jina Reader. */
export function formatJinaReader(url: string, markdown: string): string {
  const h1 = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const firstLine = markdown.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const title = h1 || (firstLine.startsWith("#") ? firstLine.replace(/^#+\s*/, "") : firstLine) || "";
  return `Title: ${title}\nURL Source: ${url}\nMarkdown Content:\n${markdown}`;
}
