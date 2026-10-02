import { Fragment, useMemo, useState } from "react";
import type { LogRecord, Language, TraceSpan, TraceGroup, ConversationGroup } from "./types";
import type { Copy } from "./i18n";
import { Icon } from "./icons";
import {
  formatLogsAsPrettyJson,
  formatLogsAsJsonl,
  formatLogsAsSummary,
  formatDisplayedLogsSummary,
  extractSpanMessage,
  formatFlowPayloadReport,
  downloadFile,
  generateExportFilename,
} from "./export-utils";
import { getEventTranslation, translateDaemonLine } from "./event-translations";
import "./trace-explorer.css";

export type { TraceSpan, TraceGroup, ConversationGroup };

/**
 * Trích xuất metadata thông minh từ log record
 * Nhận diện conversationId, traceId, turnId, modelSlug từ cả top-level detail và raw line
 */
function extractRecordMetadata(record: LogRecord) {
  const detail = record.detail || {};
  let conversationId = typeof detail.conversationId === "string" ? detail.conversationId : null;
  let traceId = typeof detail.traceId === "string" ? detail.traceId : null;
  const rootSpanId = typeof detail.rootSpanId === "string" ? detail.rootSpanId : undefined;
  const spanId = typeof detail.spanId === "string" ? detail.spanId : undefined;
  let requestId = typeof detail.requestId === "string" ? detail.requestId : undefined;
  let modelSlug = typeof detail.modelSlug === "string" ? detail.modelSlug : undefined;

  const rawLine = typeof detail.line === "string" ? detail.line : "";
  const rawMsg = typeof detail.message === "string" ? detail.message : "";
  const rawText = `${rawLine} ${rawMsg}`;

  if (!conversationId && rawText) {
    const matchConv = rawText.match(/\bconversationId=([a-zA-Z0-9_-]+)/);
    if (matchConv) conversationId = matchConv[1];
  }

  if (!traceId && rawText) {
    const matchTrace = rawText.match(/\btraceId=([a-zA-Z0-9_-]+)/);
    if (matchTrace) {
      traceId = matchTrace[1];
    } else {
      const matchTurn = rawText.match(/\bturnId=([a-zA-Z0-9_-]+)/);
      if (matchTurn) {
        traceId = matchTurn[1];
      } else {
        const matchReq = rawText.match(/\brequestId=([a-zA-Z0-9_-]+)/);
        if (matchReq) traceId = matchReq[1];
      }
    }
  }

  if (!modelSlug && rawText) {
    const matchModel = rawText.match(/\bmodel=([a-zA-Z0-9/_.-]+)/);
    if (matchModel) modelSlug = matchModel[1];
  }

  if (!requestId && rawText) {
    const matchReq = rawText.match(/\brequestId=([a-zA-Z0-9_-]+)/);
    if (matchReq) requestId = matchReq[1];
  }

  // Nếu có conversationId nhưng chưa có traceId cụ thể, gán traceId đại diện cho conversation
  if (conversationId && !traceId) {
    traceId = `conv_${conversationId}`;
  }

  return { conversationId, traceId, rootSpanId, spanId, requestId, modelSlug };
}

