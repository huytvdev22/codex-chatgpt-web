import type { LogRecord, ConversationGroup, TraceGroup, TraceSpan } from "./types";
import { getEventTranslation, translateDaemonLine } from "./event-translations";

/**
 * Định dạng mảng LogRecord thành Pretty JSON (indent 2)
 */
export function formatLogsAsPrettyJson(records: LogRecord[]): string {
  return JSON.stringify(records, null, 2);
}

/**
 * Định dạng mảng LogRecord thành chuẩn JSON Lines / NDJSON
 */
export function formatLogsAsJsonl(records: LogRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

export interface DisplayedColumnsConfig {
  time: boolean;
  level: boolean;
  event: boolean;
  message: boolean;
  duration: boolean;
  spanId: boolean;
  requestId: boolean;
}

export interface FormatDisplayedLogsOptions {
  spans: TraceSpan[];
  title: string;
  durationMs: number;
  visibleColumns: DisplayedColumnsConfig;
  isVietnameseEvents: boolean;
  timeSortOrder?: "asc" | "desc";
  showTurnBadge?: boolean;
  format?: "text" | "tsv" | "markdown";
}

/**
 * Định dạng timestamp mili-giây sang chuỗi HH:mm:ss.SSS
 */
function formatTime(ts: number | string): string {
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return String(ts).slice(11, 23);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Trích xuất message preview chính xác như hiển thị trên giao diện
 */
export function extractSpanMessage(span: TraceSpan, isVietnameseEvents: boolean): string {
  const detail = span.record.detail || {};
  const safe = (detail.safeDetails as Record<string, unknown>) || {};
  const daemonVi =
    isVietnameseEvents && typeof detail.line === "string"
      ? translateDaemonLine(detail.line)
      : null;

  const msg =
    (daemonVi && `${daemonVi} | ${detail.line}`) ||
    (typeof safe.userMessage === "string" && `[User]: ${safe.userMessage.trim()}`) ||
    (typeof safe.injectedPromptPreview === "string" && `[Prompt M365]: ${safe.injectedPromptPreview.trim()}`) ||
    (typeof safe.responsePreview === "string" && `[Phản hồi M365]: ${safe.responsePreview.trim()}`) ||
    (typeof safe.promptPreview === "string" && `[Prompt]: ${safe.promptPreview.trim()}`) ||
    (typeof detail.line === "string" && detail.line.trim()) ||
    (typeof detail.message === "string" && detail.message.trim()) ||
    (typeof detail.command === "string" && `$ ${detail.command.trim()}`) ||
    (typeof safe.preview === "string" && safe.preview.trim()) ||
    (typeof safe.outputPreview === "string" && safe.outputPreview.trim()) ||
    (typeof safe.url === "string" && safe.url.trim()) ||
    (typeof safe.method === "string" &&
      typeof safe.path === "string" &&
      `${safe.method} ${safe.path}`) ||
    (typeof detail.modelSlug === "string" && `Model: ${detail.modelSlug}`) ||
    "—";

  return msg.replace(/\r?\n/g, " ");
}

/**
 * Định dạng tóm tắt log tuân thủ chính xác theo những gì đang hiển thị trên bảng giao diện (WYSIWYG):
 * - Đúng các cột đang được người dùng bật trong Columns Picker
 * - Đúng thứ tự sắp xếp thời gian (Cũ nhất trước ↑ / Mới nhất trước ↓)
 * - Đúng tên sự kiện (Tiếng Việt có icon hoặc Tiếng Anh gốc)
 * - Đúng nội dung tin nhắn preview
 */
export function formatDisplayedLogsSummary(options: FormatDisplayedLogsOptions): string {
  const {
    spans,
    title,
    durationMs,
    visibleColumns,
    isVietnameseEvents,
    timeSortOrder = "asc",
    showTurnBadge = false,
    format = "text",
  } = options;

  // Xác định danh sách các cột đang hiển thị
  const activeCols: { key: keyof DisplayedColumnsConfig; label: string }[] = [];
  if (visibleColumns.time) activeCols.push({ key: "time", label: "TIME" });
  if (visibleColumns.level) activeCols.push({ key: "level", label: "LEVEL" });
  if (visibleColumns.event) activeCols.push({ key: "event", label: "EVENT" });
  if (visibleColumns.message) activeCols.push({ key: "message", label: "MESSAGE" });
  if (visibleColumns.duration) activeCols.push({ key: "duration", label: "DURATION" });
  if (visibleColumns.spanId) activeCols.push({ key: "spanId", label: "SPAN ID" });
  if (visibleColumns.requestId) activeCols.push({ key: "requestId", label: "REQUEST ID" });

  if (activeCols.length === 0) {
    activeCols.push({ key: "time", label: "TIME" });
    activeCols.push({ key: "event", label: "EVENT" });
    activeCols.push({ key: "message", label: "MESSAGE" });
  }

  const getCellValue = (span: TraceSpan, colKey: keyof DisplayedColumnsConfig): string => {
    switch (colKey) {
      case "time":
        return formatTime(span.startTime);
      case "level":
        return span.record.level ? span.record.level.toUpperCase() : "INFO";
      case "event": {
        const turnPrefix = showTurnBadge && span.turnIndex ? `[T${span.turnIndex}] ` : "";
        if (isVietnameseEvents) {
          const trans = getEventTranslation(span.name);
          return `${turnPrefix}${trans.icon} ${trans.labelVi}`;
        }
        return `${turnPrefix}${span.name}`;
      }
      case "message":
        return extractSpanMessage(span, isVietnameseEvents);
      case "duration":
        return span.durationMs > 0 ? `${span.durationMs}ms` : "—";
      case "spanId":
        return span.spanId || "—";
      case "requestId":
        return String(span.record.detail?.requestId || "—");
      default:
        return "—";
    }
  };

  // 1. Định dạng TSV (Tab-Separated Values) dán trực tiếp vào Excel / Google Sheets
  if (format === "tsv") {
    const tsvLines: string[] = [];
    tsvLines.push(activeCols.map((c) => c.label).join("\t"));
    for (const span of spans) {
      const row = activeCols.map((c) => getCellValue(span, c.key));
      tsvLines.push(row.join("\t"));
    }
    return tsvLines.join("\n");
  }

  // 2. Định dạng Markdown Table
  if (format === "markdown") {
    const mdLines: string[] = [];
    mdLines.push(`### 📋 Bảng Log: ${title}`);
    mdLines.push(`> Tổng số dòng: ${spans.length} | Sắp xếp: ${timeSortOrder === "asc" ? "Cũ nhất trước ↑" : "Mới nhất trước ↓"} | Ngôn ngữ: ${isVietnameseEvents ? "Tiếng Việt" : "Tiếng Anh"}`);
    mdLines.push("");
    mdLines.push(`| ${activeCols.map((c) => c.label).join(" | ")} |`);
    mdLines.push(`| ${activeCols.map(() => "---").join(" | ")} |`);
    for (const span of spans) {
      const row = activeCols.map((c) => getCellValue(span, c.key).replace(/\|/g, "\\|"));
      mdLines.push(`| ${row.join(" | ")} |`);
    }
    return mdLines.join("\n");
  }

  // 3. Định dạng Text Summary (văn bản chia cột thẳng hàng bằng |)
  const lines: string[] = [];
  lines.push(`=== LOG EXPORT (THEO ĐÚNG HIỂN THỊ): ${title} ===`);
  lines.push(`Thời gian xuất: ${new Date().toISOString()}`);
  lines.push(`Tổng số hàng: ${spans.length}${durationMs > 0 ? ` | Thời lượng: ${(durationMs / 1000).toFixed(2)}s (${durationMs}ms)` : ""}`);
  lines.push(`Cột hiển thị (${activeCols.length}): ${activeCols.map((c) => c.label).join(" | ")}`);
  lines.push(`Sắp xếp thời gian: ${timeSortOrder === "asc" ? "Cũ nhất trước (Oldest First ↑)" : "Mới nhất trước (Newest First ↓)"} | Ngôn ngữ sự kiện: ${isVietnameseEvents ? "Tiếng Việt" : "Gốc (Tiếng Anh)"}`);
  lines.push("----------------------------------------------------------------------------------------------------");

  // In tiêu đề cột
  lines.push(activeCols.map((c) => c.label).join(" | "));
  lines.push("----------------------------------------------------------------------------------------------------");

  // In các dòng dữ liệu
  for (const span of spans) {
    const row = activeCols.map((c) => getCellValue(span, c.key));
    lines.push(row.join(" | "));
  }

  lines.push("----------------------------------------------------------------------------------------------------");
  return lines.join("\n");
}

/**
 * Định dạng tóm tắt log (tương thích ngược)
 */
export function formatLogsAsSummary(
  records: LogRecord[],
  title: string,
  durationMs: number
): string {
  const fakeSpans: TraceSpan[] = records.map((r, i) => ({
    spanId: (r.detail?.spanId as string) || `span_${i}`,
    name: r.event,
    event: r.event,
    category: "generic",
    startTime: new Date(r.at).getTime() || Date.now(),
    durationMs: typeof r.detail?.durationMs === "number" ? r.detail.durationMs : 0,
    status: r.level === "error" ? "failed" : r.level === "warning" ? "warning" : "completed",
    record: r,
  }));

  return formatDisplayedLogsSummary({
    spans: fakeSpans,
    title,
    durationMs,
    visibleColumns: {
      time: true,
      level: true,
      event: true,
      message: true,
      duration: false,
      spanId: false,
      requestId: false,
    },
    isVietnameseEvents: true,
  });
}

/**
 * Tải nội dung văn bản về máy dưới dạng tệp tin (hỗ trợ cả Electron & Browser)
 */
export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * Sinh tên tệp tin an toàn theo ngữ cảnh
 */
export function generateExportFilename(
  prefix: string,
  id: string,
  extension: "json" | "jsonl" | "txt" | "md" | "tsv"
): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timeStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const cleanId = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 16);
  return `${prefix}_${cleanId}_${timeStr}.${extension}`;
}

