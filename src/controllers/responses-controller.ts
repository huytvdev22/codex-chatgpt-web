import type { ProviderAdapterFactory } from "../adapters/adapter-registry";
import { formatErrorResponse } from "../bridge";
import { readJsonRequestBody } from "../http-body";
import { ResponsesService, type ResponseRequestOptions } from "../services/responses-service";

/**
 * Controller định tuyến cho `/v1/responses` và `/v1/responses/compact`:
 * chỉ đảm nhiệm đọc/kiểm tra HTTP request và ủy quyền toàn bộ xử lý nghiệp vụ cho `ResponsesService`.
 */
export class ResponsesController {
  constructor(
    private readonly responsesService: ResponsesService = new ResponsesService(),
  ) {}

  /**
   * Trả lỗi 426 cho phương thức `GET /v1/responses` (WebSocket transport chưa được bật).
   */
  public handleUnsupportedGet(): Response {
    return new Response("Responses WebSocket transport is not enabled on this local route", {
      status: 426,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  /**
   * Xử lý `POST /v1/responses`.
   */
  public async handleResponses(
    req: Request,
    options: ResponseRequestOptions = {},
    adapterFactory?: ProviderAdapterFactory,
  ): Promise<Response> {
    let raw: unknown;
    try {
      raw = await readJsonRequestBody(req);
    } catch (error) {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        error instanceof Error ? error.message : "Request body must be valid JSON",
      );
    }

    const requestedModel = raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as { model?: unknown }).model
      : undefined;

    try {
      this.responsesService.bindTurnIdentity(raw, options);
    } catch (error) {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        error instanceof Error ? error.message : String(error),
      );
    }

    const resolution = this.responsesService.resolveProvider(requestedModel);
    if (!resolution.ok) {
      return formatErrorResponse(400, "invalid_request_error", resolution.message);
    }

    return await this.responsesService.executeTurn({
      req,
      raw,
      requestedModel: resolution.requestedModel,
      providerId: resolution.provider.id,
      options,
      adapterFactory,
    });
  }

  /**
   * Xử lý `POST /v1/responses/compact`.
   */
  public async handleCompact(
    req: Request,
    options: Pick<ResponseRequestOptions, "onTurnIdentity"> = {},
    adapterFactory?: ProviderAdapterFactory,
  ): Promise<Response> {
    let raw: Record<string, unknown>;
    try {
      const parsed = await readJsonRequestBody(req);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      raw = parsed as Record<string, unknown>;
    } catch (error) {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        error instanceof Error ? error.message : "Compaction request body must be a JSON object",
      );
    }

    const { request: internalRequest, payload } = this.responsesService.prepareCompactionRequest(req, raw);
    try {
      this.responsesService.bindTurnIdentity(payload, options);
    } catch (error) {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        error instanceof Error ? error.message : String(error),
      );
    }

    if (typeof raw.model !== "string" || !raw.model) {
      return formatErrorResponse(400, "invalid_request_error", "Compaction request requires a model");
    }

    const resolution = this.responsesService.resolveProvider(raw.model);
    if (!resolution.ok) {
      return formatErrorResponse(400, "invalid_request_error", resolution.message);
    }

    return await this.handleResponses(internalRequest, options, adapterFactory);
  }
}
