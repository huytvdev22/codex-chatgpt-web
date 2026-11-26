import type { ProviderAdapterFactory } from "../adapters/adapter-registry";
import { formatErrorResponse } from "../bridge";
import { readJsonRequestBody } from "../http-body";
import { ImagesService, type ParsedImageRequest } from "../services/images-service";

/**
 * Controller xử lý các route OpenAI Images API:
 * `POST /v1/images/generations` và `POST /v1/images/edits`.
 */
export class ImagesController {
  constructor(private readonly imagesService: ImagesService) {}

  public async handleGenerations(
    req: Request,
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

    const validated = this.imagesService.validateGenerationJson(raw);
    if (!validated.ok) {
      return formatErrorResponse(400, "invalid_request_error", validated.message);
    }

    return await this.imagesService.executeImageTurn({
      req,
      parsed: validated.parsed,
      adapterFactory,
    });
  }

  public async handleEdits(
    req: Request,
    adapterFactory?: ProviderAdapterFactory,
  ): Promise<Response> {
    const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
    let validated:
      | { ok: true; parsed: ParsedImageRequest }
      | { ok: false; message: string };

    if (contentType.includes("multipart/form-data")) {
      try {
        const form = await req.formData();
        validated = await this.imagesService.parseEditFormData(form);
      } catch (error) {
        return formatErrorResponse(
          400,
          "invalid_request_error",
          error instanceof Error ? error.message : "Invalid multipart form data",
        );
      }
    } else {
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
      validated = this.imagesService.validateEditJson(raw);
    }

    if (!validated.ok) {
      return formatErrorResponse(400, "invalid_request_error", validated.message);
    }

    return await this.imagesService.executeImageTurn({
      req,
      parsed: validated.parsed,
      adapterFactory,
    });
  }
}