/**
 * Xuất báo cáo Markdown phân tích luồng End-to-End & nội dung Message Payload thực tế
 * Tách biệt hoàn toàn khỏi System Log thông thường, hỗ trợ đọc hiểu luồng hoạt động trực quan.
 */
export function formatFlowPayloadReport(
  conversation: ConversationGroup,
  activeTrace?: TraceGroup | null
): string {
  const isSingleTurn = Boolean(activeTrace);
  const targetTraces = isSingleTurn && activeTrace ? [activeTrace] : conversation.traces;
  const allRecords = isSingleTurn && activeTrace ? activeTrace.records : conversation.records;

  const lines: string[] = [];

  // 1. Tiêu đề Báo cáo
  lines.push(`# 📑 BÁO CÁO FLOW HOẠT ĐỘNG & NỘI DUNG MESSAGE PAYLOAD`);
  lines.push(`> **Mục tiêu:** Kiểm tra cấu trúc dữ liệu thực tế tại từng mắt xích trong chuỗi xử lý (End-to-End Flow)`);
  lines.push(``);
  lines.push(`- **Hội thoại:** \`${conversation.title}\``);
  lines.push(`- **Conversation ID:** \`${conversation.conversationId}\``);
  lines.push(`- **Chế độ xem:** ${isSingleTurn ? `Lượt cụ thể (Turn / Trace ID: \`${activeTrace?.traceId}\`)` : `Toàn bộ cuộc hội thoại (${targetTraces.length} turns)`}`);
  lines.push(`- **Thời gian xuất:** \`${new Date().toISOString()}\``);
  lines.push(`- **Tổng thời lượng:** ${(conversation.durationMs / 1000).toFixed(2)}s | **Trạng thái:** \`${conversation.status.toUpperCase()}\``);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // 2. Sơ đồ Luồng Tổng thể (End-to-End Architecture)
  lines.push(`## 🗺️ 1. SƠ ĐỒ LUỒNG HOẠT ĐỘNG TỔNG THỂ (End-to-End Flow Architecture)`);
  lines.push(``);
  lines.push("```mermaid");
  lines.push("sequenceDiagram");
  lines.push("    autonumber");
  lines.push("    actor User as 👤 Người dùng (Codex Client / VS Code)");
  lines.push("    participant Server as 🚪 1. Ingress (Server Express)");
  lines.push("    participant Daemon as ⚙️ 2. Daemon (Runtime Queue)");
  lines.push("    participant Browser as 🌐 3. M365 Web Copilot");
  lines.push("    participant Parser as 🧩 4. Stream Parser & Loop Guard");
  lines.push("    participant Egress as 📡 5. SSE Egress");
  lines.push("");
  lines.push("    User->>Server: 1. Gửi HTTP POST /v1/chat/completions (Câu hỏi + Lịch sử)");
  lines.push("    Server->>Daemon: 2. Khởi tạo traceContext, xếp hàng đợi thực thi");
  lines.push("    Daemon->>Browser: 3. Điền Prompt bọc Template vào ô chat M365 (CDP)");
  lines.push("    Browser-->>Parser: 4. DOM Text Polling từng phần câu trả lời sinh ra");
  lines.push("    alt Phát hiện cú pháp Tool Call / Patch");
  lines.push("        Parser->>Egress: 4a. Bóc tách <tool_call> -> Stream delta tool_calls");
  lines.push("    else Văn bản thông thường");
  lines.push("        Parser->>Egress: 4b. Chuẩn hóa OpenAI SSE Chunk");
  lines.push("    end");
  lines.push("    Egress-->>User: 5. Hiển thị chữ mượt mà trên giao diện người dùng");
  lines.push("```");
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // 3. Chi tiết từng Turn & Payload thực tế
  lines.push(`## 🔍 2. NỘI DUNG MESSAGE PAYLOAD THỰC TẾ QUA TỪNG BƯỚC`);
  lines.push(``);

  targetTraces.forEach((trace, turnIdx) => {
    const turnNumber = turnIdx + 1;
    const records = trace.records;
    lines.push(`### 🎯 Turn #${turnNumber} ${trace.modelSlug ? `(Model: \`${trace.modelSlug}\`)` : ""} - Thời lượng: ${(trace.durationMs / 1000).toFixed(2)}s`);
    lines.push(`- **Trace ID:** \`${trace.traceId}\``);
    lines.push(`- **Thời gian bắt đầu:** \`${new Date(trace.startTime).toISOString()}\``);
    lines.push(`- **Trạng thái:** \`${trace.status.toUpperCase()}\``);
    lines.push(``);

    // Trích xuất các sự kiện chủ chốt
    const reqReceived = records.find((r) => r.event === "codex.request.received");
    const providerStarted = records.find((r) => r.event === "m365.provider.started");
    const providerFinished = records.find((r) => r.event === "m365.provider.finished");
    const toolDetected = records.filter((r) => r.event === "m365.tool.detected");
    const loopBlocked = records.find((r) => r.event === "m365.loop.blocked");
    const turnCompleted = records.find((r) => r.event === "m365.turn.completed");
    const sseCompleted = records.find((r) => r.event === "bridge.sse.completed");

    // Bước 1: Ingress
    lines.push(`#### 📥 Bước 1: Ingress - Câu hỏi từ Codex (User Prompt)`);
    if (reqReceived) {
      const safe = (reqReceived.detail?.safeDetails as Record<string, unknown>) || {};
      const userMsg = safe.userMessage || safe.promptPreview || reqReceived.detail?.message;
      lines.push(`- **Sự kiện ghi nhận:** \`codex.request.received\``);
      lines.push(`- **Model yêu cầu:** \`${safe.model || trace.modelSlug || "m365-copilot"}\``);
      lines.push(`- **Stream:** \`${safe.stream !== undefined ? safe.stream : true}\``);
      lines.push(``);
      lines.push(`**Nội dung câu hỏi người dùng nhận được:**`);
      lines.push("```text");
      lines.push(typeof userMsg === "string" && userMsg.trim() ? userMsg : "(Không có nội dung text do payload rỗng hoặc bị ẩn)");
      lines.push("```");
    } else {
      lines.push(`*(Không tìm thấy sự kiện codex.request.received trong lượt này)*`);
    }
    lines.push(``);

    // Bước 2: Daemon Runtime
    lines.push(`#### ⚙️ Bước 2: Tiến trình Daemon điều phối & Khởi tạo phiên`);
    const daemonLogs = records.filter((r) => r.event === "runtime.daemon_stdout");
    if (daemonLogs.length > 0) {
      lines.push(`- **Số dòng nhật ký Daemon:** ${daemonLogs.length}`);
      lines.push(`- **Các mốc trạng thái chính:**`);
      daemonLogs.slice(0, 8).forEach((d) => {
        const line = typeof d.detail?.line === "string" ? d.detail.line : "";
        const vi = translateDaemonLine(line);
        if (vi) {
          lines.push(`  - \`${d.at.slice(11, 23)}\`: **${vi}** (\`${line.trim()}\`)`);
        }
      });
    } else {
      lines.push(`*(Tiến trình daemon xử lý âm thầm không sinh log)*`);
    }
    lines.push(``);

    // Bước 3: M365 Browser Injection
    lines.push(`#### 🌐 Bước 3: M365 Browser - Prompt tiêm vào Web Copilot`);
    if (providerStarted) {
      const safe = (providerStarted.detail?.safeDetails as Record<string, unknown>) || {};
      const promptPreview = safe.injectedPromptPreview || safe.promptPreview;
      lines.push(`- **Sự kiện ghi nhận:** \`m365.provider.started\``);
      lines.push(`- **Tạo hội thoại M365 mới (isNewConversation):** \`${Boolean(safe.isNewConversation)}\``);
      if (safe.promptBytes) {
        lines.push(`- **Dung lượng Prompt đã gửi:** \`${safe.promptBytes} bytes\``);
      }
      lines.push(``);
      lines.push(`**Nội dung Prompt đã gửi vào giao diện M365 Copilot (kèm System/Tool Prompt):**`);
      lines.push("```text");
      lines.push(typeof promptPreview === "string" && promptPreview.trim() ? promptPreview : "(Prompt tiêm vào đang được bảo vệ hoặc chưa có preview)");
      lines.push("```");
    } else {
      lines.push(`*(Không có sự kiện m365.provider.started)*`);
    }
    lines.push(``);

    // Bước 4: Parser & Response
    lines.push(`#### 🧩 Bước 4: Parser - Phản hồi từ M365 & Bóc tách Tool`);
    if (providerFinished) {
      const safe = (providerFinished.detail?.safeDetails as Record<string, unknown>) || {};
      lines.push(`- **Sự kiện ghi nhận:** \`m365.provider.finished\``);
      lines.push(`- **Thời gian sinh chữ:** \`${safe.durationMs || "—"}ms\``);
      lines.push(`- **Tổng số ký tự phản hồi:** \`${safe.outputChars || "—"} chars\``);
      lines.push(`- **Trạng thái M365:** \`${safe.status || "completed"}\``);
      lines.push(``);
      if (safe.responsePreview) {
        lines.push(`**Nội dung phản hồi sinh ra từ M365 Copilot Web:**`);
        lines.push("```markdown");
        lines.push(String(safe.responsePreview));
        lines.push("```");
      }
    }
    if (toolDetected.length > 0) {
      lines.push(`\n**Các công cụ (Tool Calls) đã bóc tách được:**`);
      toolDetected.forEach((td, tIdx) => {
        const safe = (td.detail?.safeDetails as Record<string, unknown>) || {};
        lines.push(`- Tool #${tIdx + 1}: \`${safe.toolName || td.detail?.toolName || "unknown"}\` (Call ID: \`${safe.callId || "—"}\`)`);
      });
    }
    if (loopBlocked) {
      lines.push(`\n⚠️ **Cảnh báo Loop Guard:** Phát hiện lặp công cụ vô tận và đã chặn thành công.`);
    }
    lines.push(``);

    // Bước 5: Egress
    lines.push(`#### 📡 Bước 5: Egress - Truyền phát SSE về Client`);
    if (turnCompleted || sseCompleted) {
      lines.push(`- **Sự kiện kết thúc:** \`${sseCompleted ? "bridge.sse.completed" : "m365.turn.completed"}\``);
      lines.push(`- **Trạng thái:** Hoàn tất thành công (200 OK SSE stream finished)`);
    } else {
      lines.push(`- **Trạng thái:** Đang xử lý hoặc kết thúc đột ngột.`);
    }
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  });

  // 4. Bảng Dòng Thời Gian Kỹ Thuật Việt Hóa
  lines.push(`## 📊 3. DÒNG THỜI GIAN SỰ KIỆN CHI TIẾT (Chronological Timeline)`);
  lines.push(``);
  lines.push(`| Thời gian | Bước Flow | Tên sự kiện (Việt hóa) | Mã Event | Ghi chú / Chi tiết |`);
  lines.push(`|---|---|---|---|---|`);

  allRecords.forEach((r) => {
    const time = r.at ? r.at.slice(11, 23) : "—";
    const trans = getEventTranslation(r.event);
    const detail = r.detail || {};
    const safe = (detail.safeDetails as Record<string, unknown>) || {};
    const daemonVi = typeof detail.line === "string" ? translateDaemonLine(detail.line) : null;

    let note =
      daemonVi ||
      (typeof safe.userMessage === "string" && `User: ${safe.userMessage.slice(0, 60)}...`) ||
      (typeof safe.injectedPromptPreview === "string" && `Prompt: ${safe.injectedPromptPreview.slice(0, 60)}...`) ||
      (typeof safe.responsePreview === "string" && `Response: ${safe.responsePreview.slice(0, 60)}...`) ||
      (typeof detail.message === "string" && detail.message.slice(0, 60)) ||
      (typeof detail.line === "string" && detail.line.slice(0, 60)) ||
      "—";

    // Escape ký tự pipe | trong markdown table
    note = note.replace(/\|/g, "\\|").replace(/\n/g, " ");

    const phaseTag = trans.phase.split(" ")[1] || trans.phase;
    lines.push(`| \`${time}\` | ${phaseTag} | ${trans.icon} **${trans.labelVi}** | \`${r.event}\` | ${note} |`);
  });

  lines.push(``);
  lines.push(`*(Báo cáo được sinh tự động bởi Codex M365 Bridge Trace Explorer)*`);

  return lines.join("\n");
}

