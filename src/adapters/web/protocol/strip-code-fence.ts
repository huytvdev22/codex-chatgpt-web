/**
 * Bóc tách code fence ở rìa ngoài cùng (outer boundary) của khối Markdown/JSON/XML.
 * Hỗ trợ các khối mở từ 3 đến 5 dấu backticks, đặc biệt là khối 4-backtick markdown.
 * Bảo toàn toàn bộ code fence lồng bên trong nội dung.
 */
export function stripOuterCodeFence(raw: string): string {
  if (!raw) return "";

  const trimmed = raw.trim();
  const openMatch = trimmed.match(/^(`{3,5})[a-zA-Z0-9_-]*[ \t]*\r?\n/);

  if (!openMatch) {
    return trimmed;
  }

  const fenceTicks = openMatch[1];
  const contentAfterOpen = trimmed.slice(openMatch[0].length);
  const closePattern = new RegExp(`\\r?\\n\`{${fenceTicks.length},5}[ \\t]*$`);
  const closeMatch = contentAfterOpen.match(closePattern);

  if (closeMatch) {
    return contentAfterOpen
      .slice(0, contentAfterOpen.length - closeMatch[0].length)
      .trim();
  }

  const fallbackCloseMatch = contentAfterOpen.match(/\r?\n`{3,5}[ \t]*$/);

  if (fallbackCloseMatch) {
    return contentAfterOpen
      .slice(0, contentAfterOpen.length - fallbackCloseMatch[0].length)
      .trim();
  }

  return contentAfterOpen.trim();
}
