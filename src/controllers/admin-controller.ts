import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { activeWebTurnRegistry, ProviderBusyError } from "../adapters/web";
import { readCodexSubagentProtocol } from "../codex-integration";
import type { AppConfig } from "../config";
import { ModelConfigError, type ModelOverridePatch } from "../models/model-config-store";
import { LimitManagementService } from "../services/limit-management-service";
import { ModelManagementService } from "../services/model-management-service";
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
  modelManagementService?: ModelManagementService;
  limitManagementService?: LimitManagementService;
}

/**
 * Controller xử lý các endpoint vận hành, chẩn đoán và điều khiển vòng đời server:
 * `/docs`, `/swagger`, `/healthz`, `/admin/drain`, `/admin/resume`, `/admin/cancel-turn`,
 * `/admin/interrupt-turn`, `/admin/cancel-turns`, `/admin/shutdown`, `/admin/models/*`,
 * `/admin/limits/*`, `/v1/limits`.
 */
export class AdminController {
  private readonly modelManagementService: ModelManagementService;
  private readonly limitManagementService: LimitManagementService;

  constructor(private readonly options: AdminControllerOptions) {
    this.modelManagementService =
      options.modelManagementService ?? new ModelManagementService();
    this.limitManagementService =
      options.limitManagementService ?? new LimitManagementService();
  }

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

  private resolveCatalogConfig(): AppConfig {
    try {
      return {
        ...this.options.config,
        subagentProtocol: readCodexSubagentProtocol(this.options.config.subagentProtocol),
      };
    } catch {
      return this.options.config;
    }
  }

