import { FastPathStreamBuffer } from "../adapters/web/protocol/fast-path-stream-buffer";
import { unwrapOptionalAssistantEnvelope } from "./assistant-response-parser";
import type { AssistantStreamGateState } from "./types";

const START_TOOL_MARKERS = [
  "<tool_call",
  "<custom_tool_call",
  "*** begin patch",
  "<thought",
  "<thinking",
];

const OPTIONAL_OPEN_WRAPPERS = [
  "````markdown\n",
  "````md\n",
  "````\n",
  "<webresponse>\n",
  "<webresponse>",
];

const MIDSTREAM_TOOL_REGEX =
  /<tool_call\b|<custom_tool_call\b|\*{3}\s*Begin Patch/i;

const TRAILING_MARKER_PREFIXES = [
  "<tool_call",
  "<custom_tool_call",
  "</webresponse>",
  "*** begin patch",
  "\n````",
  "````",
];

const MAX_TAIL_HOLDBACK_CHARS = 24;

function isPrefixOfAny(candidateLower: string, targets: readonly string[]): boolean {
  if (!candidateLower) return false;
  return targets.some((target) => target.startsWith(candidateLower));
}

function stripOptionalOpeningWrappers(input: string): {
  stripped: string;
  stillAmbiguous: boolean;
} {
  let cursor = input.trimStart();
  while (cursor.length > 0) {
    const lower = cursor.toLowerCase();

    const fenceOpen = /^`{4}(?:markdown|md)?[ \t]*\r?\n/.exec(cursor);
    if (fenceOpen) {
      cursor = cursor.slice(fenceOpen[0].length).trimStart();
      continue;
    }

    const envOpen = /^<webResponse\b[^>]*>\s*/i.exec(cursor);
    if (envOpen) {
      cursor = cursor.slice(envOpen[0].length).trimStart();
      continue;
    }

    if (isPrefixOfAny(lower, OPTIONAL_OPEN_WRAPPERS)) {
      return { stripped: cursor, stillAmbiguous: true };
    }
    break;
  }
  return { stripped: cursor, stillAmbiguous: false };
}

/**
 * Tìm vị trí bắt đầu của thẻ công cụ thực thi nằm NGOÀI code fence ` ```...``` `.
 */
function findExecutableToolMarkerIndex(text: string): number {
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let lineStart = 0;

  while (lineStart < text.length) {
    const nl = text.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd);

    const fenceMatch = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!inFence) {
      if (fenceMatch) {
        inFence = true;
        fenceChar = fenceMatch[1][0];
        fenceLen = fenceMatch[1].length;
        lineStart = nl === -1 ? text.length : nl + 1;
        continue;
      }
      const markerMatch = MIDSTREAM_TOOL_REGEX.exec(line);
      if (markerMatch) {
        return lineStart + markerMatch.index;
      }
    } else if (
      fenceMatch &&
      fenceMatch[1][0] === fenceChar &&
      fenceMatch[1].length >= fenceLen &&
      fenceMatch[2].trim() === ""
    ) {
      inFence = false;
    }

    lineStart = nl === -1 ? text.length : nl + 1;
  }

  return -1;
}

/**
 * Tính số ký tự cuối cùng cần tạm giữ (holdback) để tránh phát lọt nửa thẻ
 * `<tool_call`, `<custom_tool_call`, `</webResponse>` hoặc dấu đóng ```` khi đang stream.
 */
function computeTailHoldbackLength(text: string): number {
  if (!text) return 0;
  const tailWindow = text.slice(-MAX_TAIL_HOLDBACK_CHARS);
  const tailLower = tailWindow.toLowerCase();

  for (let len = tailLower.length; len >= 1; len -= 1) {
    const suffix = tailLower.slice(tailLower.length - len);
    if (isPrefixOfAny(suffix, TRAILING_MARKER_PREFIXES)) {
      return len;
    }
  }
  return 0;
}

function longestCommonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) {
    i += 1;
  }
  return i;
}

/**
 * Bộ cổng điều phối Streaming cho Trợ lý Telegram (`src/assistant/`):
 * - Chặn tuyệt đối khi AI bắt đầu hoặc chèn `<tool_call>` / `<custom_tool_call>` / `*** Begin Patch`.
 * - Phát `text_delta` tăng dần ngay khi xác nhận đây là câu trả lời văn bản tự nhiên.
 * - Giữ đuôi an toàn (tail-holdback) để không lộ thẻ đóng `</webResponse>` hay backtick thừa.
 */
export class AssistantStreamGate {
  private state: AssistantStreamGateState = "BUFFERING";
  private readonly buffer = new FastPathStreamBuffer();
  private emittedText = "";

  constructor(private readonly onTextDelta: (delta: string) => void) {}

  public getState(): AssistantStreamGateState {
    return this.state;
  }

  public hasStreamedText(): boolean {
    return this.emittedText.length > 0;
  }

  public getEmittedText(): string {
    return this.emittedText;
  }

  public pushSnapshot(rawSnapshot: string): void {
    if (!rawSnapshot || this.state === "BLOCKED_TOOL_CALL") return;

    this.buffer.observe(rawSnapshot);
    const fullRaw = this.buffer.getText();
    if (!fullRaw) return;

    const { stripped, stillAmbiguous } = stripOptionalOpeningWrappers(fullRaw);
    if (stillAmbiguous || !stripped) {
      return;
    }

    const lower = stripped.toLowerCase();

    if (this.state === "BUFFERING") {
      if (START_TOOL_MARKERS.some((marker) => lower.startsWith(marker))) {
        this.state = "BLOCKED_TOOL_CALL";
        return;
      }
      if (isPrefixOfAny(lower, START_TOOL_MARKERS)) {
        return;
      }
      // Chờ thêm một chút nếu bắt đầu bằng ký tự có thể mở thẻ/fence mà chưa đủ rõ ràng.
      if (
        stripped.length < 16 &&
        (stripped.startsWith("<") || stripped.startsWith("`") || stripped.startsWith("*"))
      ) {
        return;
      }
      this.state = "STREAMING_TEXT";
    }

    // Kiểm tra tool call xuất hiện giữa chừng (AI lỡ viết 1 câu dẫn rồi mới mở `<tool_call>`).
    const midstreamToolIdx = findExecutableToolMarkerIndex(stripped);
    if (midstreamToolIdx >= 0) {
      const safeBeforeTool = stripped.slice(0, midstreamToolIdx).replace(/\s+$/, "");
      this.emitMonotonicDelta(safeBeforeTool);
      this.state = "BLOCKED_TOOL_CALL";
      return;
    }

    const withoutCompletedClosing = stripped.replace(
      /\s*<\/\s*webResponse\s*>(?:\s*`{0,4})?\s*$/i,
      "",
    );
    const holdback = computeTailHoldbackLength(withoutCompletedClosing);
    const safePrefix =
      holdback > 0
        ? withoutCompletedClosing.slice(0, withoutCompletedClosing.length - holdback)
        : withoutCompletedClosing;
    this.emitMonotonicDelta(safePrefix);
  }

  /**
   * Chốt phần văn bản cuối cùng sau khi Web AI sinh xong 100%.
   * Trả về phần delta còn thiếu (nếu có) và đã gọi `onTextDelta` tương ứng.
   */
  public finalizeAsFinalAnswer(finalContent: string): string {
    const cleanFinal = unwrapOptionalAssistantEnvelope(finalContent);
    if (!cleanFinal) return "";

    if (!this.emittedText) {
      this.emittedText = cleanFinal;
      this.onTextDelta(cleanFinal);
      return cleanFinal;
    }

    if (cleanFinal.startsWith(this.emittedText)) {
      const remaining = cleanFinal.slice(this.emittedText.length);
      if (remaining) {
        this.emittedText = cleanFinal;
        this.onTextDelta(remaining);
      }
      return remaining;
    }

    // Nếu bản Markdown cuối cùng có chỉnh sửa nhỏ ở giữa chuỗi đã stream:
    // chỉ phát tiếp phần mới vượt quá độ dài đã phát để không làm trùng lặp nội dung trên SSE.
    const lcp = longestCommonPrefixLength(this.emittedText, cleanFinal);
    if (cleanFinal.length > this.emittedText.length && lcp >= Math.floor(this.emittedText.length * 0.7)) {
      const remaining = cleanFinal.slice(this.emittedText.length);
      if (remaining) {
        this.emittedText += remaining;
        this.onTextDelta(remaining);
      }
      return remaining;
    }

    return "";
  }

  private emitMonotonicDelta(safeCandidate: string): void {
    if (!safeCandidate || safeCandidate.length <= this.emittedText.length) {
      return;
    }
    if (!this.emittedText) {
      this.emittedText = safeCandidate;
      this.onTextDelta(safeCandidate);
      return;
    }
    if (safeCandidate.startsWith(this.emittedText)) {
      const delta = safeCandidate.slice(this.emittedText.length);
      if (delta) {
        this.emittedText = safeCandidate;
        this.onTextDelta(delta);
      }
      return;
    }
    // Chống jitter nhẹ khi Turndown cập nhật định dạng Markdown lúc đang gõ
    const lcp = longestCommonPrefixLength(this.emittedText, safeCandidate);
    if (lcp >= Math.floor(this.emittedText.length * 0.85)) {
      const delta = safeCandidate.slice(this.emittedText.length);
      if (delta) {
        this.emittedText += delta;
        this.onTextDelta(delta);
      }
    }
  }
}
