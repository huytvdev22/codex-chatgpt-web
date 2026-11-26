import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderAdapter, ImageTurnRequest } from "../src/adapters/base";
import { GeminiImageRefusalError } from "../src/adapters/gemini";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";
import { ImagesService, resolveRequestedAspectRatio } from "../src/services/images-service";
import { ResponsesService } from "../src/services/responses-service";

const ONE_BY_ONE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeMockAdapter(
  onImageTurn: (req: ImageTurnRequest) => Promise<{ imageBase64: string; mimeType: string; revisedPrompt?: string }>,
): ProviderAdapter {
  return {
    name: "gemini",
    async runTurn() {},
    async runImageTurn(req) {
      return await onImageTurn(req);
    },
  };
}

describe("resolveRequestedAspectRatio", () => {
  test("ánh xạ kích thước WIDTHxHEIGHT về tỉ lệ khung hình Gemini chuẩn gần nhất", () => {
    expect(resolveRequestedAspectRatio("1536x1024", "a mug")).toBe("4:3");
    expect(resolveRequestedAspectRatio("2048x1152", "a mug")).toBe("16:9");
    expect(resolveRequestedAspectRatio("3840x2160", "a mug")).toBe("16:9");
    expect(resolveRequestedAspectRatio("1024x1536", "a mug")).toBe("3:4");
    expect(resolveRequestedAspectRatio("2160x3840", "a mug")).toBe("9:16");
    expect(resolveRequestedAspectRatio("1024x1024", "a mug")).toBe("1:1");
    expect(resolveRequestedAspectRatio("1200x900", "a mug")).toBe("4:3");
    expect(resolveRequestedAspectRatio("900x1200", "a mug")).toBe("3:4");
  });

  test("tự trích xuất tỉ lệ tường minh từ prompt khi size='auto', trống, hoặc là mức OpenAI mặc định (1024x1024 / 1536x1024), tránh bắt nhầm giờ", () => {
    expect(resolveRequestedAspectRatio("auto", "Create a 16:9 banner of a mountain")).toBe("16:9");
    expect(resolveRequestedAspectRatio(undefined, "Poster tỉ lệ 9:16 phong cách tối giản")).toBe("9:16");
    expect(resolveRequestedAspectRatio("1024x1024", "Cartoon kitten, 16:9 widescreen aspect ratio.")).toBe("16:9");
    expect(resolveRequestedAspectRatio("1536x1024", "Scenic valley, 16:9")).toBe("16:9");
    expect(resolveRequestedAspectRatio("auto", "Draw a clock at 11:15 on a desk")).toBeUndefined();
    expect(resolveRequestedAspectRatio("auto", "Simple coffee cup illustration")).toBeUndefined();
  });
});

