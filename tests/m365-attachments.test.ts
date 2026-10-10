import { describe, expect, test, mock } from "bun:test";
import { CodexPayloadNormalizer } from "../src/adapters/m365-copilot/normalization/codex-normalizer";
import { CodexRawPayload } from "../src/adapters/m365-copilot/normalization/codex-raw-payload";
import {
  m365ImageFilePayloads,
  attachFilesViaPlusMenu,
  PLUS_MENU_SELECTORS,
} from "../src/adapters/m365-copilot/browser/attachments";
import { promptCompiler } from "../src/adapters/m365-copilot/prompts/compiler";
import { M365_IMAGE_ATTACHMENT_HINT } from "../src/adapters/m365-copilot/prompts/templates";
import type { NormalizedImageAttachment } from "../src/adapters/m365-copilot/normalization/canonical-types";

describe("M365 Copilot Image Attachments (Phương án 1)", () => {
  const samplePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQIW2Nk+M/wnwEIGMEEwAIAZAgD/74Q12UAAAAASUVORK5CYII=";
  const samplePngDataUrl = `data:image/png;base64,${samplePngBase64}`;
  const dummy1x1Png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAA=dummy";

  test("1. extractImages bóc tách chính xác input_image từ rawPayload.input và lọc ảnh dummy", () => {
    const rawPayload = CodexRawPayload.from({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "text", text: "Xem giúp tôi ảnh lỗi này:" },
            { type: "input_image", image_url: samplePngDataUrl, detail: "high" },
            { type: "input_image", image_url: dummy1x1Png }, // ảnh dummy 1x1 phải bị lọc bỏ
          ],
        },
      ],
    });

    const images = CodexPayloadNormalizer.extractImages(rawPayload);
    expect(images).toHaveLength(1);
    expect(images[0]!.name).toBe("image-1.png");
    expect(images[0]!.mimeType).toBe("image/png");
    expect(images[0]!.detail).toBe("high");
    expect(images[0]!.buffer).toBeInstanceOf(Buffer);
    expect(images[0]!.buffer.length).toBeGreaterThan(0);
  });

  test("2. extractImages bóc tách ảnh từ context.messages khi raw input rỗng", () => {
    const rawPayload = CodexRawPayload.from({
      context: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Ảnh màn hình dashboard:" },
              { type: "image", imageUrl: samplePngDataUrl },
            ],
          },
        ],
      },
    });

    const normalized = CodexPayloadNormalizer.normalize(rawPayload);
    expect(normalized.images).toBeDefined();
    expect(normalized.images).toHaveLength(1);
    expect(normalized.images![0]!.mimeType).toBe("image/png");
    expect(normalized.images![0]!.ref).toBe("m365-img-1");
  });

  test("3. m365ImageFilePayloads chuyển đổi chính xác sang cấu trúc Playwright payload", () => {
    const sampleAttachment: NormalizedImageAttachment = {
      ref: "m365-img-1",
      name: "diagram.png",
      mimeType: "image/png",
      dataUrl: samplePngDataUrl,
      buffer: Buffer.from(samplePngBase64, "base64"),
    };

    const payloads = m365ImageFilePayloads([sampleAttachment]);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.name).toBe("diagram.png");
    expect(payloads[0]!.mimeType).toBe("image/png");
    expect(payloads[0]!.buffer.length).toBe(sampleAttachment.buffer.length);
  });

  test("4. promptCompiler đính kèm M365_IMAGE_ATTACHMENT_HINT khi request có ảnh", () => {
    const rawPayload = CodexRawPayload.from({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "text", text: "Kiểm tra biểu đồ này" },
            { type: "input_image", image_url: samplePngDataUrl },
          ],
        },
      ],
    });

    const normalized = CodexPayloadNormalizer.normalize(rawPayload);
    const result = promptCompiler.compile({
      normalized,
      isNewConversation: true,
    });

    expect(result.finalPrompt).toContain(M365_IMAGE_ATTACHMENT_HINT);
  });

  test("5. attachFilesViaPlusMenu tương tác chuẩn xác với PlusMenuButton và filechooser", async () => {
    let plusButtonClicked = false;
    let uploadMenuItemClicked = false;
    let filesSet: unknown = null;
    let popoverVisible = false;

    const mockFileChooser = {
      setFiles: mock(async (files: any) => {
        filesSet = files;
      }),
    };

    const mockPopover: any = {
      first: () => mockPopover,
      isVisible: mock(async () => popoverVisible),
      waitFor: mock(async () => {
        popoverVisible = true;
        return true;
      }),
      locator: mock((selector: string) => ({
        filter: mock(() => ({
          first: () => ({
            count: mock(async () => 1),
            click: mock(async () => {
              uploadMenuItemClicked = true;
            }),
          }),
        })),
        first: () => ({
          count: mock(async () => 1),
          click: mock(async () => {
            uploadMenuItemClicked = true;
          }),
        }),
      })),
    };

    const mockPlusButton: any = {
      first: () => mockPlusButton,
      count: mock(async () => 1),
      isVisible: mock(async () => true),
      click: mock(async () => {
        plusButtonClicked = true;
        popoverVisible = true;
      }),
    };

    const mockPage: any = {
      locator: mock((sel: string) => {
        if (sel === PLUS_MENU_SELECTORS.popover) return mockPopover;
        if (sel === PLUS_MENU_SELECTORS.plusButton) return mockPlusButton;
        const emptyLocator: any = {
          first: () => emptyLocator,
          count: mock(async () => 0),
        };
        return emptyLocator;
      }),
      waitForEvent: mock(async (event: string) => {
        if (event === "filechooser") return mockFileChooser;
        throw new Error(`Unexpected event ${event}`);
      }),
      keyboard: {
        press: mock(async () => {}),
      },
    };

    const testFiles = [
      { name: "test.png", mimeType: "image/png", buffer: Buffer.from("test") },
    ];

    const success = await attachFilesViaPlusMenu(mockPage, testFiles);

    expect(success).toBe(true);
    expect(plusButtonClicked).toBe(true);
    expect(uploadMenuItemClicked).toBe(true);
    expect(filesSet).toEqual(testFiles);
    expect(mockFileChooser.setFiles).toHaveBeenCalledTimes(1);
  });

  test("6. Multi-turn: extractImages CHỈ bóc tách ảnh của lượt hiện tại, không lấy lại ảnh cũ của lượt trước", () => {
    const rawPayload = CodexRawPayload.from({
      input: [
        // Turn 1
        {
          type: "message",
          role: "user",
          content: [
            { type: "text", text: "Turn 1: Phân tích ảnh này" },
            { type: "input_image", image_url: samplePngDataUrl }, // Ảnh 1 (cũ)
          ],
        },
        {
          type: "message",
          role: "assistant",
          content: "Tôi đã phân tích ảnh 1.",
        },
        // Turn 2
        {
          type: "message",
          role: "user",
          content: [
            { type: "text", text: "Turn 2: So sánh tiếp với 2 ảnh này" },
            { type: "input_image", image_url: samplePngDataUrl }, // Ảnh 2 (mới)
            { type: "input_image", image_url: samplePngDataUrl }, // Ảnh 3 (mới)
          ],
        },
      ],
    });

    const images = CodexPayloadNormalizer.extractImages(rawPayload);
    // Phải chỉ trích xuất đúng 2 ảnh của Turn 2, không được bốc lại ảnh 1 của Turn 1!
    expect(images).toHaveLength(2);
    expect(images[0]!.name).toBe("image-1.png");
    expect(images[1]!.name).toBe("image-2.png");
  });

  test("7. Multi-turn (context.messages): chỉ bóc tách ảnh sau assistant gần nhất", () => {
    const rawPayload = CodexRawPayload.from({
      context: {
        messages: [
          // Turn 1
          {
            role: "user",
            content: [
              { type: "text", text: "Turn 1" },
              { type: "image", imageUrl: samplePngDataUrl },
            ],
          },
          {
            role: "assistant",
            content: "Xong turn 1",
          },
          // Turn 2
          {
            role: "user",
            content: [
              { type: "text", text: "Turn 2" },
              { type: "image", imageUrl: samplePngDataUrl },
            ],
          },
        ],
      },
    });

    const images = CodexPayloadNormalizer.extractImages(rawPayload);
    expect(images).toHaveLength(1);
    expect(images[0]!.name).toBe("image-1.png");
  });

  test("8. Giới hạn tối đa 3 ảnh: Khi user gửi 4 ảnh trong 1 lượt, chỉ lấy tối đa 3 ảnh", () => {
    const rawPayload = CodexRawPayload.from({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "text", text: "Gửi cùng lúc 4 ảnh:" },
            { type: "input_image", image_url: samplePngDataUrl },
            { type: "input_image", image_url: samplePngDataUrl },
            { type: "input_image", image_url: samplePngDataUrl },
            { type: "input_image", image_url: samplePngDataUrl },
          ],
        },
      ],
    });

    const images = CodexPayloadNormalizer.extractImages(rawPayload);
    // M365 Copilot giới hạn tối đa 3 ảnh
    expect(images).toHaveLength(3);
  });

  test("9. attachFilesViaPlusMenu tự động cắt còn tối đa 3 file khi nhận nhiều hơn 3 file", async () => {
    let filesUploaded: any[] = [];
    const mockFileChooser = {
      setFiles: mock(async (files: any) => {
        filesUploaded = files;
      }),
    };
    const mockPopover: any = {
      first: () => mockPopover,
      isVisible: mock(async () => true),
      locator: mock(() => ({
        filter: mock(() => ({
          first: () => ({
            count: mock(async () => 1),
            click: mock(async () => {}),
          }),
        })),
      })),
    };
    const mockPage: any = {
      locator: mock((sel: string) => {
        if (sel === PLUS_MENU_SELECTORS.popover) return mockPopover;
        const empty: any = { first: () => empty, count: mock(async () => 0) };
        return empty;
      }),
      waitForEvent: mock(async () => mockFileChooser),
      keyboard: { press: mock(async () => {}) },
    };

    const fiveFiles = [
      { name: "1.png", mimeType: "image/png", buffer: Buffer.from("1") },
      { name: "2.png", mimeType: "image/png", buffer: Buffer.from("2") },
      { name: "3.png", mimeType: "image/png", buffer: Buffer.from("3") },
      { name: "4.png", mimeType: "image/png", buffer: Buffer.from("4") },
      { name: "5.png", mimeType: "image/png", buffer: Buffer.from("5") },
    ];

    const result = await attachFilesViaPlusMenu(mockPage, fiveFiles);
    expect(result).toBe(true);
    expect(filesUploaded).toHaveLength(3);
    expect(filesUploaded.map(f => f.name)).toEqual(["1.png", "2.png", "3.png"]);
  });
});