/**
 * Trích xuất dữ liệu thô phục vụ Debug Conversation qua 4 Step cốt lõi
 */
export interface DebugPipelineStation {
  stepIndex: number | string;
  stepName: string;
  summary: string;
  rawTitle: string;
  rawContent: string;
  rawFormat: "json" | "markdown" | "text";
  status: "success" | "warning" | "error" | "info";
  metadata?: Record<string, string | number | boolean>;
}

export interface DebugTurnInspection {
  turnIndex: number;
  traceId: string;
  requestId: string;
  model: string;
  durationMs: number;
  status: string;
  completionType: "tool_call" | "final_answer" | "unknown";
  terminalReason: string;
  terminalExplanation: string;
  steps: DebugPipelineStation[];
}

/**
 * Trích xuất text an toàn từ message content của Codex/OpenAI payload
 */
function extractMessageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          return (item as any).text || (item as any).content || "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    return (content as any).text || (content as any).output || JSON.stringify(content, null, 2);
  }
  return "";
}

/**
 * Phân tích và trích xuất dữ liệu qua 4 Step của từng Turn phục vụ Debug Conversation
 */
export function extractDebugInspectionFromTrace(
  trace: TraceGroup,
  turnIndex = 1
): DebugTurnInspection {
  const records = trace.records;
  const reqReceived = records.find((r) => r.event === "codex.request.received");
  const toolResults = records.filter(
    (r) => r.event === "codex.tool_result.received" || r.event === "codex.tool.result"
  );
  const providerStarted = records.find((r) => r.event === "m365.provider.started");
  const providerFinished = records.find((r) => r.event === "m365.provider.finished");
  const toolDetected = records.filter((r) => r.event === "m365.tool.detected");
  const loopUpdated = records.find((r) => r.event === "m365.loop.updated");
  const loopBlocked = records.find((r) => r.event === "m365.loop.blocked");
  const turnCompleted = records.find((r) => r.event === "m365.turn.completed");
  const sseCompleted = records.find((r) => r.event === "bridge.sse.completed");

  const reqSafe = (reqReceived?.detail?.safeDetails as Record<string, unknown>) || {};
  const providerStartedSafe = (providerStarted?.detail?.safeDetails as Record<string, unknown>) || {};
  const providerFinishedSafe = (providerFinished?.detail?.safeDetails as Record<string, unknown>) || {};
  const turnCompletedSafe = (turnCompleted?.detail?.safeDetails as Record<string, unknown>) || {};
  const sseSafe = (sseCompleted?.detail?.safeDetails as Record<string, unknown>) || {};
  const loopSafe = (loopUpdated?.detail?.safeDetails as Record<string, unknown>) || {};

  const completionType = (turnCompletedSafe.completionType as any) || (toolDetected.length > 0 ? "tool_call" : "final_answer");
  const requestId = String(trace.records[0]?.detail?.requestId || reqReceived?.detail?.requestId || "req_unknown");

  // Chẩn đoán lý do kết thúc / dừng lượt
  let terminalReason = String(turnCompletedSafe.terminalReason || "");
  let terminalExplanation = String(turnCompletedSafe.terminalExplanation || "");

  if (!terminalReason) {
    if (loopBlocked) {
      terminalReason = "loop_blocked";
      terminalExplanation = "Vòng lặp bị ngắt do vượt ngưỡng an toàn lặp lại.";
    } else if (completionType === "tool_call" || toolDetected.length > 0) {
      terminalReason = "tool_calls_emitted";
      terminalExplanation = `Bridge Server phát lệnh gọi ${toolDetected.length} công cụ về Codex. Codex tiếp tục chu trình agent.`;
    } else {
      terminalReason = "model_final_answer";
      terminalExplanation = "M365 Copilot hoàn tất câu trả lời kết luận (Final Answer). Codex dừng chu trình agent và chờ người dùng.";
    }
  }

  const steps: DebugPipelineStation[] = [];

  // ================= STEP 1: NỘI DUNG BRIDGE SERVER NHẬN TỪ CODEX =================
  // Nguyên tắc: RAW DATA là thông tin gốc 100% server nhận được từ HTTP request của Codex.
  // Tuyệt đối KHÔNG tự ý chèn chuỗi nhân tạo. Nếu có nhiều nội dung gửi (nhiều tool results
  // hoặc cả developer instructions và user message), chia nhỏ thành các sub-steps 1.1, 1.2...

  const userMessage = (reqSafe.userMessage as string) || (reqSafe.promptPreview as string) || "";
  const actualMessage = (reqSafe.actualMessage as string) || "";

  if (toolResults.length > 0) {
    if (toolResults.length === 1) {
      const tr = toolResults[0];
      const s = (tr.detail?.safeDetails as Record<string, unknown>) || {};
      const callId = String(s.toolCallId || tr.detail?.toolCallId || "call_1");
      const toolName = String(s.toolName || tr.detail?.toolName || "tool");
      const rawOut =
        typeof s.output === "string"
          ? s.output
          : typeof s.outputPreview === "string"
          ? s.outputPreview
          : s.output != null
          ? JSON.stringify(s.output, null, 2)
          : "";

      steps.push({
        stepIndex: 1,
        stepName: `Step 1: Nội dung Bridge Server nhận từ Codex (Tool Result - ${toolName})`,
        summary: `Kết quả thực thi công cụ "${toolName}" (${callId})`,
        rawTitle: `Dữ liệu thô từ Codex Tool Result (${callId})`,
        rawContent: rawOut || "(Nội dung kết quả rỗng)",
        rawFormat: rawOut.trim().startsWith("{") || rawOut.trim().startsWith("[") ? "json" : "text",
        status: "success",
        metadata: {
          "Công cụ": toolName,
          "Call ID": callId,
          "Ký tự": rawOut.length,
        },
      });
    } else {
      // Nhiều kết quả tool: Chia nhỏ thành các sub-steps 1.1, 1.2... bảo toàn dữ liệu thô từng lệnh
      toolResults.forEach((tr, i) => {
        const s = (tr.detail?.safeDetails as Record<string, unknown>) || {};
        const callId = String(s.toolCallId || tr.detail?.toolCallId || `call_${i + 1}`);
        const toolName = String(s.toolName || tr.detail?.toolName || "tool");
        const rawOut =
          typeof s.output === "string"
            ? s.output
            : typeof s.outputPreview === "string"
            ? s.outputPreview
            : s.output != null
            ? JSON.stringify(s.output, null, 2)
            : "";

        steps.push({
          stepIndex: `1.${i + 1}`,
          stepName: `Step 1.${i + 1}: Nội dung Bridge Server nhận từ Codex (Tool Result #${i + 1} - ${toolName})`,
          summary: `Kết quả thực thi công cụ "${toolName}" (${callId}) [${i + 1}/${toolResults.length}]`,
          rawTitle: `Dữ liệu thô từ Codex Tool Result #${i + 1} (${callId})`,
          rawContent: rawOut || "(Nội dung kết quả rỗng)",
          rawFormat: rawOut.trim().startsWith("{") || rawOut.trim().startsWith("[") ? "json" : "text",
          status: "success",
          metadata: {
            "Công cụ": toolName,
            "Call ID": callId,
            "Thứ tự": `${i + 1}/${toolResults.length}`,
            "Ký tự": rawOut.length,
          },
        });
      });
    }
  } else {
    // Không có tool results: Lượt User Prompt / Context / Khởi tạo
    const rawMsgs = (reqSafe.rawMessages as any[]) || [];
    const devMsgs = rawMsgs.filter(
      (m) => m && m.role === "developer" && m.type === "message"
    );
    const userMsgs = rawMsgs.filter(
      (m) => m && (m.role === "user" || (m.type === "message" && !m.role))
    );

    // Kiểm tra xem có message Developer riêng biệt chứa System Instruction không
    const devTexts = devMsgs
      .map((m) => extractMessageContentText(m.content))
      .filter(Boolean)
      .filter((t) => !t.startsWith("<codex_apps_client_time_context>"));

    if (devTexts.length > 0 && userMsgs.length > 0) {
      // Chia nhỏ thành Step 1.1 (Developer Instructions) và Step 1.2 (User Request & Context)
      const devContent = devTexts.join("\n\n");
      steps.push({
        stepIndex: "1.1",
        stepName: "Step 1.1: Nội dung Bridge Server nhận từ Codex (Chỉ dẫn hệ thống - Developer Instructions)",
        summary: `Chỉ dẫn hệ thống từ Codex (${devTexts.length} phần tử)`,
        rawTitle: "Chỉ dẫn hệ thống thô từ Codex (Developer Instructions)",
        rawContent: devContent,
        rawFormat: "text",
        status: "info",
        metadata: {
          "Vai trò": "developer",
          "Ký tự": devContent.length,
        },
      });

      const userParts = userMsgs
        .map((m) => extractMessageContentText(m.content))
        .filter(Boolean);
      const userContent = userParts.join("\n\n") || actualMessage || userMessage || "";

      steps.push({
        stepIndex: "1.2",
        stepName: "Step 1.2: Nội dung Bridge Server nhận từ Codex (Yêu cầu & Ngữ cảnh IDE - User Request)",
        summary: `Yêu cầu từ người dùng và ngữ cảnh môi trường IDE (${userContent.length.toLocaleString()} ký tự)`,
        rawTitle: "Yêu cầu và ngữ cảnh IDE thô từ Codex (User Prompt)",
        rawContent: userContent,
        rawFormat: "markdown",
        status: "success",
        metadata: {
          "Vai trò": "user",
          "Ký tự": userContent.length,
        },
      });
    } else {
      // Chỉ có 1 loại nội dung hoặc tin nhắn thuần túy
      let singleContent = "";
      if (userMsgs.length > 0) {
        singleContent = userMsgs.map((m) => extractMessageContentText(m.content)).filter(Boolean).join("\n\n");
      }
      if (!singleContent) {
        singleContent = actualMessage || userMessage || "";
      }
      if (!singleContent && rawMsgs.length > 0) {
        singleContent = JSON.stringify(rawMsgs, null, 2);
      }
      if (!singleContent) {
        singleContent = String(reqReceived?.detail?.message || "(Không nhận diện được nội dung tin nhắn thô từ Codex)");
      }

      steps.push({
        stepIndex: 1,
        stepName: "Step 1: Nội dung Bridge Server nhận từ Codex (User Request)",
        summary: `Yêu cầu nhận từ Codex (${singleContent.length.toLocaleString()} ký tự)`,
        rawTitle: "Nội dung nhận từ Codex (User Request)",
        rawContent: singleContent,
        rawFormat: singleContent.startsWith("{") || singleContent.startsWith("[") ? "json" : "markdown",
        status: reqReceived ? "success" : "info",
        metadata: {
          Model: String(reqSafe.model || trace.modelSlug || "m365-copilot"),
          "Ký tự": singleContent.length,
        },
      });
    }
  }

  // ================= STEP 2: NỘI DUNG BRIDGE SERVER GỬI LÊN M365 WEB =================
  const rawPrompt =
    (providerStartedSafe.rawPrompt as string) ||
    (providerStartedSafe.injectedPromptPreview as string) ||
    "";
  const promptBytes =
    (providerStartedSafe.promptBytes as number) ||
    (rawPrompt ? new TextEncoder().encode(rawPrompt).length : 0);

  steps.push({
    stepIndex: 2,
    stepName: "Step 2: Nội dung Bridge Server gửi lên M365 Web",
    summary: rawPrompt
      ? `Prompt đã tiêm vào ô chat M365 Web (${rawPrompt.length.toLocaleString()} ký tự)`
      : `Đang chuẩn bị gửi prompt tới M365 Copilot`,
    rawTitle: "Prompt tiêm vào ô chat M365 Web (CDP)",
    rawContent: rawPrompt || "(Chưa có dữ liệu Prompt được gửi)",
    rawFormat: "text",
    status: providerStarted ? "success" : "warning",
    metadata: {
      "Ký tự": rawPrompt.length,
      "Dung lượng": `${promptBytes} bytes`,
      "Phiên M365": providerStartedSafe.isNewConversation ? "New Chat" : "Continue",
    },
  });

  // ================= STEP 3: NỘI DUNG THÔ BRIDGE SERVER NHẬN TỪ M365 =================
  const rawResponse =
    (providerFinishedSafe.rawResponse as string) ||
    (providerFinishedSafe.responsePreview as string) ||
    "";
  const durationMs = (providerFinishedSafe.durationMs as number) || trace.durationMs || 0;

  steps.push({
    stepIndex: 3,
    stepName: "Step 3: Nội dung thô Bridge Server nhận từ M365",
    summary: rawResponse
      ? `Văn bản thô cào từ M365 Web (${rawResponse.length.toLocaleString()} ký tự trong ${(durationMs / 1000).toFixed(1)}s)`
      : `Chưa có phản hồi từ M365 Copilot`,
    rawTitle: "Văn bản thô cào từ giao diện M365 Web trước khi parse",
    rawContent: rawResponse || "(M365 Copilot chưa phản hồi hoặc phản hồi rỗng)",
    rawFormat: "markdown",
    status: providerFinished ? "success" : "warning",
    metadata: {
      "Thời gian sinh": `${durationMs}ms`,
      "Ký tự": rawResponse.length,
      "Trạng thái M365": String(providerFinishedSafe.status || "completed"),
    },
  });

  // ================= STEP 4: NỘI DUNG SAU KHI XỬ LÝ VÀ GỬI VỀ CODEX =================
  let point4Content = "";
  let point4Summary = "";
  let point4Format: "json" | "markdown" | "text" = "markdown";

  const toolCallsFromCompleted = turnCompletedSafe.toolCalls as any[];
  const outgoingFromSse = sseSafe.outgoingItems as any[];
  const finalAnswer = (turnCompletedSafe.finalAnswer as string) || "";

  if (completionType === "tool_call" || toolDetected.length > 0) {
    point4Format = "json";
    const toolsList = (toolCallsFromCompleted && toolCallsFromCompleted.length > 0)
      ? toolCallsFromCompleted
      : toolDetected.map((td) => {
          const s = (td.detail?.safeDetails as Record<string, unknown>) || {};
          return {
            id: s.callId || td.detail?.callId,
            name: s.toolName || td.detail?.toolName,
            arguments: s.arguments || td.detail?.arguments || {},
          };
        });

    point4Content = JSON.stringify(
      {
        type: "tool_calls",
        tool_calls: toolsList.map((t: any) => ({
          id: t.id,
          type: "function",
          function: {
            name: t.name,
            arguments: typeof t.arguments === "string" ? t.arguments : JSON.stringify(t.arguments, null, 2),
          },
        })),
        loopStatus: {
          iterations: loopSafe.toolIterations || 1,
          identicalToolCount: loopSafe.identicalToolCount || 0,
        },
      },
      null,
      2
    );
    point4Summary = `Phát lệnh gọi ${toolsList.length} công cụ về Codex: ${toolsList.map((t: any) => t.name).join(", ")}`;
  } else if (completionType === "title_response") {
    point4Content = finalAnswer || "Tiêu đề đã được tạo tự động.";
    point4Summary = `Phản hồi tiêu đề cuộc hội thoại về Codex`;
    point4Format = "text";
  } else {
    if (finalAnswer) {
      point4Content = finalAnswer;
    } else if (outgoingFromSse && outgoingFromSse.length > 0) {
      const msgItem = outgoingFromSse.find((item: any) => item.type === "message");
      point4Content = msgItem?.text || JSON.stringify(outgoingFromSse, null, 2);
    } else {
      point4Content = rawResponse || "(Phản hồi hoàn tất)";
    }
    point4Summary = `Trả lời kết luận gửi về Codex (${point4Content.length.toLocaleString()} ký tự)`;
    point4Format = "markdown";
  }

  steps.push({
    stepIndex: 4,
    stepName: "Step 4: Nội dung sau khi xử lý và gửi về Codex",
    summary: point4Summary,
    rawTitle: "Dữ liệu chuyển phát về cho Codex IDE",
    rawContent: point4Content,
    rawFormat: point4Format,
    status: loopBlocked ? "error" : "success",
    metadata: {
      "Loại kết quả": completionType === "tool_call" ? "Tool Calls" : "Final Answer",
      "Lý do kết thúc": terminalReason,
      "Ký tự": point4Content.length,
      "Vòng lặp": `${loopSafe.toolIterations || 1}`,
    },
  });

  return {
    turnIndex,
    traceId: trace.traceId,
    requestId,
    model: trace.modelSlug || "m365-copilot",
    durationMs: trace.durationMs,
    status: trace.status,
    completionType,
    terminalReason,
    terminalExplanation,
    steps,
  };
}

