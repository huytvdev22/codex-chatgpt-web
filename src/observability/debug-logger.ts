/**
 * Module tiện ích in log chuẩn hóa cho 4 điểm chạm (Debug Pipeline Stations)
 * Tuân thủ nguyên lý Single Responsibility (SOLID)
 */
export function logDebugPipelineStation(
  step: 1 | 2 | 3 | 4,
  title: string,
  content: string | unknown,
): void {
  const line = "=".repeat(80);
  const text =
    typeof content === "string"
      ? content.trim()
      : content != null
      ? JSON.stringify(content, null, 2)
      : "";

  console.log(`\n${line}`);
  console.log(`>>> [DEBUG PIPELINE] STEP ${step}: ${title}`);
  console.log(line);
  console.log(text || "(Trống)");
  console.log(`${line}\n`);
}