  private handleModelError(error: unknown): Response {
    if (error instanceof ProviderBusyError) {
      return Response.json(
        {
          status: "error",
          code: "PROVIDER_BUSY",
          providerId: error.providerId,
          error: error.message,
        },
        { status: 409 },
      );
    }
    if (error instanceof ModelConfigError) {
      return Response.json(
        {
          status: "error",
          code: error.code,
          error: error.message,
        },
        { status: error.statusCode },
      );
    }
    return Response.json(
      {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }

  /** Lấy snapshot danh mục model & trạng thái ON/OFF (`GET /admin/models`). */
  public handleGetModels(req: Request): Response {
    if (!this.isAuthorized(req)) return new Response("Unauthorized", { status: 401 });
    return Response.json({
      status: "ok",
      snapshot: this.modelManagementService.getSnapshot(),
    });
  }

  /** Cập nhật bật/tắt hoặc override metadata của một model (`PUT /admin/models/override`). */
  public async handleUpdateModelOverride(req: Request): Promise<Response> {
    if (!this.isAuthorized(req)) return new Response("Unauthorized", { status: 401 });
    let slug = "";
    let patch: ModelOverridePatch = {};
    try {
      const body = await req.json() as { slug?: unknown; patch?: unknown };
      slug = typeof body?.slug === "string" ? body.slug.trim() : "";
      if (!slug) throw new Error("'slug' is required");
      if (!body?.patch || typeof body.patch !== "object" || Array.isArray(body.patch)) {
        throw new Error("'patch' must be a JSON object");
      }
      patch = body.patch as ModelOverridePatch;
    } catch (error) {
      return Response.json(
        { status: "error", error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }

    try {
      const snapshot = this.modelManagementService.updateOverride(
        slug,
        patch,
        this.resolveCatalogConfig(),
      );
      return Response.json({ status: "ok", snapshot });
    } catch (error) {
      return this.handleModelError(error);
    }
  }

  /** Bật/tắt toàn bộ model khả dụng của một provider (`PUT /admin/models/provider-toggle`). */
  public async handleToggleProviderModels(req: Request): Promise<Response> {
    if (!this.isAuthorized(req)) return new Response("Unauthorized", { status: 401 });
    let providerId = "";
    let enabled = true;
    try {
      const body = await req.json() as { providerId?: unknown; enabled?: unknown };
      providerId = typeof body?.providerId === "string" ? body.providerId.trim() : "";
      if (!providerId) throw new Error("'providerId' is required");
      if (typeof body?.enabled !== "boolean") throw new Error("'enabled' must be a boolean");
      enabled = body.enabled;
    } catch (error) {
      return Response.json(
        { status: "error", error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }

    try {
      const snapshot = this.modelManagementService.toggleProvider(
        providerId,
        enabled,
        this.resolveCatalogConfig(),
      );
      return Response.json({ status: "ok", snapshot });
    } catch (error) {
      return this.handleModelError(error);
    }
  }

  /** Khôi phục 1 model hoặc toàn bộ danh mục về mặc định (`POST /admin/models/reset`). */
  public async handleResetModels(req: Request): Promise<Response> {
    if (!this.isAuthorized(req)) return new Response("Unauthorized", { status: 401 });
    let slug: string | undefined;
    try {
      const text = await req.text();
      if (text.trim()) {
        const body = JSON.parse(text) as { slug?: unknown };
        if (body.slug !== undefined) {
          if (typeof body.slug !== "string" || !body.slug.trim()) {
            throw new Error("'slug' must be a non-empty string when provided");
          }
          slug = body.slug.trim();
        }
      }
    } catch (error) {
      return Response.json(
        { status: "error", error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }

    try {
      const config = this.resolveCatalogConfig();
      const snapshot = slug
        ? this.modelManagementService.resetModel(slug, config)
        : this.modelManagementService.resetAll(config);
      return Response.json({ status: "ok", snapshot });
    } catch (error) {
      return this.handleModelError(error);
    }
  }

  /** Kích hoạt Auto-Discovery quét model sống cho 1 hoặc tất cả provider (`POST /admin/models/refresh`). */
  public async handleRefreshModels(req: Request): Promise<Response> {
    if (!this.isAuthorized(req)) return new Response("Unauthorized", { status: 401 });
    let providerId: string | undefined;
    try {
      const text = await req.text();
      if (text.trim()) {
        const body = JSON.parse(text) as { providerId?: unknown };
        if (body.providerId !== undefined) {
          if (typeof body.providerId !== "string" || !body.providerId.trim()) {
            throw new Error("'providerId' must be a non-empty string when provided");
          }
          providerId = body.providerId.trim();
        }
      }
    } catch (error) {
      return Response.json(
        { status: "error", error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }

    try {
      const outcome = await this.modelManagementService.refreshModels(
        providerId,
        this.resolveCatalogConfig(),
        req.signal,
      );
      return Response.json({
        status: "ok",
        ...outcome,
      });
    } catch (error) {
      return this.handleModelError(error);
    }
  }

  /** Lấy cache hạn mức tài khoản theo từng provider & profile (`GET /admin/limits`). */
  public handleGetLimits(req: Request): Response {
    if (!this.isAuthorized(req)) return new Response("Unauthorized", { status: 401 });
    return Response.json({
      status: "ok",
      snapshot: this.limitManagementService.getSnapshot(),
    });
  }

  /** Tra cứu nhanh cache hạn mức tài khoản từ localhost (`GET /v1/limits`, không kích hoạt mở tab). */
  public handleGetPublicLimits(): Response {
    const snapshot = this.limitManagementService.getSnapshot();
    return Response.json({
      object: "list",
      version: snapshot.version,
      updatedAt: snapshot.updatedAt,
      warningThresholdPercent: snapshot.warningThresholdPercent,
      data: snapshot.entries,
    });
  }

  /** Kích hoạt kiểm tra hạn mức trực tiếp cho 1 profile/provider hoặc tất cả (`POST /admin/limits/refresh`). */
  public async handleRefreshLimits(req: Request): Promise<Response> {
    if (!this.isAuthorized(req)) return new Response("Unauthorized", { status: 401 });
    let providerId: string | undefined;
    let profileId: string | undefined;
    try {
      const text = await req.text();
      if (text.trim()) {
        const body = JSON.parse(text) as { providerId?: unknown; profileId?: unknown };
        if (body.providerId !== undefined) {
          if (typeof body.providerId !== "string" || !body.providerId.trim()) {
            throw new Error("'providerId' must be a non-empty string when provided");
          }
          providerId = body.providerId.trim();
        }
        if (body.profileId !== undefined) {
          if (typeof body.profileId !== "string" || !body.profileId.trim()) {
            throw new Error("'profileId' must be a non-empty string when provided");
          }
          profileId = body.profileId.trim();
        }
      }
    } catch (error) {
      return Response.json(
        { status: "error", error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }

    try {
      const outcome = await this.limitManagementService.refreshLimits({
        providerId,
        profileId,
        abortSignal: req.signal,
      });
      return Response.json({
        status: "ok",
        ...outcome,
      });
    } catch (error) {
      return this.handleModelError(error);
    }
  }
}

