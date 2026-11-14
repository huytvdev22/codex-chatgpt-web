import { createHash } from "node:crypto";
import { formatErrorResponse } from "../bridge";
import {
  readCodexModelContextOverride,
  readCodexSubagentProtocol,
  type CodexModelContextOverride,
} from "../codex-integration";
import type { AppConfig } from "../config";
import { ModelCatalog } from "../models/model-catalog";
import type { HttpTurnCounter } from "./http-turn-counter";

export interface ModelCatalogFailure {
  stage: "config" | "request" | "transport" | "upstream" | "catalog";
  code?: string;
}

export interface ModelCatalogResultRecord {
  request: number;
  at: string;
  status: number;
  failure?: ModelCatalogFailure;
}

export interface ModelsMetricsSnapshot {
  successful_model_catalog_requests: number;
  last_successful_model_catalog_request_at: string | null;
  model_catalog_requests: number;
  last_model_catalog_result: ModelCatalogResultRecord | null;
}

function modelCatalogFailure(stage: ModelCatalogFailure["stage"], error: unknown): ModelCatalogFailure {
  if (!error || typeof error !== "object") return { stage };
  for (const source of [error, "cause" in error ? error.cause : undefined]) {
    const code = source && typeof source === "object" && "code" in source ? source.code : undefined;
    if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) return { stage, code };
  }
  const name = "name" in error ? error.name : undefined;
  if (name === "AbortError") return { stage, code: "ABORT_ERR" };
  if (name === "TimeoutError") return { stage, code: "ETIMEDOUT" };
  return { stage };
}

/**
 * Controller xử lý endpoint `GET /v1/models`, ủy quyền xây dựng catalog cho `ModelCatalog`
 * và ghi nhận các chỉ số chẩn đoán phục vụ `/healthz`.
 */
export class ModelsController {
  private successfulRequests = 0;
  private lastSuccessfulRequestAt: string | null = null;
  private totalRequests = 0;
  private lastResult: ModelCatalogResultRecord | null = null;

  constructor(
    private readonly modelCatalog: ModelCatalog = ModelCatalog.getInstance(),
  ) {}

  /**
   * Trả về ảnh chụp metrics của catalog để `AdminController` nhúng vào `/healthz`.
   */
  public getMetricsSnapshot(): ModelsMetricsSnapshot {
    return {
      successful_model_catalog_requests: this.successfulRequests,
      last_successful_model_catalog_request_at: this.lastSuccessfulRequestAt,
      model_catalog_requests: this.totalRequests,
      last_model_catalog_result: this.lastResult,
    };
  }

  /**
   * Xử lý một request lấy danh sách model (dùng chung cho HTTP route và hàm facade `modelsRequest`).
   */
  public async handleModelsRequest(
    _req: Request,
    config: AppConfig,
    contextOverride?: () => CodexModelContextOverride | undefined,
    onFailure?: (failure: ModelCatalogFailure) => void,
  ): Promise<Response> {
    let catalog: Record<string, unknown>;
    try {
      contextOverride?.();
      catalog = this.modelCatalog.buildAndSyncCatalog(config);
    } catch (error) {
      onFailure?.(modelCatalogFailure("catalog", error));
      return formatErrorResponse(500, "server_error", error instanceof Error ? error.message : String(error));
    }

    const body = JSON.stringify(catalog);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "etag": `W/"${createHash("sha256").update(body).digest("base64url")}"`,
      },
    });
  }

  /**
   * Xử lý HTTP route `GET /v1/models` kèm kiểm tra `draining`, tracking và lưu metrics.
   */
  public async handleRoute(
    req: Request,
    config: AppConfig,
    httpTurns: HttpTurnCounter,
    draining: boolean,
  ): Promise<Response> {
    if (draining) {
      return formatErrorResponse(
        503,
        "server_error",
        "codex-chatgpt-web is draining for a requested service operation",
      );
    }

    return httpTurns.track(async signal => {
      const request = ++this.totalRequests;
      const started = Date.now();
      const recordResult = (response: Response, failure?: ModelCatalogFailure): Response => {
        const result: ModelCatalogResultRecord = {
          request,
          at: new Date().toISOString(),
          status: response.status,
          ...(failure ? { failure } : {}),
        };
        // An older, slower request must not replace a newer completed result.
        if (!this.lastResult || request > this.lastResult.request) {
          this.lastResult = result;
        }
        if (!response.ok) {
          try {
            console.warn(`[codex-chatgpt-web] model_catalog_failed ${JSON.stringify({ ...result, elapsedMs: Date.now() - started })}`);
          } catch {
            // Logging must not replace the catalog result.
          }
        }
        return response;
      };

      let catalogConfig: AppConfig;
      try {
        catalogConfig = {
          ...config,
          subagentProtocol: readCodexSubagentProtocol(config.subagentProtocol),
        };
      } catch (error) {
        return recordResult(
          formatErrorResponse(
            500,
            "server_error",
            `Could not resolve the installed subagent protocol: ${error instanceof Error ? error.message : String(error)}`,
          ),
          modelCatalogFailure("config", error),
        );
      }

      let failure: ModelCatalogFailure | undefined;
      const response = await this.handleModelsRequest(
        new Request(req, { signal }),
        catalogConfig,
        readCodexModelContextOverride,
        value => { failure = value; },
      );
      if (response.ok) {
        this.successfulRequests += 1;
        this.lastSuccessfulRequestAt = new Date().toISOString();
      }
      return recordResult(response, failure);
    }, req.signal, process.platform, "models");
  }
}

