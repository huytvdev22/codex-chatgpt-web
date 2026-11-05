# 032 — Chuyển `FastPathStreamBuffer`, `M365MarkdownBuffer` và `harness` sang `src/adapters/web/`

**Trạng thái:** `✅ Đã Confirm`

## ⚡ TL;DR
- **Triệu chứng:** `src/adapters/m365-copilot/` vẫn chứa các module không phụ thuộc M365 DOM như `browser/fast-path-stream-buffer.ts`, `translation/html-to-markdown.ts`, `translation/semantic-detector.ts` và `harness/*`.
- **Nguyên nhân gốc rễ:** Các bộ đệm streaming Markdown và bộ kiểm thử agent-loop/cognitive-evaluator chưa được chuyển sang tầng dùng chung `src/adapters/web/`.
- **Cách sửa:** Chuyển `html-to-markdown.ts`, `semantic-detector.ts`, `fast-path-stream-buffer.ts` vào `src/adapters/web/protocol/` và chuyển `agent-loop.ts`, `cognitive-evaluator.ts` vào `src/adapters/web/harness/`; cập nhật `browser-worker.ts` và `m365-copilot/index.ts` dùng trực tiếp từ `src/adapters/web/`.

## 1. Phạm vi thay đổi (Atomic Slice #11)
- **Tạo mới:**
  - `src/adapters/web/protocol/html-to-markdown.ts`
  - `src/adapters/web/protocol/semantic-detector.ts`
  - `src/adapters/web/protocol/fast-path-stream-buffer.ts`
  - `src/adapters/web/harness/agent-loop.ts`
  - `src/adapters/web/harness/cognitive-evaluator.ts`
  - `src/adapters/web/harness/index.ts`
- **Cập nhật:**
  - `src/adapters/web/protocol/index.ts`, `src/adapters/web/index.ts`
  - `src/adapters/m365-copilot/browser/browser-worker.ts`, `src/adapters/m365-copilot/index.ts`

## 2. Kết quả kiểm chứng
- `git diff --check`: Pass
- `bun run check:architecture`: Pass (`0 cycles`, directionality gate pass)
- `bun test tests/m365-*.test.ts`: `215 pass, 0 fail`
- `bun run build`: Pass
- `src/` TypeScript errors: `0`
