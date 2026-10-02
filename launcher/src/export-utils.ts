import type { LogRecord, ConversationGroup, TraceGroup } from "./types";
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

/**
 * Định dạng tóm tắt log thành dạng văn bản / markdown dễ đọc để paste vào Slack, Jira, Issue
 */
export function formatLogsAsSummary(
  records: LogRecord[],
  title: string,
  durationMs: number
): string {
  const lines: string[] = [];
  lines.push(`=== LOG EXPORT: ${title} ===`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total Records: ${records.length}`);
  if (durationMs > 0) {
    lines.push(`Duration: ${(durationMs / 1000).toFixed(2)}s (${durationMs}ms)`);
  }
  lines.push("------------------------------------------------------------");

  for (const record of records) {
    const detail = record.detail || {};
    const safe = (detail.safeDetails as Record<string, unknown>) || {};
    const timeStr = record.at ? record.at.slice(11, 23) : "??:??:??.???";
    const levelStr = record.level ? record.level.toUpperCase().padEnd(5) : "INFO ";

    const preview =
      (typeof detail.line === "string" && detail.line.trim()) ||
      (typeof detail.message === "string" && detail.message.trim()) ||
      (typeof detail.command === "string" && `$ ${detail.command.trim()}`) ||
      (typeof safe.preview === "string" && safe.preview.trim()) ||
      (typeof safe.modelSlug === "string" && `Model: ${safe.modelSlug}`) ||
      "";

    let line = `[${timeStr}] [${levelStr}] ${record.event}`;
    if (preview) {
      line += ` | ${preview}`;
    }
    lines.push(line);
  }

  lines.push("------------------------------------------------------------");
  return lines.join("\n");
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
  extension: "json" | "jsonl" | "txt" | "md"
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

