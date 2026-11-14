import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { activeWebTurnRegistry } from "../adapters/web";
import type { AppConfig } from "../config";
import { VERSION } from "../version";
import type { HttpTurnCounter, NativeCodexTurnIdentity } from "./http-turn-counter";
import type { ModelsMetricsSnapshot } from "./models-controller";

export interface AdminControllerOptions {
  config: AppConfig;
  startedAt: number;
  swaggerPath: string;
  httpTurns: HttpTurnCounter;
  getModelsMetrics: () => ModelsMetricsSnapshot;
  isDraining: () => boolean;
  setDraining: (next: boolean) => void;
  shutdown: () => void;
}

/**
 * Controller xử lý các endpoint vận hành, chẩn đoán và điều khiển vòng đời server:
 * `/docs`, `/swagger`, `/healthz`, `/admin/drain`, `/admin/resume`, `/admin/cancel-turn`,
 * `/admin/interrupt-turn`, `/admin/cancel-turns`, `/admin/shutdown`.
 */
export class AdminController {
  constructor(private readonly options: AdminControllerOptions) {}

  private isAuthorized(req: Request): boolean {
    const header = req.headers.get("authorization") ?? "";
    const expected = Buffer.from(`Bearer ${this.options.config.controlToken}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private activity() {
    return {
      active_http_turns: this.options.httpTurns.count(),
      active_browser_turns: activeWebTurnRegistry.activeCount(),
    };
  }

  /**
   * Phục vụ trang Swagger UI tĩnh.
   */
  public handleDocs(): Response {
    try {
      const html = readFileSync(this.options.swaggerPath, "utf8");
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch {
      return new Response("Swagger UI not found", { status: 404 });
    }
  }

  /**
   * Trả về trạng thái sức khỏe và các chỉ số hoạt động của server (`GET /healthz`).
   */
  public handleHealthz(): Response {
    return Response.json({
      status: "ok",
      service: "codex-chatgpt-web",
      version: VERSION,
      mode: this.options.config.mode,
      pid: process.pid,
      port: this.options.config.port,
      uptime: (Date.now() - this.options.startedAt) / 1_000,
      accepting_turns: !this.options.isDraining(),
      ...this.options.getModelsMetrics(),
      ...this.activity(),
    });
  }

  /**
   * Bật/tắt trạng thái drain (`POST /admin/drain`, `POST /admin/resume`).
   */
  public handleDrainToggle(req: Request, nextDraining: boolean): Response {
    if (!this.isAuthorized(req)) return new Response("Unauthorized", { status: 401 });
    this.options.setDraining(nextDraining);
    return Response.json({
      status: "ok",
      accepting_turns: !this.options.isDraining(),
      ...this.activity(),
    });
  }

  /**
   * Hủy một browser turn đang chạy theo `traceId` (`POST /admin/cancel-turn`).
   */
  public async handleCancelTurn(req: Request): Promise<Response> {
    if (!this.isAuthorized(req)) return new Response("Unauthorized", { status: 401 });

    let traceId = "";
    let reasonText: string | undefined;
    try {
      const body = await req.json() as { traceId?: unknown; reason?: unknown };
      traceId = typeof body?.traceId === "string" ? body.traceId.trim() : "";
      if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) {
        throw new Error("Browser turn trace id is invalid");
      }
      if (typeof body?.reason === "string" && body.reason.trim()) {
        reasonText = body.reason.trim();
      }
    } catch (error) {
      return Response.json(
        { status: "error", error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }

    const cancelReason = new DOMException(
      reasonText ? `Browser turn cancelled (${reasonText})` : "Browser turn cancelled by launcher",
      "AbortError",
    );
    const cancelledBrowserTurns = activeWebTurnRegistry.cancelByTraceId(traceId, cancelReason);
    return Response.json({
      status: "ok",
      trace_id: traceId,
      cancelled_browser_turns: cancelledBrowserTurns,
      cancelled_broker_turns: 0,
      cancelled_compaction_runs: 0,
      ...this.activity(),
    });
  }

  /**
   * Ngắt một Native Codex turn theo `threadId` + `turnId` (`POST /admin/interrupt-turn`).
   */
  public async handleInterruptTurn(req: Request): Promise<Response> {
    if (!this.isAuthorized(req)) return new Response("Unauthorized", { status: 401 });

    let identity: NativeCodexTurnIdentity;
    try {
      const body = await req.json() as { threadId?: unknown; turnId?: unknown };
      const threadId = typeof body?.threadId === "string" ? body.threadId.trim() : "";
      const turnId = typeof body?.turnId === "string" ? body.turnId.trim() : "";
      if (!/^[A-Za-z0-9_-]{6,128}$/.test(threadId) || !/^[A-Za-z0-9_-]{6,128}$/.test(turnId)) {
        throw new Error("native Codex threadId or turnId is invalid");
      }
      identity = { threadId, turnId };
    } catch (error) {
      return Response.json(
        { status: "error", error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }

    const reason = new DOMException("Codex turn interrupted", "AbortError");
    const httpCancellation = this.options.httpTurns.beginCancelTurn(identity, reason);
    return Response.json({
      status: "ok",
      cancelled_http_turns: httpCancellation.cancelled,
      cancelled_browser_turns: 0,
      cancelled_compaction_runs: 0,
    });
  }

  /**
   * Hủy toàn bộ HTTP & browser turns đang chạy (`POST /admin/cancel-turns`).
   */
  public async handleCancelTurns(req: Request): Promise<Response> {
    if (!this.isAuthorized(req)) return new Response("Unauthorized", { status: 401 });

    const reason = new Error("Active turn cancelled by launcher");
    const [cancelledHttpTurns, cancelledBrowserTurns] = await Promise.all([
      this.options.httpTurns.cancelAll(reason),
      activeWebTurnRegistry.cancelAll(reason),
    ]);
    return Response.json({
      status: "ok",
      cancelled_http_turns: cancelledHttpTurns,
      cancelled_browser_turns: cancelledBrowserTurns,
      cancelled_compaction_runs: 0,
      ...this.activity(),
    });
  }

  /**
   * Yêu cầu tắt server an toàn khi đã drain và không còn turn nào chạy (`POST /admin/shutdown`).
   */
  public handleShutdown(req: Request): Response {
    if (!this.isAuthorized(req)) return new Response("Unauthorized", { status: 401 });

    const current = this.activity();
    if (!this.options.isDraining() || current.active_http_turns > 0 || current.active_browser_turns > 0) {
      return Response.json(
        {
          status: "refused",
          accepting_turns: !this.options.isDraining(),
          ...current,
        },
        { status: 409 },
      );
    }

    setTimeout(this.options.shutdown, 0);
    return Response.json({
      status: "ok",
      accepting_turns: false,
      ...current,
    });
  }
}

