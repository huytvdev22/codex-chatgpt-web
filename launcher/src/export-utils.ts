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

