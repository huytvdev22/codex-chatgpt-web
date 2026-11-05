# 033 — Tinh gọn `src/adapters/m365-copilot/` về đúng 7 file đặc thù Provider

**Trạng thái:** `✅ Đã Confirm`

## ⚡ TL;DR
- **Triệu chứng:** `src/adapters/m365-copilot/` vẫn còn 16 file compatibility shim và module phụ trợ (`markdown.ts`, `output-translator.ts`, `prompt.ts`, `prompts.ts`, `prompt-strategy.ts`, `session/*`, `translation/*`, `harness/*`, `browser/fast-path-stream-buffer.ts`).
- **Nguyên nhân gốc rễ:** Các file shim được giữ lại trong giai đoạn chuyển giao trung gian và các test cũ vẫn trỏ vào đường dẫn shim của M365 thay vì `src/adapters/web/`.
- **Cách sửa:** Cập nhật các file test trỏ trực tiếp về `src/adapters/web/`, xóa bỏ toàn bộ 16 file shim/phụ trợ khỏi `src/adapters/m365-copilot/` và khóa cứng CI Architecture Gate để `m365-copilot` chỉ giữ đúng 7 file đặc thù (`index.ts`, `browser/index.ts`, `browser/browser-worker.ts`, `browser/capability-picker.ts`, `browser/attachments.ts`, `browser/conversation-url.ts`, `browser/conversation-key.ts`).

## 1. Phạm vi thay đổi (Atomic Slice #12)
- **Xóa bỏ 16 file shim & phụ trợ trong `src/adapters/m365-copilot/`:**
  - `markdown.ts`, `output-translator.ts`, `prompt.ts`, `prompts.ts`, `prompt-strategy.ts`
  - `session/conversation-guard.ts`, `session/conversation-state.ts`, `session/index.ts`
  - `translation/html-to-markdown.ts`, `translation/markdown.ts`, `translation/semantic-detector.ts`, `translation/index.ts`
  - `harness/agent-loop.ts`, `harness/cognitive-evaluator.ts`, `harness/index.ts`
  - `browser/fast-path-stream-buffer.ts`
- **Cập nhật:**
  - 12 file test trong `tests/` import trực tiếp từ `src/adapters/web/`
  - `tests/m365-architecture-integrity.test.ts`: Khóa cứng danh sách 7 file của `src/adapters/m365-copilot/`.

## 2. Kết quả kiểm chứng
- `git diff --check`: Pass
- `bun run check:architecture`: Pass (`0 cycles`, đúng 7 modules trong `m365-copilot`)
- `bun test tests/m365-*.test.ts tests/prompt-strategy.test.ts`: `221 pass, 0 fail`
- `bun run build`: Pass
- `src/` TypeScript errors: `0`
