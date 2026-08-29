/** Render extracted Markdown in the metadata-header format used by Jina Reader. */
export function formatJinaReader(url: string, markdown: string): string {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  return `Title: ${title}\nURL Source: ${url}\nMarkdown Content:\n${markdown}`;
}
