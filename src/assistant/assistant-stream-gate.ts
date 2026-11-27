import { FastPathStreamBuffer } from "../adapters/web/protocol/fast-path-stream-buffer";
import {
  normalizeEscapedToolMarkers,
  unwrapOptionalAssistantEnvelope,
} from "./assistant-response-parser";
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
  "````xml\n",
  "````\n",
  "<webresponse>\n",
  "<webresponse>",
];

const MIDSTREAM_TOOL_REGEX =
  /<webResponse\b|<tool_call\b|<custom_tool_call\b|<\/?(?:thought|thinking)\b|\*{3}\s*Begin Patch/i;

const TRAILING_MARKER_PREFIXES = [
  "<webresponse",
  "\n<webresponse",
  "</webresponse>",
  "<tool_call",
  "<custom_tool_call",
  "<thought",
  "<thinking",
  "*** begin patch",
  "\n````markdown",
  "````markdown",
  "\n````",
  "````",
];

const MAX_TAIL_HOLDBACK_CHARS = 32;

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

    const fenceOpen = /^`{4}(?:markdown|md|xml)?[ \t]*\r?\n/.exec(cursor);
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
        // Nếu là 4-backtick transport fence bọc Action Turn (<webResponse> / tool call), cắt ngay tại dấu mở ````.
        if (fenceMatch[1].length >= 4 && fenceMatch[1][0] === "`") {
          const nextBody = text.slice(nl === -1 ? text.length : nl + 1).trimStart();
          const lowerNext = nextBody.toLowerCase();
          if (
            /^(?:<webResponse\b|<tool_call\b|<custom_tool_call\b|<\/?(?:thought|thinking)\b|\*{3}\s*Begin Patch)/i.test(
              nextBody,
            ) ||
            isPrefixOfAny(lowerNext, ["<webresponse>", "<tool_call>", "<custom_tool_call>", "*** begin patch"])
          ) {
            return lineStart;
          }
        }
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

function stripInlineFormattingChars(text: string): {
  plain: string;
  originalIndexByPlain: number[];
} {
  let plain = "";
  const originalIndexByPlain: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "*" || ch === "_" || ch === "`") {
      continue;
    }
    plain += ch;
    originalIndexByPlain.push(i);
  }
  return { plain, originalIndexByPlain };
}

function extractAlignedRemainingText(
  emittedText: string,
  candidate: string,
  minLcpRatio: number,
  fallbackOnMismatch = false,
): string {
  if (!candidate) return "";
  if (!emittedText) return candidate;
  if (candidate.startsWith(emittedText)) {
    return candidate.slice(emittedText.length);
  }

  const lcp = longestCommonPrefixLength(emittedText, candidate);
  if (lcp >= Math.floor(emittedText.length * minLcpRatio)) {
    // Khi DOM streaming chưa in đậm nhưng bản Markdown cuối thêm `**...**` ở giữa chuỗi,
    // căn neo theo đoạn đuôi thực tế của `emittedText` để không cắt lệch và lặp chữ.
    const maxAnchor = Math.min(32, emittedText.length);
    for (let anchorLen = maxAnchor; anchorLen >= 6; anchorLen -= 2) {
      const anchor = emittedText.slice(-anchorLen);
      if (!anchor.trim()) continue;
      const searchStart = Math.max(0, emittedText.length - anchorLen - 24);
      const matchIdx = candidate.indexOf(anchor, searchStart);
      if (matchIdx >= 0) {
        let tail = candidate.slice(matchIdx + anchorLen);
        const emittedBoldCount = (emittedText.match(/\*\*/g) ?? []).length;
        if (emittedBoldCount % 2 === 0 && tail.startsWith("**")) {
          tail = tail.slice(2);
        }
        return tail;
      }
    }

    return candidate.length > emittedText.length ? candidate.slice(emittedText.length) : "";
  }

  if (!fallbackOnMismatch) {
    return "";
  }

  // Trường hợp clipboard finalize chèn **bold** hoặc `code` ngay ở phần đầu khiến LCP thấp,
  // khớp tiếp phần văn bản thuần để chỉ lấy đúng đoạn đuôi còn thiếu.
  const emittedPlain = stripInlineFormattingChars(emittedText).plain;
  const candidateMap = stripInlineFormattingChars(candidate);
  if (emittedPlain.length >= 6) {
    if (candidateMap.plain === emittedPlain) {
      return "";
    }
    if (candidateMap.plain.startsWith(emittedPlain)) {
      const lastMatchedOrigIdx = candidateMap.originalIndexByPlain[emittedPlain.length - 1];
      let tail = candidate.slice(lastMatchedOrigIdx + 1);
      if (tail.startsWith("**")) {
        tail = tail.slice(2);
      }
      return tail;
    }
  }

  // Không nối `\n\n${candidate}` khi snapshot streaming đã đi một nhánh format khác:
  // bản chốt cuối sạch sẽ được gửi qua `done.finalText` -> `response.output_item.done`
  // để client ghi đè sạch thay vì hiển thị lặp đôi cả 2 bản.
  return "";
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

    const markerView = normalizeEscapedToolMarkers(stripped);
    const lower = markerView.toLowerCase();

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
        markerView.length < 18 &&
        (markerView.startsWith("<") || markerView.startsWith("`") || markerView.startsWith("*") || markerView.startsWith("\\*"))
      ) {
        return;
      }
      this.state = "STREAMING_TEXT";
    }

    // Kiểm tra tool call xuất hiện giữa chừng (AI lỡ viết 1 câu dẫn rồi mới mở `<tool_call>` hoặc `<tool\_call>`).
    const midstreamToolIdx = findExecutableToolMarkerIndex(markerView);
    if (midstreamToolIdx >= 0) {
      const safeBeforeTool = markerView.slice(0, midstreamToolIdx).replace(/\s+$/, "");
      this.emitMonotonicDelta(safeBeforeTool);
      this.state = "BLOCKED_TOOL_CALL";
      return;
    }

    const withoutCompletedClosing = stripped.replace(
      /\s*<\/\s*webResponse\s*>(?:\s*`{0,4})?\s*$/i,
      "",
    );
    const holdback = computeTailHoldbackLength(normalizeEscapedToolMarkers(withoutCompletedClosing));
    // Nếu cuối chuỗi gốc chứa dấu backslash escape (vd `<tool\_`), lùi thêm cho an toàn nếu độ dài khớp khác nhẹ.
    const safeHoldback =
      holdback > 0
        ? Math.min(
            withoutCompletedClosing.length,
            holdback + (withoutCompletedClosing.slice(-holdback - 4).includes("\\_") ? 2 : 0),
          )
        : 0;
    const safePrefix =
      safeHoldback > 0
        ? withoutCompletedClosing.slice(0, withoutCompletedClosing.length - safeHoldback)
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

    const remaining = extractAlignedRemainingText(this.emittedText, cleanFinal, 0.7, true);
    if (remaining) {
      this.emittedText = cleanFinal;
      this.onTextDelta(remaining);
    }
    return remaining;
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
    const delta = extractAlignedRemainingText(this.emittedText, safeCandidate, 0.85);
    if (delta) {
      this.emittedText += delta;
      this.onTextDelta(delta);
    }
  }
}
