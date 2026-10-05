/**
 * Bóc tách code fence ở rìa ngoài cùng (outer boundary) của khối Markdown/JSON/XML.
 * Hỗ trợ các khối mở từ 3 đến 5 dấu backticks (```{3,5}), đặc biệt là ````markdown.
 * TUYỆT ĐỐI BẢO TOÀN toàn bộ code fences (```java, ```diff, ```text) lồng bên trong nội dung!
 */
export function stripOuterCodeFence(raw: string): string {
  if (!raw) return "";
  let trimmed = raw.trim();

  // Nhận diện thẻ mở: ```, ````, hoặc ````` kèm theo tag ngôn ngữ tùy chọn (markdown, md, json, xml, v.v.)
  const openMatch = trimmed.match(/^(`{3,5})[a-zA-Z0-9_-]*[ \t]*\r?\n/);
  if (!openMatch) {
    return trimmed;
  }

  const fenceTicks = openMatch[1]; // Số lượng backticks ở đầu (3, 4, hoặc 5)
  const contentAfterOpen = trimmed.slice(openMatch[0].length);

  // Tìm thẻ đóng tương ứng ở cuối: số lượng backtick bằng hoặc lớn hơn fenceTicks
  // Regex đóng kiểm tra đuôi dòng kết thúc bằng ít nhất fenceTicks dấu backtick
  const closePattern = new RegExp(`\\r?\\n\`{${fenceTicks.length},5}[ \\t]*$`);
  const closeMatch = contentAfterOpen.match(closePattern);

  if (closeMatch) {
    return contentAfterOpen.slice(0, contentAfterOpen.length - closeMatch[0].length).trim();
  }

  // Trường hợp dự phòng nếu đóng bằng ``` thông thường
  const fallbackCloseMatch = contentAfterOpen.match(/\r?\n`{3,5}[ \t]*$/);
  if (fallbackCloseMatch) {
    return contentAfterOpen.slice(0, contentAfterOpen.length - fallbackCloseMatch[0].length).trim();
  }

  return contentAfterOpen.trim();
}
