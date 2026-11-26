# 103: Tích hợp tạo & chỉnh sửa ảnh Gemini Web cho skill `Image Gen` của Codex

> **Trạng thái:** ⏳ Chờ User Test & Confirm  
> **Providers:** `gemini`, `server`, `web`, `codex`  
> **Keywords:** `ImagesService`, `ImagesController`, `GeminiImageWorker`, `image_gen.imagegen`, `/v1/images/generations`, `/v1/images/edits`, `Create image`, `Aspect ratio`, `canvas.toDataURL`

## ⚡ TL;DR
1. **Triệu chứng:** Skill `Image Gen` mặc định của Codex (`image_gen.imagegen`) gọi `POST /v1/images/generations` và `/v1/images/edits` (mặc định `model: "gpt-image-2"`), nhưng `codex-chatgpt-web` chưa có các endpoint ảnh và `GeminiAdapter` chưa hỗ trợ bật mode `Images`, chọn tỉ lệ khung hình và trích xuất ảnh đầu ra.
2. **Nguyên nhân gốc rễ:** Thiếu tầng REST OpenAI Images (`/v1/images/*`), thiếu context tracking để khóa phạm vi chỉ chạy khi đang chat bằng `gemini/*`, trên Gemini Web nút `Aspect ratio`/`Format` chưa mang `aria-label` lúc mới bật `Create image`, `blob:` bị revoke sau khi load, và `GeminiAttachments.attachImages` bỏ qua mở `Upload & tools` khi gặp `<input type="file">` cũ sót lại ở Turn 2+ đồng thời bấm `Escape` ngay sau `setInputFiles` làm hủy tiến trình upload.
3. **Cách sửa:** Bổ sung `ImagesController` + `ImagesService` (fail-fast `400`, giữ `imageConversationsByThread` theo `threadId` để chuỗi tạo→sửa ảnh dùng chung 1 conversation ảnh trên Gemini), xây dựng `GeminiImageWorker` (chạy tab ảnh riêng không bật Temporary Chat, trích ảnh PNG qua `<canvas>`), sửa `GeminiAttachments` luôn mở `Upload & tools` khi menu đóng và chỉ `Escape` nếu overlay còn mở (không nuốt lỗi đính kèm ảnh), và đưa `image_gen.imagegen` vào `CORE_TIER_TOOL_NAMES`.

## Lưu ý vận hành Codex
- Built-in extension `image_gen.imagegen` của Codex CLI/App chỉ được kích hoạt khi `~/.codex/auth.json` ở chế độ `auth_mode: "chatgpt"` (khi đang ở `auth_mode: "apikey"`, Codex ẩn tool này và từ chối bằng `unsupported call: image_genimagegen`).

## Thay đổi chính
- **Contracts & Context:** [src/adapters/base.ts](../../src/adapters/base.ts), [src/services/responses-service.ts](../../src/services/responses-service.ts), [src/controllers/http-turn-counter.ts](../../src/controllers/http-turn-counter.ts), [src/adapters/web/tools/web-tool-registry.ts](../../src/adapters/web/tools/web-tool-registry.ts).
- **Gemini Image Driver:** [src/adapters/gemini/selectors.ts](../../src/adapters/gemini/selectors.ts), [src/adapters/gemini/gemini-image-worker.ts](../../src/adapters/gemini/gemini-image-worker.ts), [src/adapters/gemini/index.ts](../../src/adapters/gemini/index.ts).
- **HTTP Images API:** [src/services/images-service.ts](../../src/services/images-service.ts), [src/controllers/images-controller.ts](../../src/controllers/images-controller.ts), [src/server.ts](../../src/server.ts).
- **Kiểm thử:** [tests/images-service.test.ts](../../tests/images-service.test.ts), [tests/gemini-image-worker.test.ts](../../tests/gemini-image-worker.test.ts).
