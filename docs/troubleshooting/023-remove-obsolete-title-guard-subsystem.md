# 023 - Xóa bỏ hoàn toàn Title Guard Subsystem không còn sử dụng

## ⚡ TL;DR
- **Triệu chứng:** Hệ thống vẫn giữ module `guards/title-guard.ts`, shim `title-guard.ts` và nhánh kiểm tra `isTitleRequest` / `M365_ENABLE_TITLE_GUARD` trong `M365CopilotAdapter.runTurn` dù mặc định đã tắt hoàn toàn.
- **Nguyên nhân gốc rễ:** Luồng phản hồi hiện tại chỉ tập trung đọc và phân tích Markdown qua strict response parser nên cơ chế đánh chặn sinh tiêu đề ngầm (`Title Guard`) không còn cần thiết và làm phức tạp hóa kiến trúc chung của Web Adapter.
- **Cách sửa:** Xóa bỏ toàn bộ `src/adapters/m365-copilot/guards/`, `src/adapters/m365-copilot/title-guard.ts`, nhánh kiểm tra trong `M365CopilotAdapter.runTurn` và cập nhật bộ test kiến trúc.

## Trạng thái

✅ Đã Confirm

## Phạm vi thay đổi (Atomic Slice #2)

- **Đã xóa:**
  - `src/adapters/m365-copilot/guards/title-guard.ts`
  - `src/adapters/m365-copilot/guards/index.ts`
  - `src/adapters/m365-copilot/title-guard.ts`
  - `tests/m365-title-guard.test.ts`
- **Đã cập nhật:**
  - `src/adapters/m365-copilot/index.ts`: Gỡ bỏ import/export `./guards`, tùy chọn `enableTitleGuard` và nhánh chặn `isTitleRequest`.
  - `tests/m365-architecture-integrity.test.ts`: Gỡ bỏ kiểm tra export `isTitleRequest` và `generateTitleResponse`.

## Xác minh

- `git diff --check`: Pass.
- `bun run check:architecture`: Pass (23 modules M365, 0 circular dependencies, 0 reverse imports).
- `bun test tests/m365-*.test.ts`: 215 pass, 0 fail trên 23 files còn lại.
- Bộ test Web Adapters (7 files): 59 pass, 0 fail.
- `bun run build`: Pass.
- `bun run typecheck`: 0 lỗi trong `src/`, giữ nguyên baseline 288 lỗi legacy trên 35 files.

