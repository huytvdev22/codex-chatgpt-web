# 024 - Bóc tách hạ tầng Conversation Key & Generic Conversation Store sang `src/adapters/web/conversation`

## ⚡ TL;DR
- **Triệu chứng:** Logic băm khóa hội thoại (`conversationKey`) và lưu trữ ánh xạ hội thoại ra file JSON bị lặp lại giữa M365, ChatGPT, Qwen và Google AI Studio.
- **Nguyên nhân gốc rễ:** Chưa có lớp hạ tầng `conversation/` dùng chung trong `src/adapters/web/` tách biệt giữa cơ chế lưu trữ/hash với bộ validator và schema riêng của từng provider.
- **Cách sửa:** Tạo `buildWebConversationKey` và `GenericConversationStore` tại `src/adapters/web/conversation/`, đồng thời chuyển `m365ConversationKey` sang ủy quyền qua helper chung mà không đổi kết quả hash.

## Trạng thái

⏳ Chờ User Test & Confirm

## Phạm vi thay đổi (Atomic Slice #3)

- **Canonical modules mới:**
  - `src/adapters/web/conversation/conversation-key.ts`
  - `src/adapters/web/conversation/conversation-store.ts`
  - `src/adapters/web/conversation/index.ts`
  - Export qua `src/adapters/web/index.ts`
- **Cập nhật M365:**
  - `src/adapters/m365-copilot/browser/conversation-key.ts`: Gọi `buildWebConversationKey` với `includeReasoning: true` (giữ nguyên 100% chuỗi hash SHA-256).

## Xác minh

- `git diff --check`: Pass.
- `bun run check:architecture`: Pass (0 circular dependencies, 0 reverse imports).
- `bun test tests/m365-*.test.ts`: 215 pass, 0 fail.
- Bộ test Web Adapters (7 files): 59 pass, 0 fail.
- `bun run build`: Pass.
- `bun run typecheck`: 0 lỗi trong `src/`.
