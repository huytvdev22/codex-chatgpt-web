# [113] AI Studio `Permission denied` (HTTP 403 BotGuard) & Ổn Định P1–P3

- **Trạng thái:** `⏳ Chờ User Test & Confirm`
- **Nhánh:** `fix/aistudio-botguard-rootcause-and-p1-p3`
- **Providers / Modules:** `ai-studio`, `gemini`, `launcher`, `gateway`, `responses-state`, `verify`

## ⚡ TL;DR
- **Triệu chứng:** Google AI Studio (`aistudio.google.com/prompts/...`) hay trả `Permission denied` (`HTTP 403` `[,[7,"The caller does not have permission"]]`, ~36% Attempt 1 trong `ai-studio-worker`) khiến bridge phải F5 liên tục; ngoài ra Gemini Web kẹt `isGenerating=true` lâu, request thiếu tách `x-gateway-profile-id`, `responses-state` dùng chung ngân sách giữa Codex/Assistant, và `bun run verify` bị ảnh hưởng bởi config local + 2 test lỗi thời.
- **Nguyên nhân gốc rễ:** (1) `ai-studio-human-timing.ts` kiểm tra script `/js/th` cũ thay vì BotGuard mới `/js/bg/`, kết hợp `composer.fill()` không sinh đủ pointer/keyboard telemetry và `TurnTabManager` gọi `disableDeviceEmulation()` trên tab nền `ready` làm lệch `User-Agent`/viewport -> kích hoạt BotGuard 403; (2) `BaseWebBrowserWorker` miễn trừ `idleTimeoutMs` vô điều kiện khi `isGenerating=true`; (3) HTTP routes chưa chuyển header `x-gateway-profile-id` xuống adapter/conversation store; (4) `responses-state` dùng chung cap 64MB và `recentPrimaryModel` chưa tách theo `threadId`.
- **Cách sửa:** (1) Nhận diện BotGuard `/js/bg/` + settle delay + `mouse.move` + `keyboard.type/insertText` + giữ `deviceEmulationViewport` cho tab nền AI Studio; (2) Thêm `resolveGeneratingStallTimeoutMs` trên Gemini (`60s` không có text / `120s` khi đã có text); (3) Nối `x-gateway-profile-id` xuyên suốt `engine`, `raw-responses-service`, `assistant-responses-service`, `gemini-speech-service`, `images-service`; (4) Cô lập scope `codex` (40MB) vs `assistant` (24MB) + `persistAsync`, tách `recentPrimaryModelByThread`, cô lập `CODEX_CHATGPT_WEB_HOME` trong `scripts/verify.ts` và cập nhật 2 test P3.

## Chi tiết kiểm chứng sau sửa
- **Kiểm tra tĩnh & Unit/Integration (`bun run typecheck`, `bun run check:architecture`, `bun run verify`, `bun run launcher:test`):**
  - `typecheck`: 0 lỗi.
  - `check:architecture`: 0 circular dependency.
  - `verify`: tất cả file test trong suite độc lập pass.
  - `launcher:test`: `291 pass, 0 fail, 2 skip` (Windows-only skip trên macOS).
- **Kiểm thử E2E thực tế trên Electron Launcher mới build (`127.0.0.1:17841`):**
  - `/v2/responses` AI Studio: `4/4` turns profile `default` + `2/2` turns profile `p2` đều `HTTP 200` ở Attempt 1 (tách 2 `conversation_id` riêng theo profile).
  - `/clients/assistant/v1/responses` AI Studio: `2/2` profile `default` + `2/2` profile `p2` đạt `completed`.
  - `/v1beta/models/gemini-2.5-flash-preview-tts:generateContent`: `200`, sinh `audioB64Len = 131320`.
  - `/v2/responses` Gemini Web (`default` & `p2`): `2/2` đạt `200`.
  - `codex exec --sandbox read-only -m ai-studio/gemini-4-hydrogen`: `PONG` và tool calling `cat package.json` (`6.14.0`) thành công.
  - Rà soát `148` dòng log mới trong `launcher.jsonl`: `0` lỗi `permission denied`, `0` lần retry/reload.