/**
 * Định dạng Báo cáo Debug Conversation chi tiết qua 4 Step dữ liệu thô
 */
export function formatDebugConversationReport(
  conversation: ConversationGroup,
  trace?: TraceGroup | null
): string {
  const targetTraces = trace ? [trace] : conversation.traces;
  const lines: string[] = [];

  lines.push(`# Debug Conversation Report`);
  lines.push(``);
  lines.push(`- **Conversation ID:** \`${conversation.conversationId}\``);
  lines.push(`- **Title:** \`${conversation.title}\``);
  lines.push(`- **Exported At:** \`${new Date().toISOString()}\``);
  lines.push(`- **Total Turns:** \`${targetTraces.length}\``);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  targetTraces.forEach((t, idx) => {
    const inspection = extractDebugInspectionFromTrace(t, idx + 1);

    lines.push(`## Turn #${inspection.turnIndex} [${inspection.completionType.toUpperCase()}] - Request: \`${inspection.requestId}\``);
    lines.push(`- **Trace ID:** \`${inspection.traceId}\``);
    lines.push(`- **Model:** \`${inspection.model}\` | **Duration:** \`${(inspection.durationMs / 1000).toFixed(2)}s\` | **Status:** \`${inspection.status.toUpperCase()}\``);
    lines.push(`- **Terminal Reason:** \`${inspection.terminalReason}\` (${inspection.terminalExplanation})`);
    lines.push(``);

    inspection.steps.forEach((st) => {
      lines.push(`### ${st.stepName}`);
      lines.push(`> **Tóm tắt:** ${st.summary}`);
      if (st.metadata) {
        const metaStr = Object.entries(st.metadata)
          .map(([k, v]) => `**${k}:** \`${v}\``)
          .join(" | ");
        lines.push(`> ${metaStr}`);
      }
      lines.push(``);
      lines.push(`\`\`\`${st.rawFormat}`);
      lines.push(st.rawContent);
      lines.push(`\`\`\``);
      lines.push(``);
    });

    lines.push(`---`);
    lines.push(``);
  });

  lines.push(`*(Báo cáo Debug Conversation được tạo tự động bởi Codex M365 Launcher)*`);
  return lines.join("\n");
}


