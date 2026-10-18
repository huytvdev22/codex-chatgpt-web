# Lỗi 004: Release verify gate thất bại do check-version và test suite cũ

## ⚡ TL;DR
- **Triệu chứng**: Chạy `bun run verify` hoặc phát hành tag release bị dừng lỗi `ENOENT: mcp-server.ts` và hàng loạt test cũ import module đã xóa không thể pass.
- **Nguyên nhân gốc rễ**: Sau khi tái cấu trúc Unified Web Adapter loại bỏ mã nguồn cũ của ChatGPT Web (commit `f1e00a8`), các script `check-version.ts` và `verify.ts` vẫn tham chiếu file cũ `src/adapters/chatgpt-web/mcp-server.ts` cùng toàn bộ suite test cũ.
- **Cách sửa**: 
  1. Cập nhật `scripts/check-version.ts` trỏ tới `src/server.ts`.
  2. Cập nhật `scripts/verify.ts` chạy bộ kiểm thử kiến trúc (`check:architecture`) và các bài test adapter hiện đại (M365, ChatGPT, Gemini, Qwen).
  3. Khắc phục các lỗi type rải rác trong `src/` (`model-catalog.ts`, `qwen-web/index.ts`, `dev-chat/driver.ts`).

---

## Chi Tiết Kỹ Thuật

- **File cập nhật**:
  - `scripts/check-version.ts`: Đổi `mcp-server.ts` sang `server.ts`.
  - `scripts/verify.ts`: Tích hợp các suite test mới (`tests/*-adapter.test.ts`, `tests/*-conversation-store.test.ts`).
  - `src/model-catalog.ts`: Thêm import `isChatGptWebModelSlug` và `hasChatGptDefault`.
  - `src/adapters/qwen-web/index.ts`: Import `QWEN_SELECTORS`.
- **Trạng thái**: ⏳ Chờ User Test & Confirm