export function TraceExplorer({
  logs,
  copy,
  language,
  onClearLogs,
  onExportLogs,
}: {
  logs: LogRecord[];
  copy: Copy;
  language: Language;
  onClearLogs?: () => Promise<void>;
  onExportLogs?: () => Promise<void>;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterLevel, setFilterLevel] = useState<"all" | "error" | "warning" | "tools">("all");
  const [groupByMode, setGroupByMode] = useState<"conversation" | "trace">("conversation");
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [selectedTurnTraceId, setSelectedTurnTraceId] = useState<string | null>(null);
  const [expandedConvIds, setExpandedConvIds] = useState<Set<string>>(new Set());
  const [selectedRecord, setSelectedRecord] = useState<LogRecord | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [frozenLogs, setFrozenLogs] = useState<LogRecord[]>([]);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  // Sidebar Resize & Collapse
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [isResizing, setIsResizing] = useState(false);

  // Menu Copy & Download
  const [isCopyMenuOpen, setIsCopyMenuOpen] = useState(false);
  const [isDownloadMenuOpen, setIsDownloadMenuOpen] = useState(false);
  const [feedbackToast, setFeedbackToast] = useState<string | null>(null);

  // Cờ bật tắt hiển thị sự kiện tiếng Việt trực quan
  const [isVietnameseEvents, setIsVietnameseEvents] = useState(true);

  const showToast = (msg: string) => {
    setFeedbackToast(msg);
    setTimeout(() => setFeedbackToast(null), 2500);
  };

  const handleMouseDownResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const newWidth = Math.max(200, Math.min(600, startWidth + delta));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      setIsResizing(false);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  // Kibana Table Column Customization & Time Sort
  const [timeSortOrder, setTimeSortOrder] = useState<"asc" | "desc">("asc");
  const [visibleColumns, setVisibleColumns] = useState<{
    time: boolean;
    level: boolean;
    event: boolean;
    message: boolean;
    duration: boolean;
    spanId: boolean;
    requestId: boolean;
  }>({
    time: true,
    level: true,
    event: true,
    message: true,
    duration: false,
    spanId: false,
    requestId: false,
  });
  const [isColumnPickerOpen, setIsColumnPickerOpen] = useState(false);
  const [expandedSpanIds, setExpandedSpanIds] = useState<Set<string>>(new Set());
  const [expandedDocTabs, setExpandedDocTabs] = useState<Record<string, "table" | "json">>({});

  // Xử lý tạm dừng Live stream
  const activeLogs = isPaused ? frozenLogs : logs;

  const handleTogglePause = () => {
    if (!isPaused) {
      setFrozenLogs(logs);
      setIsPaused(true);
    } else {
      setIsPaused(false);
    }
  };

  // Gom nhóm logs thành Traces
  const traces = useMemo(() => {
    const traceMap = new Map<string, TraceGroup>();
    const systemRecords: LogRecord[] = [];

    for (const record of activeLogs) {
      const meta = extractRecordMetadata(record);
      const traceId = meta.traceId;

      if (!traceId) {
        systemRecords.push(record);
        continue;
      }

      let group = traceMap.get(traceId);
      const recordTime = new Date(record.at).getTime() || Date.now();

      if (!group) {
        group = {
          traceId,
          rootSpanId: meta.rootSpanId,
          conversationId: meta.conversationId || undefined,
          startTime: recordTime,
          endTime: recordTime,
          durationMs: 0,
          status: "running",
          modelSlug: meta.modelSlug,
          toolNames: [],
          records: [],
          spans: [],
        };
        traceMap.set(traceId, group);
      }

      group.records.push(record);
      if (recordTime < group.startTime) group.startTime = recordTime;
      if (recordTime > group.endTime) group.endTime = recordTime;
      group.durationMs = Math.max(group.durationMs, group.endTime - group.startTime);

      // Cập nhật conversationId hoặc modelSlug nếu mới xuất hiện
      if (!group.conversationId && meta.conversationId) {
        group.conversationId = meta.conversationId;
      }
      if (!group.modelSlug && meta.modelSlug) {
        group.modelSlug = meta.modelSlug;
      }

      // Trích xuất metadata bổ sung từ safeDetails
      const detail = record.detail || {};
      const safeDetails = (detail.safeDetails as Record<string, unknown>) || {};
      if (safeDetails.modelSlug && typeof safeDetails.modelSlug === "string") {
        group.modelSlug = safeDetails.modelSlug;
      }
      if (record.event === "m365.tool.detected" && safeDetails.toolName && typeof safeDetails.toolName === "string") {
        if (!group.toolNames.includes(safeDetails.toolName)) {
          group.toolNames.push(safeDetails.toolName);
        }
      }

      // Đánh giá trạng thái
      if (record.level === "error" || detail.status === "failed") {
        group.status = "failed";
      } else if ((record.level === "warning" || detail.status === "aborted") && group.status !== "failed") {
        group.status = "warning";
      } else if (record.event.endsWith(".completed") && group.status !== "failed" && group.status !== "warning") {
        group.status = "completed";
      }

      // Xây dựng span con
      let category: TraceSpan["category"] = "generic";
      if (record.event.startsWith("codex.request")) category = "request";
      else if (record.event.startsWith("m365.provider")) category = "provider";
      else if (record.event.startsWith("m365.tool")) category = "tool";
      else if (record.event.startsWith("m365.loop")) category = "loop";
      else if (record.event.startsWith("bridge")) category = "bridge";
      else if (record.event.endsWith(".completed")) category = "turn";

      const spanDuration = typeof detail.durationMs === "number" ? detail.durationMs : 0;
      const spanStatus = record.level === "error" ? "failed" : record.level === "warning" ? "warning" : "completed";

      group.spans.push({
        spanId: (detail.spanId as string) || `span_${group.spans.length}`,
        parentSpanId: detail.parentSpanId as string | undefined,
        name: record.event,
        event: record.event,
        category,
        startTime: recordTime,
        durationMs: spanDuration,
        status: spanStatus,
        record,
      });
    }

    // Nếu có system records, gom thành một nhóm riêng
    if (systemRecords.length > 0) {
      const firstTime = new Date(systemRecords[0].at).getTime() || Date.now();
      const lastTime = new Date(systemRecords[systemRecords.length - 1].at).getTime() || Date.now();
      traceMap.set("_system", {
        traceId: "_system",
        startTime: firstTime,
        endTime: lastTime,
        durationMs: Math.max(0, lastTime - firstTime),
        status: systemRecords.some((r) => r.level === "error") ? "failed" : "completed",
        modelSlug: "Runtime & Daemon Logs",
        toolNames: [],
        records: systemRecords,
        spans: systemRecords.map((r, i) => ({
          spanId: `sys_${i}`,
          name: r.event,
          event: r.event,
          category: "generic",
          startTime: new Date(r.at).getTime() || Date.now(),
          durationMs: 0,
          status: r.level === "error" ? "failed" : r.level === "warning" ? "warning" : "completed",
          record: r,
        })),
      });
    }

    return Array.from(traceMap.values()).reverse();
  }, [activeLogs]);

  // Gom nhóm Traces thành Conversations
  const conversations = useMemo(() => {
    const convMap = new Map<string, ConversationGroup>();
    let unnamedCount = 1;

    for (const trace of traces) {
      const isSystem = trace.traceId === "_system";
      const convId = isSystem ? "_system" : trace.conversationId || `conv_${trace.traceId}`;

      let group = convMap.get(convId);
      if (!group) {
        let title = isSystem ? "System & Daemon Logs" : `Conversation #${unnamedCount++}`;
        if (!isSystem && trace.conversationId) {
          title = `Chat: ${trace.conversationId.slice(0, 8)}...`;
        }

        group = {
          conversationId: convId,
          title,
          isSystem,
          startTime: trace.startTime,
          endTime: trace.endTime,
          durationMs: trace.durationMs,
          status: trace.status,
          modelSlug: trace.modelSlug,
          traces: [],
          records: [],
          spans: [],
        };
        convMap.set(convId, group);
      }

      group.traces.push(trace);
      group.records.push(...trace.records);
      group.spans.push(...trace.spans);
      if (trace.startTime < group.startTime) group.startTime = trace.startTime;
      if (trace.endTime > group.endTime) group.endTime = trace.endTime;
      group.durationMs = Math.max(group.durationMs, group.endTime - group.startTime);

      if (trace.status === "failed") group.status = "failed";
      else if (trace.status === "warning" && group.status !== "failed") group.status = "warning";
      if (!group.modelSlug && trace.modelSlug) group.modelSlug = trace.modelSlug;
    }

    // Đánh số thứ tự Turn (Turn 1, Turn 2...) theo thời gian tăng dần và gán vào spans
    for (const group of convMap.values()) {
      group.traces.sort((a, b) => a.startTime - b.startTime);
      for (let i = 0; i < group.traces.length; i++) {
        const tr = group.traces[i];
        for (const span of tr.spans) {
          span.turnIndex = i + 1;
          span.traceId = tr.traceId;
        }
      }
    }

    // Sắp xếp conversations theo thời gian kết thúc gần nhất (mới nhất lên đầu)
    return Array.from(convMap.values()).sort((a, b) => {
      if (a.isSystem) return 1;
      if (b.isSystem) return -1;
      return b.endTime - a.endTime;
    });
  }, [traces]);

  // Lọc Conversations & Traces theo search query và filter pills
  const filteredConversations = useMemo(() => {
    return conversations
      .map((conv) => {
        const matchingTraces = conv.traces.filter((trace) => {
          if (filterLevel === "error" && trace.status !== "failed") return false;
          if (filterLevel === "warning" && trace.status !== "warning") return false;
          if (filterLevel === "tools" && trace.toolNames.length === 0) return false;

          if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase().trim();
            const matchesTraceId = trace.traceId.toLowerCase().includes(query);
            const matchesConvId = trace.conversationId?.toLowerCase().includes(query);
            const matchesModel = trace.modelSlug?.toLowerCase().includes(query);
            const matchesTool = trace.toolNames.some((t) => t.toLowerCase().includes(query));
            const matchesEvent = trace.records.some((r) => r.event.toLowerCase().includes(query));
            const matchesMessage = trace.records.some((r) => {
              const detail = r.detail || {};
              const msg = typeof detail.message === "string" ? detail.message : "";
              const line = typeof detail.line === "string" ? detail.line : "";
              return msg.toLowerCase().includes(query) || line.toLowerCase().includes(query);
            });
            return (
              matchesTraceId ||
              matchesConvId ||
              matchesModel ||
              matchesTool ||
              matchesEvent ||
              matchesMessage
            );
          }

          return true;
        });

        if (matchingTraces.length === 0) return null;

        return {
          ...conv,
          traces: matchingTraces,
          records: matchingTraces.flatMap((t) => t.records),
          spans: matchingTraces.flatMap((t) => t.spans),
        };
      })
      .filter((c): c is ConversationGroup => c !== null);
  }, [conversations, filterLevel, searchQuery]);

  // Lọc danh sách phẳng các Traces khi chọn chế độ groupByMode === "trace"
  const filteredTraces = useMemo(() => {
    return traces.filter((trace) => {
      if (filterLevel === "error" && trace.status !== "failed") return false;
      if (filterLevel === "warning" && trace.status !== "warning") return false;
      if (filterLevel === "tools" && trace.toolNames.length === 0) return false;

      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase().trim();
        const matchesTraceId = trace.traceId.toLowerCase().includes(query);
        const matchesConvId = trace.conversationId?.toLowerCase().includes(query);
        const matchesModel = trace.modelSlug?.toLowerCase().includes(query);
        const matchesTool = trace.toolNames.some((t) => t.toLowerCase().includes(query));
        const matchesEvent = trace.records.some((r) => r.event.toLowerCase().includes(query));
        const matchesMessage = trace.records.some((r) => {
          const detail = r.detail || {};
          const msg = typeof detail.message === "string" ? detail.message : "";
          const line = typeof detail.line === "string" ? detail.line : "";
          return msg.toLowerCase().includes(query) || line.toLowerCase().includes(query);
        });
        return (
          matchesTraceId ||
          matchesConvId ||
          matchesModel ||
          matchesTool ||
          matchesEvent ||
          matchesMessage
        );
      }

      return true;
    });
  }, [traces, filterLevel, searchQuery]);

  // Xác định Conversation và Turn đang active theo chế độ groupByMode
  const activeSelection = useMemo(() => {
    if (groupByMode === "conversation") {
      if (filteredConversations.length === 0) return null;

      let targetConv = filteredConversations.find(
        (c) => c.conversationId === selectedConversationId
      );
      if (!targetConv) {
        targetConv = filteredConversations[0];
      }

      let targetTrace: TraceGroup | null = null;
      if (selectedTurnTraceId) {
        targetTrace = targetConv.traces.find((t) => t.traceId === selectedTurnTraceId) || null;
      }

      return {
        conversation: targetConv,
        trace: targetTrace,
        isAllTurns: targetTrace === null,
        spans: targetTrace ? targetTrace.spans : targetConv.spans,
        records: targetTrace ? targetTrace.records : targetConv.records,
      };
    } else {
      // groupByMode === "trace"
      if (filteredTraces.length === 0) return null;

      let targetTrace = filteredTraces.find((t) => t.traceId === selectedTurnTraceId);
      if (!targetTrace) {
        targetTrace = filteredTraces[0];
      }

      const targetConv =
        conversations.find((c) => c.conversationId === targetTrace.conversationId) || {
          conversationId: targetTrace.conversationId || targetTrace.traceId,
          title: `Trace: ${targetTrace.traceId.slice(0, 8)}...`,
          isSystem: targetTrace.traceId === "_system",
          startTime: targetTrace.startTime,
          endTime: targetTrace.endTime,
          durationMs: targetTrace.durationMs,
          status: targetTrace.status,
          modelSlug: targetTrace.modelSlug,
          traces: [targetTrace],
          records: targetTrace.records,
          spans: targetTrace.spans,
        };

      return {
        conversation: targetConv,
        trace: targetTrace,
        isAllTurns: false,
        spans: targetTrace.spans,
        records: targetTrace.records,
      };
    }
  }, [
    groupByMode,
    filteredConversations,
    filteredTraces,
    conversations,
    selectedConversationId,
    selectedTurnTraceId,
  ]);

  const toggleConvExpanded = (convId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedConvIds(prev => {
      const next = new Set(prev);
      if (next.has(convId)) next.delete(convId);
      else next.add(convId);
      return next;
    });
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopyFeedback(label);
      setTimeout(() => setCopyFeedback(null), 2000);
    });
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const formatSpanTime = (ts: number) => {
    const d = new Date(ts);
    return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
  };

  const formatKibanaTime = (ts: number) => {
    const d = new Date(ts);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  };

  const toggleRowExpanded = (spanId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedSpanIds((prev) => {
      const next = new Set(prev);
      if (next.has(spanId)) {
        next.delete(spanId);
      } else {
        next.add(spanId);
      }
      return next;
    });
  };

  const toggleColumn = (key: keyof typeof visibleColumns) => {
    setVisibleColumns((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const sortedSpans = useMemo(() => {
    if (!activeSelection) return [];
    const list = [...activeSelection.spans];
    list.sort((a, b) => {
      const diff = a.startTime - b.startTime;
      return timeSortOrder === "asc" ? diff : -diff;
    });
    return list;
  }, [activeSelection, timeSortOrder]);

  const activeColumnCount = Object.values(visibleColumns).filter(Boolean).length;

  return (
    <div className="trace-explorer-container">
      {/* Thanh công cụ đỉnh */}
      <div className="te-toolbar">
        <div className="te-toolbar-left">
          {/* Nút Thu hẹp / Mở rộng Sidebar */}
          <button
            className={`te-btn te-btn-sidebar-toggle ${isSidebarCollapsed ? "active" : ""}`}
            onClick={() => setIsSidebarCollapsed((prev) => !prev)}
            title={isSidebarCollapsed ? "Mở rộng Sidebar (Click để mở lại)" : "Thu hẹp Sidebar (Click để ẩn)"}
            aria-label={isSidebarCollapsed ? "Mở rộng Sidebar" : "Thu hẹp Sidebar"}
            aria-pressed={isSidebarCollapsed}
          >
            <Icon name="sidebar" width={16} height={16} />
          </button>

          <div className="te-search-wrapper">
            <input
              type="text"
              className="te-search-input"
              placeholder="Search Trace, Event, Tool..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery ? (
              <button className="te-search-clear" onClick={() => setSearchQuery("")}>
                <Icon name="close" width={14} height={14} />
              </button>
            ) : null}
          </div>

          <div className="te-filter-pills">
            <button
              className={`te-pill ${filterLevel === "all" ? "active" : ""}`}
              onClick={() => setFilterLevel("all")}
            >
              All ({groupByMode === "conversation" ? filteredConversations.length : filteredTraces.length})
            </button>
            <button
              className={`te-pill te-pill-error ${filterLevel === "error" ? "active" : ""}`}
              onClick={() => setFilterLevel("error")}
            >
              Errors
            </button>
            <button
              className={`te-pill te-pill-warn ${filterLevel === "warning" ? "active" : ""}`}
              onClick={() => setFilterLevel("warning")}
            >
              Warnings
            </button>
            <button
              className={`te-pill ${filterLevel === "tools" ? "active" : ""}`}
              onClick={() => setFilterLevel("tools")}
            >
              Tools
            </button>
          </div>

          {/* Toggle Chế độ Nhóm: By Conversation vs Flat Traces */}
          <div className="te-group-toggle" title="Chế độ phân nhóm danh sách">
            <button
              className={`te-pill ${groupByMode === "conversation" ? "active" : ""}`}
              onClick={() => setGroupByMode("conversation")}
              title="Nhóm theo Cuộc hội thoại (cây 2 tầng: Conversation > Turns)"
            >
              💬 By Conversation
            </button>
            <button
              className={`te-pill ${groupByMode === "trace" ? "active" : ""}`}
              onClick={() => setGroupByMode("trace")}
              title="Xem danh sách phẳng tất cả các Traces đơn lẻ"
            >
              ⚡ Flat Traces
            </button>
          </div>
        </div>

        <div className="te-toolbar-right">
          <button
            className={`te-btn te-btn-live ${isPaused ? "paused" : ""}`}
            onClick={handleTogglePause}
            title={isPaused ? "Resume Live Stream" : "Pause Live Stream"}
          >
            <Icon name={isPaused ? "activity" : "pause"} width={14} height={14} />
            <span>{isPaused ? "Paused" : "Live"}</span>
          </button>

          {onClearLogs ? (
            <button
              className="te-btn te-btn-danger"
              onClick={() => {
                if (window.confirm("Bạn có chắc chắn muốn xóa toàn bộ nhật ký hiện tại?")) {
                  void onClearLogs();
                }
              }}
              title="Clear all logs"
            >
              <Icon name="trash" width={14} height={14} />
              <span>Clear</span>
            </button>
          ) : null}

          {onExportLogs ? (
            <button className="te-btn" onClick={() => void onExportLogs()} title={copy.exportSafeLog}>
              <Icon name="external" width={14} height={14} />
              <span>{copy.exportSafeLog}</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* Split View */}
      <div className="te-split-view">
        {/* Cột trái: Cây thư mục Conversations & Turns hoặc Flat Traces (có thể thu hẹp) */}
        {!isSidebarCollapsed && (
          <>
            <div className="te-trace-list-panel" style={{ width: sidebarWidth }}>
              {groupByMode === "conversation" ? (
                /* CHẾ ĐỘ 1: NHÓM THEO CONVERSATION */
                filteredConversations.length === 0 ? (
                  <div className="te-empty-state">
                    <Icon name="logs" width={28} height={28} />
                    <span>{copy.noLogs || "Không có cuộc hội thoại nào phù hợp"}</span>
                  </div>
                ) : (
                  filteredConversations.map((conv) => {
                    const isConvSelected =
                      activeSelection?.conversation.conversationId === conv.conversationId &&
                      activeSelection.isAllTurns;
                    const isExpanded = !expandedConvIds.has(conv.conversationId);

                    return (
                      <div key={conv.conversationId} className="te-conv-group">
                        {/* Header Conversation */}
                        <div
                          className={`te-conv-header ${isConvSelected ? "selected" : ""}`}
                          onClick={() => {
                            setSelectedConversationId(conv.conversationId);
                            setSelectedTurnTraceId(null);
                          }}
                          title={`Conversation ID: ${conv.conversationId}`}
                        >
                          <div className="te-conv-header-left">
                            <span
                              className="te-conv-expand-icon"
                              onClick={(e) => toggleConvExpanded(conv.conversationId, e)}
                              title={isExpanded ? "Gập lại" : "Mở rộng"}
                            >
                              {conv.traces.length > 1 ? (isExpanded ? "▼" : "▶") : "•"}
                            </span>
                            <span className="te-conv-icon">{conv.isSystem ? "⚙️" : "💬"}</span>
                            <div className="te-conv-title-col">
                              <span className="te-conv-title">{conv.title}</span>
                              <span className="te-conv-subtitle">
                                {conv.isSystem ? `${conv.records.length} logs` : `${conv.traces.length} turn(s)`}
                              </span>
                            </div>
                          </div>

                          <div className="te-conv-header-right">
                            <span
                              style={{
                                width: 8,
                                height: 8,
                                borderRadius: "50%",
                                backgroundColor:
                                  conv.status === "failed"
                                    ? "var(--red-300)"
                                    : conv.status === "warning"
                                    ? "var(--orange-300)"
                                    : "var(--green-300)",
                              }}
                            />
                            <span className="te-trace-time">
                              {new Date(conv.endTime).toLocaleTimeString(undefined, {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          </div>
                        </div>

                        {/* Danh sách các Turn con */}
                        {isExpanded && !conv.isSystem && (
                          <div className="te-turn-list">
                            {/* Mục "All Turns" */}
                            <div
                              className={`te-turn-item ${isConvSelected ? "selected" : ""}`}
                              onClick={() => {
                                setSelectedConversationId(conv.conversationId);
                                setSelectedTurnTraceId(null);
                              }}
                            >
                              <div className="te-turn-item-left">
                                <span className="te-turn-label">All Turns ({conv.traces.length})</span>
                              </div>
                              <div className="te-turn-item-right">
                                <span className="te-badge te-badge-duration">{formatDuration(conv.durationMs)}</span>
                              </div>
                            </div>

                            {/* Từng Turn riêng lẻ */}
                            {conv.traces.map((trace, tIdx) => {
                              const isTurnSelected =
                                activeSelection?.conversation.conversationId === conv.conversationId &&
                                activeSelection.trace?.traceId === trace.traceId;

                              return (
                                <div
                                  key={trace.traceId}
                                  className={`te-turn-item ${isTurnSelected ? "selected" : ""}`}
                                  onClick={() => {
                                    setSelectedConversationId(conv.conversationId);
                                    setSelectedTurnTraceId(trace.traceId);
                                  }}
                                  title={`Turn #${tIdx + 1} • Trace ID: ${trace.traceId}`}
                                >
                                  <div className="te-turn-item-left">
                                    <span
                                      style={{
                                        width: 6,
                                        height: 6,
                                        borderRadius: "50%",
                                        backgroundColor:
                                          trace.status === "failed"
                                            ? "var(--red-300)"
                                            : trace.status === "warning"
                                            ? "var(--orange-300)"
                                            : "var(--green-300)",
                                      }}
                                    />
                                    <span className="te-turn-label">Turn {tIdx + 1}</span>
                                    <span className="te-turn-model">{trace.modelSlug || "inference"}</span>
                                  </div>
                                  <div className="te-turn-item-right">
                                    {trace.durationMs > 0 ? (
                                      <span className="te-badge te-badge-duration">{formatDuration(trace.durationMs)}</span>
                                    ) : null}
                                    <span className="te-turn-time">
                                      {new Date(trace.startTime).toLocaleTimeString(undefined, {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                        second: "2-digit",
                                      })}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })
                )
              ) : (
                /* CHẾ ĐỘ 2: DANH SÁCH PHẲNG TẤT CẢ TRACES */
                filteredTraces.length === 0 ? (
                  <div className="te-empty-state">
                    <Icon name="logs" width={28} height={28} />
                    <span>{copy.noLogs || "Không có trace nào phù hợp"}</span>
                  </div>
                ) : (
                  filteredTraces.map((trace) => {
                    const isSelected = activeSelection?.trace?.traceId === trace.traceId;
                    return (
                      <div
                        key={trace.traceId}
                        className={`te-trace-card ${isSelected ? "selected" : ""}`}
                        onClick={() => {
                          setSelectedTurnTraceId(trace.traceId);
                          if (trace.conversationId) setSelectedConversationId(trace.conversationId);
                        }}
                        title={`Trace ID: ${trace.traceId}`}
                      >
                        <div className="te-trace-card-header">
                          <div className="te-trace-status-group">
                            <span
                              style={{
                                width: 8,
                                height: 8,
                                borderRadius: "50%",
                                backgroundColor:
                                  trace.status === "failed"
                                    ? "var(--red-300)"
                                    : trace.status === "warning"
                                    ? "var(--orange-300)"
                                    : "var(--green-300)",
                              }}
                            />
                            <span className="te-trace-id">
                              {trace.traceId === "_system" ? "SYSTEM" : trace.traceId.slice(0, 16)}
                            </span>
                          </div>
                          <span className="te-trace-time">
                            {new Date(trace.endTime).toLocaleTimeString(undefined, {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })}
                          </span>
                        </div>
                        <div className="te-trace-card-body">
                          <span className="te-trace-model">
                            {trace.modelSlug || (trace.traceId === "_system" ? "Runtime & Daemon" : "inference")}
                          </span>
                          <div className="te-trace-meta-tags">
                            {trace.toolNames.length > 0 ? (
                              <span className="te-badge te-badge-tool">{trace.toolNames.length} tools</span>
                            ) : null}
                            <span className="te-badge te-badge-duration">{formatDuration(trace.durationMs)}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )
              )}
            </div>

            {/* Thanh kéo thay đổi độ rộng Sidebar */}
            <div
              className={`te-resizer ${isResizing ? "is-resizing" : ""}`}
              onMouseDown={handleMouseDownResize}
              title="Kéo sang trái/phải để chỉnh độ rộng cột"
            />
          </>
        )}

        {/* Cột giữa: Chi tiết Trace / Conversation */}
        <div className="te-trace-detail-panel">
          {activeSelection ? (
            <>
              <div className="te-detail-header">
                <div className="te-detail-title-group">
                  <div className="te-detail-title">
                    <span>
                      {activeSelection.isAllTurns
                        ? activeSelection.conversation.title
                        : `Turn: ${activeSelection.trace?.modelSlug || "Model inference"}`}
                    </span>
                    <span
                      className="te-badge"
                      style={{
                        backgroundColor:
                          (activeSelection.trace?.status || activeSelection.conversation.status) === "failed"
                            ? "var(--color-background-status-error)"
                            : "var(--color-background-status-success)",
                        color:
                          (activeSelection.trace?.status || activeSelection.conversation.status) === "failed"
                            ? "var(--color-text-error)"
                            : "var(--color-text-success)",
                      }}
                    >
                      {(activeSelection.trace?.status || activeSelection.conversation.status).toUpperCase()}
                    </span>
                  </div>
                  <div className="te-detail-subtitle">
                    {activeSelection.isAllTurns ? (
                      <>
                        <span>
                          Conversation:{" "}
                          <code style={{ fontFamily: "var(--font-mono)" }}>
                            {activeSelection.conversation.conversationId}
                          </code>
                        </span>
                        <button
                          className="te-copy-btn"
                          onClick={() =>
                            copyToClipboard(
                              activeSelection.conversation.conversationId,
                              "Conversation ID copied!"
                            )
                          }
                          title="Copy Conversation ID"
                        >
                          {copyFeedback === "Conversation ID copied!" ? "✓ Copied" : "Copy"}
                        </button>
                        <span>
                          {activeSelection.conversation.traces.length} Turn(s) • Total Time:{" "}
                          {formatDuration(activeSelection.conversation.durationMs)}
                        </span>
                      </>
                    ) : (
                      <>
                        <span>
                          Trace ID:{" "}
                          <code style={{ fontFamily: "var(--font-mono)" }}>
                            {activeSelection.trace?.traceId}
                          </code>
                        </span>
                        <button
                          className="te-copy-btn"
                          onClick={() =>
                            copyToClipboard(
                              activeSelection.trace?.traceId || "",
                              "Trace ID copied!"
                            )
                          }
                          title="Copy Trace ID"
                        >
                          {copyFeedback === "Trace ID copied!" ? "✓ Copied" : "Copy"}
                        </button>
                        {activeSelection.trace && activeSelection.trace.durationMs > 0 ? (
                          <span>Total Time: {formatDuration(activeSelection.trace.durationMs)}</span>
                        ) : null}
                        <span>
                          Session:{" "}
                          <code style={{ fontFamily: "var(--font-mono)" }}>
                            {activeSelection.conversation.conversationId.slice(0, 8)}...
                          </code>
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Kibana Action Bar: Time Sort, Column Picker, Copy Logs & Download Logs */}
              {(() => {
                const targetRecords = activeSelection.isAllTurns
                  ? activeSelection.conversation.records
                  : activeSelection.trace
                  ? activeSelection.trace.records
                  : activeSelection.conversation.records;
                const targetPrefix = activeSelection.isAllTurns ? "conversation" : "turn";
                const targetId = activeSelection.isAllTurns
                  ? activeSelection.conversation.conversationId
                  : activeSelection.trace?.traceId || activeSelection.conversation.conversationId;
                const targetTitle = activeSelection.isAllTurns
                  ? activeSelection.conversation.title
                  : activeSelection.trace?.modelSlug || activeSelection.conversation.title;
                const targetDuration = activeSelection.isAllTurns
                  ? activeSelection.conversation.durationMs
                  : activeSelection.trace?.durationMs || activeSelection.conversation.durationMs;

                return (
                  <div className="te-action-bar">
                    <div className="te-action-bar-left">
                      <button
                        className="te-btn"
                        style={{ height: 28, fontSize: 11, padding: "0 10px" }}
                        onClick={() => setTimeSortOrder((prev) => (prev === "asc" ? "desc" : "asc"))}
                        title={
                          timeSortOrder === "asc"
                            ? "Đang xếp Cũ nhất trước. Click để đổi sang Mới nhất trước"
                            : "Đang xếp Mới nhất trước. Click để đổi sang Cũ nhất trước"
                        }
                      >
                        <span>Time: {timeSortOrder === "asc" ? "Oldest First ↑" : "Newest First ↓"}</span>
                      </button>

                      <div className="te-col-picker-wrapper">
                        <button
                          className="te-btn"
                          style={{ height: 28, fontSize: 11, padding: "0 10px" }}
                          onClick={() => {
                            setIsColumnPickerOpen((prev) => !prev);
                            setIsCopyMenuOpen(false);
                            setIsDownloadMenuOpen(false);
                          }}
                          title="Chọn các cột hiển thị"
                        >
                          <span>Columns ({activeColumnCount}/7) ▾</span>
                        </button>

                        {isColumnPickerOpen ? (
                          <>
                            <div
                              className="te-popover-backdrop"
                              onClick={() => setIsColumnPickerOpen(false)}
                            />
                            <div className="te-col-picker-popover">
                              <label className="te-col-item">
                                <input
                                  type="checkbox"
                                  className="te-col-checkbox"
                                  checked={visibleColumns.time}
                                  onChange={() => toggleColumn("time")}
                                />
                                <span>Time (@timestamp)</span>
                              </label>
                              <label className="te-col-item">
                                <input
                                  type="checkbox"
                                  className="te-col-checkbox"
                                  checked={visibleColumns.level}
                                  onChange={() => toggleColumn("level")}
                                />
                                <span>Level (log.level)</span>
                              </label>
                              <label className="te-col-item">
                                <input
                                  type="checkbox"
                                  className="te-col-checkbox"
                                  checked={visibleColumns.event}
                                  onChange={() => toggleColumn("event")}
                                />
                                <span>Event (event.action)</span>
                              </label>
                              <label className="te-col-item">
                                <input
                                  type="checkbox"
                                  className="te-col-checkbox"
                                  checked={visibleColumns.message}
                                  onChange={() => toggleColumn("message")}
                                />
                                <span>Message (detail)</span>
                              </label>
                              <label className="te-col-item">
                                <input
                                  type="checkbox"
                                  className="te-col-checkbox"
                                  checked={visibleColumns.duration}
                                  onChange={() => toggleColumn("duration")}
                                />
                                <span>Duration (ms)</span>
                              </label>
                              <label className="te-col-item">
                                <input
                                  type="checkbox"
                                  className="te-col-checkbox"
                                  checked={visibleColumns.spanId}
                                  onChange={() => toggleColumn("spanId")}
                                />
                                <span>Span ID</span>
                              </label>
                              <label className="te-col-item">
                                <input
                                  type="checkbox"
                                  className="te-col-checkbox"
                                  checked={visibleColumns.requestId}
                                  onChange={() => toggleColumn("requestId")}
                                />
                                <span>Request ID</span>
                              </label>
                            </div>
                          </>
                        ) : null}
                      </div>

                      {/* Nút xuất Báo cáo Flow & Payload Markdown độc lập */}
                      <button
                        className="te-btn"
                        style={{
                          height: 28,
                          fontSize: 11,
                          padding: "0 8px",
                          gap: 4,
                          background: "var(--color-bg-secondary, rgba(255,255,255,0.06))",
                          borderColor: "var(--color-accent, #3b82f6)",
                          color: "var(--color-accent, #60a5fa)",
                          fontWeight: 500,
                        }}
                        onClick={() => {
                          const report = formatFlowPayloadReport(activeSelection.conversation, activeSelection.trace);
                          const filename = generateExportFilename(
                            activeSelection.isAllTurns ? "flow_report_conv" : "flow_report_turn",
                            targetId,
                            "md"
                          );
                          downloadFile(report, filename, "text/markdown");
                          showToast(`✓ Đã tải báo cáo Flow: ${filename}`);
                        }}
                        title="Tải báo cáo chi tiết Flow và nội dung Message Payload thực tế (Markdown)"
                      >
                        <span>📑 Flow (.md)</span>
                      </button>

                      {/* Dropdown Menu: Copy Log ▾ */}
                      <div className="te-menu-wrapper">
                        <button
                          className="te-btn"
                          style={{ height: 28, fontSize: 11, padding: "0 8px" }}
                          onClick={() => {
                            setIsCopyMenuOpen((prev) => !prev);
                            setIsDownloadMenuOpen(false);
                            setIsColumnPickerOpen(false);
                          }}
                          title={`Sao chép ${sortedSpans.length} dòng hiển thị vào Clipboard`}
                        >
                          <span>📋 Copy ({sortedSpans.length}) ▾</span>
                        </button>

                        {isCopyMenuOpen ? (
                          <>
                            <div
                              className="te-popover-backdrop"
                              onClick={() => setIsCopyMenuOpen(false)}
                            />
                            <div className="te-menu-popover">
                              <button
                                className="te-menu-item"
                                onClick={() => {
                                  const text = formatFlowPayloadReport(activeSelection.conversation, activeSelection.trace);
                                  navigator.clipboard.writeText(text);
                                  showToast(`✓ Đã sao chép Báo cáo Flow & Payload (.md)`);
                                  setIsCopyMenuOpen(false);
                                }}
                              >
                                <span>Flow & Payload Report</span>
                                <span className="te-menu-item-subtitle">.md</span>
                              </button>
                              <button
                                className="te-menu-item"
                                onClick={() => {
                                  const text = formatDisplayedLogsSummary({
                                    spans: sortedSpans,
                                    title: targetTitle,
                                    durationMs: targetDuration,
                                    visibleColumns,
                                    isVietnameseEvents,
                                    timeSortOrder,
                                    showTurnBadge: Boolean(
                                      activeSelection.isAllTurns && activeSelection.conversation.traces.length > 1
                                    ),
                                    format: "text",
                                  });
                                  navigator.clipboard.writeText(text);
                                  showToast(`✓ Đã sao chép ${sortedSpans.length} dòng tóm tắt theo hiển thị`);
                                  setIsCopyMenuOpen(false);
                                }}
                              >
                                <span>Text Summary (Theo hiển thị)</span>
                                <span className="te-menu-item-subtitle">.txt</span>
                              </button>
                              <button
                                className="te-menu-item"
                                onClick={() => {
                                  const text = formatDisplayedLogsSummary({
                                    spans: sortedSpans,
                                    title: targetTitle,
                                    durationMs: targetDuration,
                                    visibleColumns,
                                    isVietnameseEvents,
                                    timeSortOrder,
                                    showTurnBadge: Boolean(
                                      activeSelection.isAllTurns && activeSelection.conversation.traces.length > 1
                                    ),
                                    format: "tsv",
                                  });
                                  navigator.clipboard.writeText(text);
                                  showToast(`✓ Đã sao chép ${sortedSpans.length} dòng dạng bảng TSV (sẵn sàng dán Excel)`);
                                  setIsCopyMenuOpen(false);
                                }}
                              >
                                <span>Bảng TSV (Dán Excel / Sheets)</span>
                                <span className="te-menu-item-subtitle">.tsv</span>
                              </button>
                              <button
                                className="te-menu-item"
                                onClick={() => {
                                  const text = formatDisplayedLogsSummary({
                                    spans: sortedSpans,
                                    title: targetTitle,
                                    durationMs: targetDuration,
                                    visibleColumns,
                                    isVietnameseEvents,
                                    timeSortOrder,
                                    showTurnBadge: Boolean(
                                      activeSelection.isAllTurns && activeSelection.conversation.traces.length > 1
                                    ),
                                    format: "markdown",
                                  });
                                  navigator.clipboard.writeText(text);
                                  showToast(`✓ Đã sao chép ${sortedSpans.length} dòng dạng Markdown Table`);
                                  setIsCopyMenuOpen(false);
                                }}
                              >
                                <span>Bảng Markdown Table</span>
                                <span className="te-menu-item-subtitle">.md</span>
                              </button>
                              <button
                                className="te-menu-item"
                                onClick={() => {
                                  const text = formatLogsAsPrettyJson(targetRecords);
                                  navigator.clipboard.writeText(text);
                                  showToast(`✓ Đã sao chép ${targetRecords.length} log (Pretty JSON)`);
                                  setIsCopyMenuOpen(false);
                                }}
                              >
                                <span>Pretty JSON (Raw)</span>
                                <span className="te-menu-item-subtitle">.json</span>
                              </button>
                              <button
                                className="te-menu-item"
                                onClick={() => {
                                  const text = formatLogsAsJsonl(targetRecords);
                                  navigator.clipboard.writeText(text);
                                  showToast(`✓ Đã sao chép ${targetRecords.length} log (JSONL)`);
                                  setIsCopyMenuOpen(false);
                                }}
                              >
                                <span>JSON Lines (Raw)</span>
                                <span className="te-menu-item-subtitle">.jsonl</span>
                              </button>
                            </div>
                          </>
                        ) : null}
                      </div>

                      {/* Dropdown Menu: Download Log ▾ */}
                      <div className="te-menu-wrapper">
                        <button
                          className="te-btn"
                          style={{ height: 28, fontSize: 11, padding: "0 8px" }}
                          onClick={() => {
                            setIsDownloadMenuOpen((prev) => !prev);
                            setIsCopyMenuOpen(false);
                            setIsColumnPickerOpen(false);
                          }}
                          title={`Tải xuống các log đang hiển thị (${sortedSpans.length} dòng)`}
                        >
                          <span>⬇️ Export ▾</span>
                        </button>

                        {isDownloadMenuOpen ? (
                          <>
                            <div
                              className="te-popover-backdrop"
                              onClick={() => setIsDownloadMenuOpen(false)}
                            />
                            <div className="te-menu-popover">
                              <button
                                className="te-menu-item"
                                onClick={() => {
                                  const text = formatFlowPayloadReport(activeSelection.conversation, activeSelection.trace);
                                  const filename = generateExportFilename(
                                    activeSelection.isAllTurns ? "flow_report_conv" : "flow_report_turn",
                                    targetId,
                                    "md"
                                  );
                                  downloadFile(text, filename, "text/markdown");
                                  showToast(`✓ Đã tải xuống ${filename}`);
                                  setIsDownloadMenuOpen(false);
                                }}
                              >
                                <span>Flow & Payload Report</span>
                                <span className="te-menu-item-subtitle">.md</span>
                              </button>
                              <button
                                className="te-menu-item"
                                onClick={() => {
                                  const text = formatDisplayedLogsSummary({
                                    spans: sortedSpans,
                                    title: targetTitle,
                                    durationMs: targetDuration,
                                    visibleColumns,
                                    isVietnameseEvents,
                                    timeSortOrder,
                                    showTurnBadge: Boolean(
                                      activeSelection.isAllTurns && activeSelection.conversation.traces.length > 1
                                    ),
                                    format: "text",
                                  });
                                  const filename = generateExportFilename(targetPrefix, targetId, "txt");
                                  downloadFile(text, filename, "text/plain");
                                  showToast(`✓ Đã tải xuống ${filename} (${sortedSpans.length} dòng hiển thị)`);
                                  setIsDownloadMenuOpen(false);
                                }}
                              >
                                <span>Text Summary File (Theo hiển thị)</span>
                                <span className="te-menu-item-subtitle">.txt</span>
                              </button>
                              <button
                                className="te-menu-item"
                                onClick={() => {
                                  const text = formatDisplayedLogsSummary({
                                    spans: sortedSpans,
                                    title: targetTitle,
                                    durationMs: targetDuration,
                                    visibleColumns,
                                    isVietnameseEvents,
                                    timeSortOrder,
                                    showTurnBadge: Boolean(
                                      activeSelection.isAllTurns && activeSelection.conversation.traces.length > 1
                                    ),
                                    format: "tsv",
                                  });
                                  const filename = generateExportFilename(targetPrefix, targetId, "tsv");
                                  downloadFile(text, filename, "text/tab-separated-values");
                                  showToast(`✓ Đã tải xuống ${filename} (Mở bằng Excel)`);
                                  setIsDownloadMenuOpen(false);
                                }}
                              >
                                <span>Excel / TSV File (Theo hiển thị)</span>
                                <span className="te-menu-item-subtitle">.tsv</span>
                              </button>
                              <button
                                className="te-menu-item"
                                onClick={() => {
                                  const text = formatDisplayedLogsSummary({
                                    spans: sortedSpans,
                                    title: targetTitle,
                                    durationMs: targetDuration,
                                    visibleColumns,
                                    isVietnameseEvents,
                                    timeSortOrder,
                                    showTurnBadge: Boolean(
                                      activeSelection.isAllTurns && activeSelection.conversation.traces.length > 1
                                    ),
                                    format: "markdown",
                                  });
                                  const filename = generateExportFilename(`table_${targetPrefix}`, targetId, "md");
                                  downloadFile(text, filename, "text/markdown");
                                  showToast(`✓ Đã tải xuống ${filename}`);
                                  setIsDownloadMenuOpen(false);
                                }}
                              >
                                <span>Markdown Table File</span>
                                <span className="te-menu-item-subtitle">.md</span>
                              </button>
                              <button
                                className="te-menu-item"
                                onClick={() => {
                                  const text = formatLogsAsPrettyJson(targetRecords);
                                  const filename = generateExportFilename(targetPrefix, targetId, "json");
                                  downloadFile(text, filename, "application/json");
                                  showToast(`✓ Đã tải xuống ${filename}`);
                                  setIsDownloadMenuOpen(false);
                                }}
                              >
                                <span>Pretty JSON File (Raw)</span>
                                <span className="te-menu-item-subtitle">.json</span>
                              </button>
                              <button
                                className="te-menu-item"
                                onClick={() => {
                                  const text = formatLogsAsJsonl(targetRecords);
                                  const filename = generateExportFilename(targetPrefix, targetId, "jsonl");
                                  downloadFile(text, filename, "application/x-ndjson");
                                  showToast(`✓ Đã tải xuống ${filename}`);
                                  setIsDownloadMenuOpen(false);
                                }}
                              >
                                <span>JSONL File (Raw)</span>
                                <span className="te-menu-item-subtitle">.jsonl</span>
                              </button>
                            </div>
                          </>
                        ) : null}
                      </div>
                    </div>

                    <div className="te-action-bar-right" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        className={`te-btn ${isVietnameseEvents ? "active" : ""}`}
                        style={{
                          height: 26,
                          fontSize: 11,
                          padding: "0 8px",
                          borderRadius: 4,
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          background: isVietnameseEvents ? "rgba(59, 130, 246, 0.15)" : "transparent",
                          borderColor: isVietnameseEvents ? "var(--color-accent, #3b82f6)" : "var(--color-border-subtle, #333)",
                          color: isVietnameseEvents ? "var(--color-accent, #60a5fa)" : "var(--color-text-secondary, #aaa)",
                        }}
                        onClick={() => setIsVietnameseEvents((prev) => !prev)}
                        title="Bật/Tắt chế độ hiển thị sự kiện tiếng Việt và giải nghĩa dòng chảy hệ thống"
                      >
                        <span>🇻🇳 {isVietnameseEvents ? "Tiếng Việt" : "Tiếng Anh"}</span>
                      </button>

                      <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>
                        {sortedSpans.length} events
                      </span>
                    </div>
                  </div>
                );
              })()}

              {/* Kibana Table */}
              <div className="te-kibana-container">
                <table className="te-kibana-table">
                  <thead>
                    <tr>
                      <th style={{ width: 28, padding: "8px 4px 8px 8px" }}></th>
                      {visibleColumns.time && (
                        <th
                          className="te-th-sortable"
                          onClick={() => setTimeSortOrder((prev) => (prev === "asc" ? "desc" : "asc"))}
                          title="Click để đổi chiều sắp xếp theo thời gian"
                        >
                          Time{" "}
                          <span className="te-sort-icon">
                            {timeSortOrder === "asc" ? "▲" : "▼"}
                          </span>
                        </th>
                      )}
                      {visibleColumns.level && (
                        <th style={{ width: 60, textAlign: "center" }}>Level</th>
                      )}
                      {visibleColumns.event && (
                        <th style={{ width: 200, minWidth: 170 }}>Event</th>
                      )}
                      {visibleColumns.message && <th>Message</th>}
                      {visibleColumns.duration && (
                        <th style={{ width: 70, textAlign: "right" }}>Duration</th>
                      )}
                      {visibleColumns.spanId && <th>Span ID</th>}
                      {visibleColumns.requestId && <th>Request ID</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSpans.map((span, idx) => {
                      const isSelected = selectedRecord === span.record;
                      const isExpanded = expandedSpanIds.has(span.spanId);
                      const detail = span.record.detail || {};
                      const safe = (detail.safeDetails as Record<string, unknown>) || {};
                      const previewText = extractSpanMessage(span, isVietnameseEvents);

                      const activeTab = expandedDocTabs[span.spanId] || "table";
                      const colSpanCount = 1 + activeColumnCount;

                      return (
                        <Fragment key={`${span.spanId}-${idx}`}>
                          <tr
                            className={`te-kibana-row ${isSelected ? "selected" : ""} ${
                              isExpanded ? "is-expanded" : ""
                            }`}
                            onClick={() => setSelectedRecord(span.record)}
                          >
                            <td
                              className="te-td-expand"
                              onClick={(e) => toggleRowExpanded(span.spanId, e)}
                              title={isExpanded ? "Thu gọn chi tiết" : "Mở rộng chi tiết"}
                            >
                              <span
                                style={{
                                  display: "inline-block",
                                  transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                                  transition: "transform 0.15s ease",
                                  fontSize: 10,
                                  lineHeight: 1,
                                }}
                              >
                                ▶
                              </span>
                            </td>
                            {visibleColumns.time && (
                              <td className="te-td-time" title={span.record.at}>
                                {formatKibanaTime(span.startTime)}
                              </td>
                            )}
                            {visibleColumns.level && (
                              <td className="te-td-level">
                                <span
                                  className={`te-kibana-badge ${
                                    span.status === "failed"
                                      ? "te-kibana-badge-error"
                                      : span.status === "warning"
                                      ? "te-kibana-badge-warn"
                                      : "te-kibana-badge-info"
                                  }`}
                                >
                                  {span.record.level.toUpperCase()}
                                </span>
                              </td>
                            )}
                            {visibleColumns.event && (() => {
                              const translation = isVietnameseEvents ? getEventTranslation(span.name) : null;
                              return (
                                <td
                                  className="te-td-event"
                                  title={
                                    translation
                                      ? `${translation.phase}\n${translation.descVi}\n(Mã gốc: ${span.name})`
                                      : span.name
                                  }
                                >
                                  <div
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 6,
                                      minWidth: 0,
                                      overflow: "hidden",
                                    }}
                                  >
                                    {activeSelection.isAllTurns &&
                                    activeSelection.conversation.traces.length > 1 &&
                                    span.turnIndex ? (
                                      <span
                                        className="te-turn-badge-tag"
                                        style={{ flexShrink: 0 }}
                                        title={`Thuộc Turn #${span.turnIndex} (Trace: ${span.traceId || ""})`}
                                      >
                                        T{span.turnIndex}
                                      </span>
                                    ) : null}
                                    {translation ? (
                                      <span
                                        style={{
                                          display: "inline-flex",
                                          alignItems: "center",
                                          gap: 5,
                                          minWidth: 0,
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        <span style={{ fontSize: 13, lineHeight: 1, flexShrink: 0 }}>
                                          {translation.icon}
                                        </span>
                                        <span
                                          style={{
                                            fontWeight: 500,
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                          }}
                                        >
                                          {translation.labelVi}
                                        </span>
                                      </span>
                                    ) : (
                                      <span
                                        style={{
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        {span.name}
                                      </span>
                                    )}
                                  </div>
                                </td>
                              );
                            })()}
                            {visibleColumns.message && (
                              <td className="te-td-message" title={previewText}>
                                {previewText}
                              </td>
                            )}
                            {visibleColumns.duration && (
                              <td className="te-td-duration">
                                {span.durationMs > 0 ? `${span.durationMs}ms` : "—"}
                              </td>
                            )}
                            {visibleColumns.spanId && (
                              <td className="te-td-spanid" title={span.spanId}>
                                {span.spanId}
                              </td>
                            )}
                            {visibleColumns.requestId && (
                              <td className="te-td-reqid" title={String(detail.requestId || "")}>
                                {String(detail.requestId || "—")}
                              </td>
                            )}
                          </tr>

                          {/* Kibana Inline Expanded Row */}
                          {isExpanded && (
                            <tr className="te-doc-expanded-row">
                              <td colSpan={colSpanCount}>
                                <div className="te-doc-expanded-content">
                                  <div className="te-doc-header">
                                    <div className="te-doc-tabs">
                                      <button
                                        className={`te-doc-tab-btn ${
                                          activeTab === "table" ? "active" : ""
                                        }`}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setExpandedDocTabs((p) => ({
                                            ...p,
                                            [span.spanId]: "table",
                                          }));
                                        }}
                                      >
                                        Table View
                                      </button>
                                      <button
                                        className={`te-doc-tab-btn ${
                                          activeTab === "json" ? "active" : ""
                                        }`}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setExpandedDocTabs((p) => ({
                                            ...p,
                                            [span.spanId]: "json",
                                          }));
                                        }}
                                      >
                                        JSON
                                      </button>
                                    </div>
                                    <div className="te-doc-actions">
                                      <button
                                        className="te-copy-btn"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          copyToClipboard(
                                            JSON.stringify(span.record, null, 2),
                                            `Doc ${span.spanId} copied!`
                                          );
                                        }}
                                      >
                                        {copyFeedback === `Doc ${span.spanId} copied!`
                                          ? "✓ Copied"
                                          : "Copy Document"}
                                      </button>
                                      <button
                                        className="te-copy-btn"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setSelectedRecord(span.record);
                                        }}
                                      >
                                        Open in Inspector →
                                      </button>
                                    </div>
                                  </div>

                                  {activeTab === "table" ? (
                                    <table className="te-doc-field-table">
                                      <tbody>
                                        <tr>
                                          <td className="te-doc-field-name">@timestamp</td>
                                          <td className="te-doc-field-value">{span.record.at}</td>
                                        </tr>
                                        <tr>
                                          <td className="te-doc-field-name">log.level</td>
                                          <td className="te-doc-field-value">{span.record.level}</td>
                                        </tr>
                                        <tr>
                                          <td className="te-doc-field-name">event.action</td>
                                          <td className="te-doc-field-value">
                                            <code>{span.record.event}</code>
                                            {isVietnameseEvents && (() => {
                                              const trans = getEventTranslation(span.record.event);
                                              return (
                                                <div style={{ marginTop: 4, fontSize: 12, color: "var(--color-accent, #60a5fa)" }}>
                                                  {trans.icon} <strong>{trans.labelVi}</strong> ({trans.phase})
                                                  <div style={{ color: "var(--color-text-secondary, #94a3b8)", fontSize: 11 }}>
                                                    {trans.descVi}
                                                  </div>
                                                </div>
                                              );
                                            })()}
                                          </td>
                                        </tr>
                                        {detail.traceId ? (
                                          <tr>
                                            <td className="te-doc-field-name">trace.id</td>
                                            <td className="te-doc-field-value">
                                              {String(detail.traceId)}
                                            </td>
                                          </tr>
                                        ) : null}
                                        {detail.spanId ? (
                                          <tr>
                                            <td className="te-doc-field-name">trace.span_id</td>
                                            <td className="te-doc-field-value">
                                              {String(detail.spanId)}
                                            </td>
                                          </tr>
                                        ) : null}
                                        {detail.parentSpanId ? (
                                          <tr>
                                            <td className="te-doc-field-name">trace.parent_span_id</td>
                                            <td className="te-doc-field-value">
                                              {String(detail.parentSpanId)}
                                            </td>
                                          </tr>
                                        ) : null}
                                        {detail.requestId ? (
                                          <tr>
                                            <td className="te-doc-field-name">http.request.id</td>
                                            <td className="te-doc-field-value">
                                              {String(detail.requestId)}
                                            </td>
                                          </tr>
                                        ) : null}
                                        {detail.conversationId ? (
                                          <tr>
                                            <td className="te-doc-field-name">conversation.id</td>
                                            <td className="te-doc-field-value">
                                              {String(detail.conversationId)}
                                            </td>
                                          </tr>
                                        ) : null}
                                        {span.turnIndex ? (
                                          <tr>
                                            <td className="te-doc-field-name">turn.index</td>
                                            <td className="te-doc-field-value">
                                              Turn #{span.turnIndex}
                                            </td>
                                          </tr>
                                        ) : null}
                                        {detail.line ? (
                                          <tr>
                                            <td className="te-doc-field-name">process.stdout.line</td>
                                            <td className="te-doc-field-value">
                                              {String(detail.line)}
                                              {isVietnameseEvents && translateDaemonLine(String(detail.line)) ? (
                                                <div style={{ marginTop: 2, fontSize: 11, color: "var(--color-accent, #60a5fa)" }}>
                                                  {translateDaemonLine(String(detail.line))}
                                                </div>
                                              ) : null}
                                            </td>
                                          </tr>
                                        ) : null}
                                        {detail.message ? (
                                          <tr>
                                            <td className="te-doc-field-name">message</td>
                                            <td className="te-doc-field-value">
                                              {String(detail.message)}
                                            </td>
                                          </tr>
                                        ) : null}
                                        {Object.entries(safe).map(([k, v]) => {
                                          const isLongText = typeof v === "string" && (v.length > 80 || v.includes("\n"));
                                          return (
                                            <tr key={k}>
                                              <td className="te-doc-field-name">safeDetails.{k}</td>
                                              <td className="te-doc-field-value">
                                                {isLongText ? (
                                                  <pre
                                                    style={{
                                                      margin: 0,
                                                      padding: "6px 10px",
                                                      background: "rgba(0, 0, 0, 0.25)",
                                                      borderRadius: 4,
                                                      maxHeight: 200,
                                                      overflow: "auto",
                                                      whiteSpace: "pre-wrap",
                                                      wordBreak: "break-word",
                                                      fontFamily: "var(--font-mono)",
                                                      fontSize: 12,
                                                    }}
                                                  >
                                                    {String(v)}
                                                  </pre>
                                                ) : typeof v === "object" ? (
                                                  JSON.stringify(v)
                                                ) : (
                                                  String(v)
                                                )}
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  ) : (
                                    <pre className="te-json-box">
                                      {JSON.stringify(span.record, null, 2)}
                                    </pre>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="te-empty-state">
              <Icon name="activity" width={32} height={32} />
              <span>Chọn một trace từ danh sách bên trái để xem timeline</span>
            </div>
          )}
        </div>

        {/* Slide-over Detail Drawer */}
        {selectedRecord ? (
          <div className="te-drawer">
            <div className="te-drawer-header">
              <div className="te-drawer-title">
                <span>{selectedRecord.event}</span>
                <span
                  className="te-badge"
                  style={{
                    color:
                      selectedRecord.level === "error"
                        ? "var(--color-text-error)"
                        : selectedRecord.level === "warning"
                        ? "var(--color-text-warning)"
                        : "var(--color-text-success)",
                  }}
                >
                  {selectedRecord.level.toUpperCase()}
                </span>
              </div>
              <button className="te-drawer-close" onClick={() => setSelectedRecord(null)}>
                <Icon name="close" width={16} height={16} />
              </button>
            </div>

            <div className="te-drawer-content">
              {/* Context Table */}
              <div>
                <div className="te-section-title">Context Metadata</div>
                <table className="te-kv-table">
                  <tbody>
                    <tr className="te-kv-row">
                      <td className="te-kv-key">Timestamp</td>
                      <td className="te-kv-value">{selectedRecord.at}</td>
                    </tr>
                    {selectedRecord.detail?.traceId ? (
                      <tr className="te-kv-row">
                        <td className="te-kv-key">Trace ID</td>
                        <td className="te-kv-value">{String(selectedRecord.detail.traceId)}</td>
                      </tr>
                    ) : null}
                    {selectedRecord.detail?.spanId ? (
                      <tr className="te-kv-row">
                        <td className="te-kv-key">Span ID</td>
                        <td className="te-kv-value">{String(selectedRecord.detail.spanId)}</td>
                      </tr>
                    ) : null}
                    {selectedRecord.detail?.requestId ? (
                      <tr className="te-kv-row">
                        <td className="te-kv-key">Request ID</td>
                        <td className="te-kv-value">{String(selectedRecord.detail.requestId)}</td>
                      </tr>
                    ) : null}
                    {selectedRecord.detail?.durationMs !== undefined ? (
                      <tr className="te-kv-row">
                        <td className="te-kv-key">Duration</td>
                        <td className="te-kv-value">{formatDuration(Number(selectedRecord.detail.durationMs))}</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>

              {/* Safe Details */}
              {selectedRecord.detail?.safeDetails &&
              Object.keys(selectedRecord.detail.safeDetails as object).length > 0 ? (
                <div>
                  <div className="te-section-title">Safe Details (Allowed)</div>
                  <table className="te-kv-table">
                    <tbody>
                      {Object.entries(selectedRecord.detail.safeDetails as Record<string, unknown>).map(
                        ([k, v]) => (
                          <tr className="te-kv-row" key={k}>
                            <td className="te-kv-key">{k}</td>
                            <td className="te-kv-value">
                              {typeof v === "object" ? JSON.stringify(v, null, 2) : String(v)}
                            </td>
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {/* Raw JSON */}
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <span className="te-section-title" style={{ margin: 0 }}>Raw Event JSON</span>
                  <button
                    className="te-copy-btn"
                    onClick={() =>
                      copyToClipboard(JSON.stringify(selectedRecord, null, 2), "Event JSON copied!")
                    }
                  >
                    {copyFeedback === "Event JSON copied!" ? "✓ Copied" : "Copy JSON"}
                  </button>
                </div>
                <div className="te-json-box">
                  {JSON.stringify(selectedRecord, null, 2)}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Toast Feedback Notification */}
      {feedbackToast ? (
        <div className="te-feedback-toast">
          <Icon name="check" width={16} height={16} />
          <span>{feedbackToast}</span>
        </div>
      ) : null}
    </div>
  );
}
