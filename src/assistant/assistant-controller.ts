import { createHash } from "node:crypto";
import type { ProviderAdapterFactory } from "../adapters/adapter-registry";
import { formatErrorResponse } from "../bridge";
import type { AppConfig } from "../config";
import { ImagesController } from "../controllers/images-controller";
import { readJsonRequestBody } from "../http-body";
import { ModelCatalog } from "../models/model-catalog";
import { ImagesService } from "../services/images-service";
import {
  AssistantResponsesService,
  type AssistantRequestOptions,
} from "./assistant-responses-service";

/**
 * Controller độc lập cho nhóm route `/clients/assistant/v1/*`:
 * - `GET /clients/assistant/v1/models` (read-only từ ModelCatalog, không sửa `~/.codex/config.toml`)
 * - `GET /clients/assistant/v1/responses` (`426` để Codex fallback về HTTP SSE)
 * - `POST /clients/assistant/v1/responses`
 * - `POST /clients/assistant/v1/responses/compact`
 * - `POST /clients/assistant/v1/images/generations` & `POST /clients/assistant/v1/images/edits`
 */
export class AssistantController {
  private readonly imagesController: ImagesController;

  constructor(
    private readonly assistantService: AssistantResponsesService = new AssistantResponsesService(),
    private readonly modelCatalog: ModelCatalog = ModelCatalog.getInstance(),
    imagesController?: ImagesController,
  ) {
    this.imagesController =
      imagesController ??
      new ImagesController(
        new ImagesService(
          this.assistantService,
          undefined,
          undefined,
          // Không fallback đọc ~/.codex/config.toml của VS Code Codex.
          () => undefined,
        ),
      );
  }

  public handleUnsupportedGet(): Response {
    return new Response("Responses WebSocket transport is not enabled on this local route", {
      status: 426,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  public handleModels(config: AppConfig): Response {
    try {
      const catalog = this.modelCatalog.buildCatalog(config);
      const body = JSON.stringify(catalog);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/json",
          etag: `W/"${createHash("sha256").update(body).digest("base64url")}"`,
        },
      });
    } catch (error) {
      return formatErrorResponse(
        500,
        "server_error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  public async handleResponses(
    req: Request,
    options: AssistantRequestOptions = {},
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

    const requestedModel =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as { model?: unknown }).model
        : undefined;

    try {
      this.assistantService.bindTurnIdentity(raw, options);
    } catch (error) {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        error instanceof Error ? error.message : String(error),
      );
    }

    const resolution = this.assistantService.resolveProvider(requestedModel);
    if (!resolution.ok) {
      return formatErrorResponse(400, "invalid_request_error", resolution.message);
    }

    return await this.assistantService.executeTurn({
      req,
      raw,
      requestedModel: resolution.requestedModel,
      providerId: resolution.provider.id,
      options,
      adapterFactory,
    });
  }

  public async handleCompact(
    req: Request,
    options: Pick<AssistantRequestOptions, "onTurnIdentity"> = {},
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

    const { request: internalRequest, payload } =
      this.assistantService.prepareCompactionRequest(req, raw);
    try {
      this.assistantService.bindTurnIdentity(payload, options);
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

    const resolution = this.assistantService.resolveProvider(raw.model);
    if (!resolution.ok) {
      return formatErrorResponse(400, "invalid_request_error", resolution.message);
    }

    return await this.handleResponses(internalRequest, options, adapterFactory);
  }

  public async handleImageGenerations(
    req: Request,
    adapterFactory?: ProviderAdapterFactory,
  ): Promise<Response> {
    return await this.imagesController.handleGenerations(req, adapterFactory);
  }

  public async handleImageEdits(
    req: Request,
    adapterFactory?: ProviderAdapterFactory,
  ): Promise<Response> {
    return await this.imagesController.handleEdits(req, adapterFactory);
  }
}
