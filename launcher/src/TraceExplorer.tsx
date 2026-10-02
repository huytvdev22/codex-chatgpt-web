import { Fragment, useMemo, useState } from "react";
import type { LogRecord, Language } from "./types";
import type { Copy } from "./i18n";
import { Icon } from "./icons";
import "./trace-explorer.css";

export interface TraceSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  event: string;
  category: "request" | "provider" | "tool" | "loop" | "bridge" | "turn" | "generic";
  startTime: number;
  durationMs: number;
  status: "completed" | "failed" | "warning" | "running";
  record: LogRecord;
}

export interface TraceGroup {
  traceId: string;
  rootSpanId?: string;
  conversationId?: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  status: "completed" | "failed" | "warning" | "running";
  modelSlug?: string;
  toolNames: string[];
  records: LogRecord[];
  spans: TraceSpan[];
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
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<LogRecord | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [frozenLogs, setFrozenLogs] = useState<LogRecord[]>([]);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

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
      const detail = record.detail || {};
      const traceId = typeof detail.traceId === "string" ? detail.traceId : null;

      if (!traceId) {
        systemRecords.push(record);
        continue;
      }

      let group = traceMap.get(traceId);
      const recordTime = new Date(record.at).getTime() || Date.now();

      if (!group) {
        group = {
          traceId,
          rootSpanId: typeof detail.rootSpanId === "string" ? detail.rootSpanId : undefined,
          conversationId: typeof detail.conversationId === "string" ? detail.conversationId : undefined,
          startTime: recordTime,
          endTime: recordTime,
          durationMs: 0,
          status: "running",
          modelSlug: typeof detail.modelSlug === "string" ? detail.modelSlug : undefined,
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

      // Trích xuất metadata
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
        status: systemRecords.some(r => r.level === "error") ? "failed" : "completed",
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

  // Lọc Traces theo search query và filter pills
  const filteredTraces = useMemo(() => {
    return traces.filter(trace => {
      // 1. Lọc theo Level
      if (filterLevel === "error" && trace.status !== "failed") return false;
      if (filterLevel === "warning" && trace.status !== "warning") return false;
      if (filterLevel === "tools" && trace.toolNames.length === 0) return false;

      // 2. Lọc theo Search Query
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase().trim();
        const matchesTraceId = trace.traceId.toLowerCase().includes(query);
        const matchesModel = trace.modelSlug?.toLowerCase().includes(query);
        const matchesTool = trace.toolNames.some(t => t.toLowerCase().includes(query));
        const matchesEvent = trace.records.some(r => r.event.toLowerCase().includes(query));
        const matchesMessage = trace.records.some(r => {
          const detail = r.detail || {};
          const msg = typeof detail.message === "string" ? detail.message : "";
          const line = typeof detail.line === "string" ? detail.line : "";
          return msg.toLowerCase().includes(query) || line.toLowerCase().includes(query);
        });

        return matchesTraceId || matchesModel || matchesTool || matchesEvent || matchesMessage;
      }

      return true;
    });
  }, [traces, filterLevel, searchQuery]);

  // Trace đang được chọn
  const activeTrace = useMemo(() => {
    if (selectedTraceId) {
      const found = traces.find(t => t.traceId === selectedTraceId);
      if (found) return found;
    }
    return filteredTraces[0] || null;
  }, [traces, selectedTraceId, filteredTraces]);

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
    if (!activeTrace) return [];
    const list = [...activeTrace.spans];
    list.sort((a, b) => {
      const diff = a.startTime - b.startTime;
      return timeSortOrder === "asc" ? diff : -diff;
    });
    return list;
  }, [activeTrace, timeSortOrder]);

  const activeColumnCount = Object.values(visibleColumns).filter(Boolean).length;

  return (
    <div className="trace-explorer-container">
      {/* Thanh công cụ đỉnh */}
      <div className="te-toolbar">
        <div className="te-toolbar-left">
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
              All ({traces.length})
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
        {/* Cột trái: Danh sách Traces */}
        <div className="te-trace-list-panel">
          {filteredTraces.length === 0 ? (
            <div className="te-empty-state">
              <Icon name="logs" width={28} height={28} />
              <span>{copy.noLogs || "Không có trace nào phù hợp"}</span>
            </div>
          ) : (
            filteredTraces.map((trace) => {
              const isSelected = activeTrace?.traceId === trace.traceId;
              const isSystem = trace.traceId === "_system";
              return (
                <div
                  key={trace.traceId}
                  className={`te-trace-card ${isSelected ? "selected" : ""}`}
                  onClick={() => setSelectedTraceId(trace.traceId)}
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
                        {isSystem ? "System Logs" : trace.traceId.length > 20 ? `${trace.traceId.slice(0, 16)}...` : trace.traceId}
                      </span>
                    </div>
                    <span className="te-trace-time">
                      {new Date(trace.startTime).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                  </div>

                  <div className="te-trace-card-body">
                    <span className="te-trace-model">{trace.modelSlug || "Unknown Model"}</span>
                    <div className="te-trace-meta-tags">
                      {trace.toolNames.length > 0 ? (
                        <span className="te-badge te-badge-tool">{trace.toolNames.length} tool(s)</span>
                      ) : null}
                      {trace.durationMs > 0 ? (
                        <span className="te-badge te-badge-duration">{formatDuration(trace.durationMs)}</span>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Cột giữa: Cây Spans & Waterfall Timeline */}
        <div className="te-trace-detail-panel">
          {activeTrace ? (
            <>
              <div className="te-detail-header">
                <div className="te-detail-title-group">
                  <div className="te-detail-title">
                    <span>{activeTrace.modelSlug || "Trace Overview"}</span>
                    <span
                      className="te-badge"
                      style={{
                        backgroundColor:
                          activeTrace.status === "failed"
                            ? "var(--color-background-status-error)"
                            : "var(--color-background-status-success)",
                        color:
                          activeTrace.status === "failed"
                            ? "var(--color-text-error)"
                            : "var(--color-text-success)",
                      }}
                    >
                      {activeTrace.status.toUpperCase()}
                    </span>
                  </div>
                  <div className="te-detail-subtitle">
                    <span>
                      Trace ID: <code style={{ fontFamily: "var(--font-mono)" }}>{activeTrace.traceId}</code>
                    </span>
                    <button
                      className="te-copy-btn"
                      onClick={() => copyToClipboard(activeTrace.traceId, "Trace ID copied!")}
                      title="Copy Trace ID"
                    >
                      {copyFeedback === "Trace ID copied!" ? "✓ Copied" : "Copy"}
                    </button>
                    {activeTrace.durationMs > 0 ? (
                      <span>Total Time: {formatDuration(activeTrace.durationMs)}</span>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Kibana Action Bar: Time Sort, Column Picker */}
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
                      onClick={() => setIsColumnPickerOpen((prev) => !prev)}
                      title="Chọn các cột hiển thị"
                    >
                      <span>Columns ({activeColumnCount}/7) ▾</span>
                    </button>

                    {isColumnPickerOpen ? (
                      <>
                        <div
                          style={{ position: "fixed", inset: 0, zIndex: 110 }}
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
                </div>

                <div className="te-action-bar-right">
                  <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
                    {sortedSpans.length} events
                  </span>
                </div>
              </div>

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
                      {visibleColumns.event && <th>Event</th>}
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
                      const previewText =
                        (typeof detail.line === "string" && detail.line.trim()) ||
                        (typeof detail.message === "string" && detail.message.trim()) ||
                        (typeof detail.command === "string" && `$ ${detail.command.trim()}`) ||
                        (typeof safe.preview === "string" && safe.preview.trim()) ||
                        (typeof safe.promptPreview === "string" && safe.promptPreview.trim()) ||
                        (typeof safe.outputPreview === "string" && safe.outputPreview.trim()) ||
                        (typeof safe.url === "string" && safe.url.trim()) ||
                        (typeof safe.method === "string" &&
                          typeof safe.path === "string" &&
                          `${safe.method} ${safe.path}`) ||
                        (typeof detail.modelSlug === "string" && `Model: ${detail.modelSlug}`) ||
                        "—";

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
                            {visibleColumns.event && (
                              <td className="te-td-event" title={span.name}>
                                {span.name}
                              </td>
                            )}
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
                                          <td className="te-doc-field-value">{span.record.event}</td>
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
                                        {detail.line ? (
                                          <tr>
                                            <td className="te-doc-field-name">process.stdout.line</td>
                                            <td className="te-doc-field-value">
                                              {String(detail.line)}
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
                                        {Object.entries(safe).map(([k, v]) => (
                                          <tr key={k}>
                                            <td className="te-doc-field-name">safeDetails.{k}</td>
                                            <td className="te-doc-field-value">
                                              {typeof v === "object"
                                                ? JSON.stringify(v)
                                                : String(v)}
                                            </td>
                                          </tr>
                                        ))}
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
    </div>
  );
}
