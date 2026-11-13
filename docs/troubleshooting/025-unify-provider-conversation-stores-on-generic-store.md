# 025 - Chuyển Conversation Store của ChatGPT sang dùng `GenericConversationStore`

## ⚡ TL;DR
- **Triệu chứng:** `ChatGptConversationStore` tự lặp lại ~100 dòng code đọc/ghi JSON file và tạo khóa SHA-256.
- **Nguyên nhân gốc rễ:** Các adapter chưa tái sử dụng hạ tầng `GenericConversationStore` và `buildWebConversationKey` trong `src/adapters/web/conversation/`.
- **Cách sửa:** Chuyển store sang ủy quyền lưu trữ cho `GenericConversationStore` và tạo khóa qua `buildWebConversationKey`, đồng thời giữ nguyên 100% validator, URL helper, schema JSON và public API của provider.

## Trạng thái

✅ Đã Confirm

## Phạm vi thay đổi (Atomic Slice #4)

- `src/adapters/chatgpt-web/conversation-store.ts`

## Xác minh

- `git diff --check`: Pass.
- `bun run check:architecture`: Pass (0 circular dependencies, 0 reverse imports).
- `bun test tests/m365-*.test.ts`: 215 pass, 0 fail.
- Bộ test Web Adapters (7 files): 59 pass, 0 fail.
- `bun run build`: Pass.
- `bun run typecheck`: 0 lỗi trong `src/`.
