/**
 * Từ điển ánh xạ và Việt hóa các sự kiện trong hệ thống Codex M365 Bridge
 * Phục vụ mục đích giải thích trực quan và định vị chính xác vị trí trong Flow hoạt động.
 */

export interface EventTranslation {
  /** Tên tiếng Việt ngắn gọn, dễ hiểu */
  labelVi: string;
  /** Giải thích chi tiết ý nghĩa kỹ thuật */
  descVi: string;
  /** Mắt xích / Giai đoạn trong Flow tổng thể */
  phase: "1. Ingress (Cổng vào)" | "2. Daemon (Tiến trình nền)" | "3. M365 Browser (Trình duyệt)" | "4. Parser (Phân tích)" | "5. Egress (Cổng ra)";
  /** Icon trực quan đại diện */
  icon: string;
}

const EVENT_TRANSLATIONS: Record<string, EventTranslation> = {
  "codex.request.received": {
    labelVi: "Nhận yêu cầu từ Codex",
    descVi: "Server nhận HTTP POST /v1/chat/completions kèm câu hỏi của bạn từ giao diện chat",
    phase: "1. Ingress (Cổng vào)",
    icon: "📥",
  },
  "trace.context.resolved": {
    labelVi: "Khởi tạo ngữ cảnh Trace",
    descVi: "Server gán mã phiên theo dõi (traceId, conversationId) cho toàn bộ vòng đời lượt chat",
    phase: "1. Ingress (Cổng vào)",
    icon: "🔗",
  },
  "codex.tool_result.received": {
    labelVi: "Nhận kết quả thực thi Tool",
    descVi: "IDE đã chạy xong lệnh trên máy và gửi kết quả thực thi về cho AI xem",
    phase: "1. Ingress (Cổng vào)",
    icon: "📋",
  },
  "m365.provider.started": {
    labelVi: "Gửi Prompt vào M365 Copilot",
    descVi: "Robot kết nối phiên web M365 Copilot, điền prompt đã bọc template và nhấn Gửi",
    phase: "3. M365 Browser (Trình duyệt)",
    icon: "🚀",
  },
  "m365.tool.detected": {
    labelVi: "Phát hiện gọi công cụ (Tool Call)",
    descVi: "Copilot phản hồi yêu cầu đọc file, chạy lệnh terminal hoặc chỉnh sửa code dự án",
    phase: "4. Parser (Phân tích)",
    icon: "🛠️",
  },
  "m365.loop.updated": {
    labelVi: "Cập nhật vòng lặp Tool",
    descVi: "Ghi nhận số lần thực thi công cụ liên tiếp trong cùng một lượt suy luận",
    phase: "4. Parser (Phân tích)",
    icon: "🔄",
  },
  "m365.loop.blocked": {
    labelVi: "Chặn vòng lặp vô tận (Loop Guard)",
    descVi: "Hệ thống phát hiện AI gọi công cụ trùng lặp quá nhiều lần và tự động ngắt an toàn",
    phase: "4. Parser (Phân tích)",
    icon: "🛑",
  },
  "m365.provider.finished": {
    labelVi: "M365 Copilot hoàn tất sinh chữ",
    descVi: "Trình duyệt nhận đủ văn bản từ Copilot, nút Stop biến mất, chữ đã ổn định",
    phase: "4. Parser (Phân tích)",
    icon: "✅",
  },
  "m365.turn.completed": {
    labelVi: "Đóng gói câu trả lời lượt chat",
    descVi: "Adapter chuẩn hóa toàn bộ câu trả lời về định dạng chuẩn của OpenAI",
    phase: "5. Egress (Cổng ra)",
    icon: "📦",
  },
  "bridge.sse.completed": {
    labelVi: "Hoàn tất luồng SSE gửi về Chat",
    descVi: "Server hoàn tất việc stream từng từ và gửi frame [DONE] lên màn hình chat của bạn",
    phase: "5. Egress (Cổng ra)",
    icon: "📡",
  },
  "runtime.daemon_stdout": {
    labelVi: "Tiến trình Daemon thực thi",
    descVi: "Nhật ký vận hành nội bộ của daemon điều phối luồng và quản lý tài nguyên",
    phase: "2. Daemon (Tiến trình nền)",
    icon: "⚙️",
  },
};

/**
 * Trả về bản dịch tiếng Việt cho một Event
 */
export function getEventTranslation(eventName: string): EventTranslation {
  if (EVENT_TRANSLATIONS[eventName]) {
    return EVENT_TRANSLATIONS[eventName];
  }

  // Fallback theo prefix
  if (eventName.startsWith("codex.request")) {
    return {
      labelVi: "Yêu cầu từ Codex",
      descVi: "Sự kiện cổng vào phía client Codex",
      phase: "1. Ingress (Cổng vào)",
      icon: "📥",
    };
  }
  if (eventName.startsWith("m365.tool")) {
    return {
      labelVi: "Xử lý Công cụ M365",
      descVi: "Sự kiện phát hiện hoặc xử lý tool call từ Copilot",
      phase: "4. Parser (Phân tích)",
      icon: "🛠️",
    };
  }
  if (eventName.startsWith("m365.provider")) {
    return {
      labelVi: "Giao tiếp M365 Copilot Web",
      descVi: "Sự kiện điều khiển trình duyệt Web M365 Copilot",
      phase: "3. M365 Browser (Trình duyệt)",
      icon: "🤖",
    };
  }
  if (eventName.startsWith("bridge")) {
    return {
      labelVi: "Cầu nối SSE Bridge",
      descVi: "Sự kiện truyền tải dữ liệu luồng về client",
      phase: "5. Egress (Cổng ra)",
      icon: "📡",
    };
  }

  return {
    labelVi: eventName,
    descVi: "Sự kiện hệ thống",
    phase: "2. Daemon (Tiến trình nền)",
    icon: "•",
  };
}

/**
 * Dịch thuật các dòng nhật ký daemon stdout phổ biến sang tiếng Việt
 */
export function translateDaemonLine(line: string): string | null {
  if (line.includes("[m365-turn] [start]")) {
    return "🚀 Bắt đầu lượt xử lý Turn mới";
  }
  if (line.includes("[m365-stream] [open]")) {
    return "🔌 Mở đường ống kết nối stream";
  }
  if (line.includes("[m365-turn] [busy]")) {
    return "⏳ Daemon chuyển trạng thái bận (đang phục vụ câu hỏi)";
  }
  if (line.includes("[m365-stream] [terminal]")) {
    return "🏁 Luồng dữ liệu hoàn tất thành công (terminal reached)";
  }
  if (line.includes("[m365-stream] [abort]")) {
    return "🔒 Đóng kết nối stream";
  }
  if (line.includes("[m365-turn] [completed]")) {
    return "🎉 Lượt xử lý hoàn tất trọn vẹn";
  }
  if (line.includes("[m365-turn] [idle]")) {
    return "💤 Daemon nghỉ ngơi, sẵn sàng nhận câu hỏi tiếp theo";
  }
  return null;
}