describe("ImagesService & /v1/images/* HTTP routes", () => {
  test("POST /v1/images/generations chạy thành công khi active turn dùng Gemini và trả chuẩn OpenAI JSON", async () => {
    const capturedRequests: ImageTurnRequest[] = [];
    const responsesService = new ResponsesService(undefined, undefined, () => "gemini/4-hydrogen");
    const service = new ImagesService(responsesService, undefined, undefined, () => "gemini/4-hydrogen");

    const parsed = service.validateGenerationJson({
      model: "gpt-image-2",
      prompt: "Minimalist 16:9 sunrise over mountains",
      size: "auto",
      background: "opaque",
      quality: "auto",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const req = new Request("http://127.0.0.1/v1/images/generations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread-gem-1",
          turn_id: "turn-1",
          model: "gemini/4-hydrogen",
          reasoning_effort: "high",
        }),
      },
      body: JSON.stringify({}),
    });

    const resp = await service.executeImageTurn({
      req,
      parsed: parsed.parsed,
      adapterFactory: () =>
        makeMockAdapter(async (imageReq) => {
          capturedRequests.push(imageReq);
          return {
            imageBase64: ONE_BY_ONE_PNG_B64,
            mimeType: "image/png",
          };
        }),
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as {
      created: number;
      output_format: string;
      data: Array<{ b64_json: string; revised_prompt?: string }>;
    };
    expect(typeof json.created).toBe("number");
    expect(json.output_format).toBe("png");
    expect(json.data).toHaveLength(1);
    expect(json.data[0]?.b64_json).toBe(ONE_BY_ONE_PNG_B64);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.modelId).toBe("gemini/4-hydrogen");
    expect(capturedRequests[0]?.reasoning).toBe("high");
    expect(capturedRequests[0]?.aspectRatio).toBe("16:9");
  });

  test("chặn provider không phải Gemini (ai-studio / m365-copilot / chatgpt) bằng lỗi 400", async () => {
    const responsesService = new ResponsesService(undefined, undefined, () => "m365-copilot");
    const service = new ImagesService(responsesService, undefined, undefined, () => "m365-copilot");

    const parsed = service.validateGenerationJson({
      model: "gpt-image-2",
      prompt: "A cat icon",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const req = new Request("http://127.0.0.1/v1/images/generations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread-m365",
          model: "m365-copilot",
        }),
      },
    });

    const resp = await service.executeImageTurn({
      req,
      parsed: parsed.parsed,
      adapterFactory: () =>
        makeMockAdapter(async () => ({
          imageBase64: ONE_BY_ONE_PNG_B64,
          mimeType: "image/png",
        })),
    });

    expect(resp.status).toBe(400);
    const errJson = (await resp.json()) as { error: { message: string } };
    expect(errJson.error.message).toContain("Gemini Web");
    expect(errJson.error.message).toContain("m365-copilot");
  });

  test("fail-fast 400 cho GIF và transparent_background / background='transparent'", () => {
    const responsesService = new ResponsesService(undefined, undefined, () => "gemini/4-hydrogen");
    const service = new ImagesService(responsesService);

    const gifRes = service.validateGenerationJson({
      prompt: "dancing cat",
      gif: { frame_count: 8, frame_duration_ms: 200 },
    });
    expect(gifRes.ok).toBe(false);
    if (!gifRes.ok) {
      expect(gifRes.message).toContain("GIF");
    }

    const gifFmtRes = service.validateGenerationJson({
      prompt: "dancing cat",
      output_format: "gif",
    });
    expect(gifFmtRes.ok).toBe(false);

    const transparentRes = service.validateGenerationJson({
      prompt: "logo cutout",
      background: "transparent",
    });
    expect(transparentRes.ok).toBe(false);
    if (!transparentRes.ok) {
      expect(transparentRes.message).toContain("transparent");
    }

    const transparentFlagRes = service.validateGenerationJson({
      prompt: "logo cutout",
      transparent_background: true,
    });
    expect(transparentFlagRes.ok).toBe(false);
  });

  test("POST /v1/images/edits hỗ trợ cả JSON images[{image_url}] của Codex lẫn multipart/form-data", async () => {
    const responsesService = new ResponsesService(undefined, undefined, () => "gemini/4-hydrogen");
    const service = new ImagesService(responsesService, undefined, undefined, () => "gemini/4-hydrogen");

    const jsonEdit = service.validateEditJson({
      model: "gpt-image-2",
      prompt: "Make the sky sunset orange",
      images: [{ image_url: `data:image/png;base64,${ONE_BY_ONE_PNG_B64}` }],
    });
    expect(jsonEdit.ok).toBe(true);
    if (jsonEdit.ok) {
      expect(jsonEdit.parsed.images).toHaveLength(1);
      expect(jsonEdit.parsed.images?.[0]?.mimeType).toBe("image/png");
      expect(jsonEdit.parsed.images?.[0]?.buffer.length).toBeGreaterThan(0);
    }

    const form = new FormData();
    form.set("prompt", "Make it watercolor");
    form.set(
      "image",
      new Blob([Buffer.from(ONE_BY_ONE_PNG_B64, "base64")], { type: "image/png" }),
      "input.png",
    );
    const formEdit = await service.parseEditFormData(form);
    expect(formEdit.ok).toBe(true);
    if (formEdit.ok) {
      expect(formEdit.parsed.images).toHaveLength(1);
      expect(formEdit.parsed.images?.[0]?.name).toBe("input.png");
    }
  });

  test("trả 422 khi GeminiImageRefusalError xảy ra", async () => {
    const responsesService = new ResponsesService(undefined, undefined, () => "gemini/4-hydrogen");
    const service = new ImagesService(responsesService, undefined, undefined, () => "gemini/4-hydrogen");
    const parsed = service.validateGenerationJson({ prompt: "unsafe test" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const req = new Request("http://127.0.0.1/v1/images/generations", {
      method: "POST",
      headers: {
        "x-codex-turn-metadata": JSON.stringify({ model: "gemini/4-hydrogen" }),
      },
    });
    const resp = await service.executeImageTurn({
      req,
      parsed: parsed.parsed,
      adapterFactory: () =>
        makeMockAdapter(async () => {
          throw new GeminiImageRefusalError("Gemini Web không trả về hình ảnh: I cannot generate that.");
        }),
    });
    expect(resp.status).toBe(422);
    const json = (await resp.json()) as { error: { message: string } };
    expect(json.error.message).toContain("I cannot generate that");
  });

  test("Server HTTP end-to-end định tuyến /v1/images/generations và /v1/images/edits", async () => {
    const captured: ImageTurnRequest[] = [];
    const server = startServer(
      { ...defaultConfig(), port: 0 },
      {
        adapterFactory: () =>
          makeMockAdapter(async (req) => {
            captured.push(req);
            return {
              imageBase64: ONE_BY_ONE_PNG_B64,
              mimeType: "image/png",
            };
          }),
      },
    );

    try {
      const base = `http://127.0.0.1:${server.port}`;
      const genResp = await fetch(`${base}/v1/images/generations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-turn-metadata": JSON.stringify({
            model: "gemini/4-neon",
            reasoning_effort: "medium",
          }),
        },
        body: JSON.stringify({
          model: "gpt-image-2",
          prompt: "A minimal ceramic mug, 16:9",
          background: "opaque",
          size: "auto",
        }),
      });
      expect(genResp.status).toBe(200);
      const genJson = (await genResp.json()) as { data: Array<{ b64_json: string }> };
      expect(genJson.data[0]?.b64_json).toBe(ONE_BY_ONE_PNG_B64);

      const editResp = await fetch(`${base}/v1/images/edits`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-turn-metadata": JSON.stringify({
            model: "gemini/4-hydrogen",
            reasoning_effort: "high",
          }),
        },
        body: JSON.stringify({
          model: "gpt-image-2",
          prompt: "Change background to sunset",
          images: [{ image_url: `data:image/png;base64,${ONE_BY_ONE_PNG_B64}` }],
        }),
      });
      expect(editResp.status).toBe(200);
      expect(captured).toHaveLength(2);
      expect(captured[0]?.aspectRatio).toBe("16:9");
      expect(captured[0]?.modelId).toBe("gemini/4-neon");
      expect(captured[1]?.images).toHaveLength(1);
    } finally {
      await server.stop(true);
    }
  });

  test("chuỗi tạo ảnh -> sửa ảnh trong cùng threadId dùng chung 1 Gemini image conversationId", async () => {
    const captured: ImageTurnRequest[] = [];
    const responsesService = new ResponsesService(undefined, undefined, () => "gemini/4-hydrogen");
    const service = new ImagesService(responsesService, undefined, undefined, () => "gemini/4-hydrogen");
    const adapterFactory = () =>
      makeMockAdapter(async (req) => {
        captured.push(req);
        return {
          imageBase64: ONE_BY_ONE_PNG_B64,
          mimeType: "image/png",
          conversationId: req.existingConversationId || "gem_img_conv_001",
        };
      });

    const genParsed = service.validateGenerationJson({
      model: "gpt-image-2",
      prompt: "Coffee cup",
    });
    expect(genParsed.ok).toBe(true);
    if (!genParsed.ok) return;

    const r1 = await service.executeImageTurn({
      req: new Request("http://127.0.0.1/v1/images/generations", {
        method: "POST",
        headers: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "thread-same-1",
            model: "gemini/4-hydrogen",
          }),
        },
      }),
      parsed: genParsed.parsed,
      adapterFactory,
    });
    expect(r1.status).toBe(200);

    const editParsed = service.validateEditJson({
      model: "gpt-image-2",
      prompt: "Change table to dark stone",
      images: [{ image_url: `data:image/png;base64,${ONE_BY_ONE_PNG_B64}` }],
    });
    expect(editParsed.ok).toBe(true);
    if (!editParsed.ok) return;

    const r2 = await service.executeImageTurn({
      req: new Request("http://127.0.0.1/v1/images/edits", {
        method: "POST",
        headers: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "thread-same-1",
            model: "gemini/4-hydrogen",
          }),
        },
      }),
      parsed: editParsed.parsed,
      adapterFactory,
    });
    expect(r2.status).toBe(200);

    expect(captured).toHaveLength(2);
    expect(captured[0]?.existingConversationId).toBeUndefined();
    expect(captured[0]?.conversationKey).toBe("image:thread-same-1");
    expect(captured[1]?.existingConversationId).toBe("gem_img_conv_001");
    expect(captured[1]?.conversationKey).toBe("image:thread-same-1");
  });

  test("docs/swagger.html có tài liệu OpenAPI cho /v1/images/generations và /v1/images/edits", () => {
    const swaggerHtml = readFileSync(join(process.cwd(), "docs", "swagger.html"), "utf8");
    expect(swaggerHtml).toContain('"/v1/images/generations"');
    expect(swaggerHtml).toContain('"/v1/images/edits"');
    expect(swaggerHtml).toContain('"Gemini Images"');
  });
});
