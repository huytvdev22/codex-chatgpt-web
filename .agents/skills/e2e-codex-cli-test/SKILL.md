---
name: e2e-codex-cli-test
description: >-
  Runbook để agent tự khởi động Codex M365 Copilot (kèm Turn Trace) và chạy
  kiểm thử E2E thực tế bằng Codex CLI (`codex exec`). Dùng khi cần test ứng
  dụng end-to-end, kiểm tra luồng tool calling, chuyển adapter hoặc debug
  prompt/response trên trình duyệt thay cho user thao tác tay.
---

# Kiểm thử E2E ứng dụng bằng Codex CLI

Dùng quy trình này để tự kiểm thử toàn bộ luồng từ Codex CLI → Local Responses API Server (`127.0.0.1:17841`) → Electron Launcher Browser Host → Web AI (M365 Copilot / Google AI Studio).

## 1. Kiểm tra điều kiện tiên quyết

1. Đảm bảo đã có `codex` CLI:
   ```sh
   which codex && codex --version
   ```
   (Trên macOS nếu chưa có, cài qua `brew install --cask codex`).
2. Đảm bảo `~/.codex/config.toml` đang trỏ về bridge:
   - `openai_base_url = "http://127.0.0.1:17841/v1"`
   - Nếu chưa trỏ hoặc chưa cài route, chạy `bun run src/cli.ts setup` (thêm `--replace-codex-route` nếu đang dùng route khác).

## 2. Khởi động ứng dụng (có bật Turn Trace)

Kiểm tra server đã chạy hay chưa:
```sh
curl -sf http://127.0.0.1:17841/healthz
```

- **Nếu chưa chạy**, hoặc **cần thu Turn Trace mới** (lưu ý: nếu Launcher đang chạy từ trước mà chưa bật env `CODEX_WEB_TURN_TRACE=1`, phải dừng instance Launcher cũ trước rồi mới chạy lại):
  ```sh
  CODEX_WEB_TURN_TRACE=1 npm run launcher:start
  ```
  *(Hoặc `CODEX_WEB_TURN_TRACE=1 bun run launcher` ở chế độ dev; chạy nền rồi chờ `curl -sf http://127.0.0.1:17841/healthz` trả `status: "ok"`).*
- Đảm bảo cửa sổ Electron Launcher đã mở và phiên đăng nhập M365 Copilot / Google AI Studio đang hoạt động.
- **Lưu ý về `doctor`:** Khi chạy `bun run doctor -- --json` từ shell bên ngoài Launcher, mục `browser-host` có thể báo lỗi giả do không có descriptor/token nội bộ của Launcher. Luôn xác minh thực tế bằng `GET /healthz`, `GET /v1/models` và chạy `codex exec`.

## 3. Bộ test E2E chuẩn với Codex CLI

Chạy với `--sandbox read-only` cho các bài test không cần ghi file:

1. **Smoke test M365 Copilot (model mặc định):**
   ```sh
   codex exec --sandbox read-only "Reply with exact word: PONG"
   ```
   - Kỳ vọng: exit code `0`, output có `PONG`.

2. **Test Tool Calling & Multi-turn (`exec`):**
   ```sh
   codex exec --sandbox read-only "Use a tool to read package.json and reply only with the exact value of the version field."
   ```
   - Kỳ vọng: Codex CLI thực thi tool đọc `package.json`, gửi kết quả về bridge và model trả về đúng version trong `package.json`.

3. **Test chuyển adapter Google AI Studio:**
   ```sh
   codex exec --sandbox read-only -m ai-studio/gemini-4-hydrogen "Reply with exact word: PONG"
   ```
   - Kỳ vọng: exit code `0`, output có `PONG`.

4. **Test adapter ChatGPT Web (`chatgpt/gpt-6.2`, `chatgpt/gpt-6`, `chatgpt/gpt-5.6-sol`) & Reasoning Effort:**
   ```sh
   codex exec --sandbox read-only -m chatgpt/gpt-6.2 "Reply with exact word: PONG"
   codex exec --sandbox read-only -m chatgpt/gpt-6 -c model_reasoning_effort="low" "Reply with exact word: PONG"
   ```
   - Kỳ vọng: exit code `0`, output có `PONG`, tự chọn đúng model & mức Thinking effort trên popover `Select ChatGPT model`, và Turn 2 giữ đúng URL `/c/<uuid>`.

5. **Test ghi/sửa file (chỉ chạy khi cần kiểm chứng `apply_patch` / edit):**
   - Dùng `--sandbox workspace-write` trên một file tạm trong `/tmp` hoặc xóa/revert sạch file test ngay sau khi hoàn tất.

> **Lưu ý log bình thường của Codex CLI (`v0.171.0`):**
> - Dòng `ERROR codex_api::endpoint::responses_websocket: failed to connect to Responses WebSocket` là bình thường vì bridge trả HTTP `426` cho WebSocket để Codex CLI tự fallback sang HTTP SSE.
> - Cảnh báo `warning: [features].multi_agent is deprecated...` đến từ cấu hình Compatibility V1 hiện tại và không ảnh hưởng tới kết quả chạy.

## 4. Kiểm tra Turn Trace khi debug hoặc test lỗi

Khi chạy với `CODEX_WEB_TURN_TRACE=1`, mỗi turn được ghi thành 1 file JSON riêng tại:
`~/.codex-m365-copilot/diagnostics/turn-traces/<sessionKey>/`

Tìm và kiểm tra file trace mới nhất:
```sh
ls -lt ~/.codex-m365-copilot/diagnostics/turn-traces/*/*.json | head -n 5
```
Các trường cần kiểm tra trong trace JSON:
- `meta.finalStatus`, `meta.error`, `meta.durationMs`
- `cookedPromptsByAttempt[].prompt` (prompt đã biên dịch gửi lên Web)
- `cookedPromptsByAttempt[].rawWebResponse` & `parsedProtocolResult` (raw text trình duyệt trả về và kết quả parse)

## 5. Dọn dẹp sau khi test

- Xóa mọi file test tạm đã tạo trong workspace (nếu có).
- Xóa dữ liệu trace sau khi debug xong nếu chứa mã nguồn/hội thoại nhạy cảm:
  ```sh
  rm -rf ~/.codex-m365-copilot/diagnostics/turn-traces
  ```
