# 041: Tinh gọn ChatGPT Web Adapter về cấu trúc 5 file provider/runtime

## ⚡ TL;DR
- **Triệu chứng:** `src/adapters/chatgpt-web/` còn 13 file, gồm nhiều compatibility shim và API legacy đã không còn tham gia runtime.
- **Nguyên nhân gốc rễ:** Các file chuyển tiếp được giữ lại sau khi `ChatGptWebAdapter` chuyển sang `WebProviderAdapter`, trong khi test cũ vẫn tham chiếu kiến trúc ChatGPT trước Unified Web Adapter.
- **Cách sửa:** Chỉ giữ 5 file cần thiết, chuyển logic Think vào browser worker, chuyển validator conversation về conversation store và khóa cấu trúc bằng architecture gate.

## Trạng thái
✅ Đã Confirm

## Cấu trúc sau tinh gọn

```text
src/adapters/chatgpt-web/
├── browser-helper-main.ts
├── chatgpt-browser-worker.ts
├── conversation-store.ts
├── index.ts
└── selectors.ts
```

`browser-helper-main.ts` được giữ lại vì là entrypoint bắt buộc của:

- `scripts/build-runtime-bundle.ts`
- `scripts/build-browser-helper.ts`

ChatGPT giữ thêm đúng một runtime entrypoint (`browser-helper-main.ts`) phục vụ Launcher helper.

## File đã loại bỏ

- `browser-worker.ts`
- `capability-picker.ts`
- `environment.ts`
- `input-tokens.ts`
- `markdown.ts`
- `mcp-main.ts`
- `turn-broker.ts`
- `usage.ts`

## Điều chỉnh kiến trúc

- Xóa hoàn toàn logic tự chọn Think khỏi `ChatGptBrowserWorker`; Launcher là tầng duy nhất sở hữu việc chọn model và Think mode.
- `isValidChatGptConversationId()` được chuyển về `conversation-store.ts` để loại bỏ cycle:
  - trước: `chatgpt-browser-worker.ts -> conversation-store.ts -> chatgpt-browser-worker.ts`
  - sau: `chatgpt-browser-worker.ts -> conversation-store.ts`
- Test Markdown import trực tiếp từ `src/adapters/web/markdown.ts`.
- Smoke interrupt chuyển sang `extractCodexTurnIdentityFromBody()` tại tầng shared.
- Architecture gate khóa chính xác danh sách 5 file và yêu cầu `0 cycles`.

## Selector và response tracking

Dữ liệu thực tế từ Chrome DevTools xác nhận:

- Composer chính xác:
  - `div.ProseMirror[data-composer-markdown][role="textbox"]`
- Assistant Markdown root chính xác:
  - `[data-markdown-text-style="assistant-message"]`
- Code block chính xác:
  - `div[data-code-block="true"]`
- Copy code chính xác:
  - `button[aria-label="Copy code"]`
- Mỗi assistant response có wrapper:
  - `div[data-chatgpt-selection-message-id]`

Các fallback class sinh từ build, selector article và selector rộng đã được loại bỏ.

Response tracking không còn dựa trên số node assistant. Worker lưu tập
`data-chatgpt-selection-message-id` trước khi submit và chỉ đọc message có ID
mới. Completion detection và copy-salvage đi từ Markdown root lên wrapper của
response để tìm nút Copy.

## Timeout và Launcher lifecycle

- Hard deadline: `15 phút`.
- Idle deadline: `2 phút` không có thay đổi text hoặc trạng thái generation.
- Heartbeat tới Launcher: mỗi `10 giây`.
- Abort, idle timeout và hard timeout đều chủ động click Stop trước khi kết thúc
  lượt, tránh Codex báo lỗi trong khi ChatGPT Web vẫn tiếp tục generation.

## Kiểm chứng

- ChatGPT và architecture tests: `31 pass`, `0 fail`.
- ChatGPT và WebTurnEngine tests sau tối ưu selector: `49 pass`, `0 fail`.
- `bun run build`: đạt.
- `bun run check:architecture`: đạt, `0 cycles`.
- `git diff --check`: đạt.

TypeScript toàn repository vẫn còn các tham chiếu từ test và smoke legacy tới những module ChatGPT cũ vốn đã thiếu từ trước. Các test nằm trong verification manifest hiện hành không sử dụng các module legacy này.

## User test

1. Build và khởi động lại runtime/Launcher.
2. Tạo conversation ChatGPT mới.
3. Tiếp tục conversation qua ít nhất hai prompt.
4. Kiểm tra chế độ Normal và Thinking.
5. Kiểm tra tool call và tool result.
6. Kiểm tra Stop khi đang generation.
7. Xác nhận không tái diễn lỗi đọc response cũ hoặc tự dừng generation.
