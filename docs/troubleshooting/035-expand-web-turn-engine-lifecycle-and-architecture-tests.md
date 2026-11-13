# 035: Mở rộng bộ test `WebTurnEngine` (Lifecycle, Error, Conversation, Retry/Loop-Guard) và cổng kiểm tra kiến trúc Facade

## ⚡ TL;DR
- **Triệu chứng:** `tests/web-turn-engine.test.ts` ban đầu mới có 6 kịch bản happy-path cơ bản, chưa khóa đầy đủ các ma trận `runtime-lifecycle`, `error policy`, `conversation binding` và cổng chặn provider facade tự điều phối lại ở mức thấp.
- **Nguyên nhân gốc rễ:** Khi các Web provider cùng hội tụ về `WebTurnEngine` và `runtime-lifecycle.ts`, một thay đổi nhỏ trong nhánh lỗi hoặc lifecycle có thể ảnh hưởng đồng thời tới các adapter nếu thiếu unit test cô lập theo từng policy.
- **Cách sửa:** Bổ sung `WebRuntimeLifecycleOps` có thể inject cho test tại `runtime-lifecycle.ts`/`engine.ts`, cập nhật `engine.ts` để tự động chuyển `isNewConversation=false` và truyền `activeConversationId` sang các lần retry, mở rộng `tests/web-turn-engine.test.ts` lên 22 kịch bản toàn diện, và thêm cổng kiểm tra tại `tests/m365-architecture-integrity.test.ts`.

## Phạm vi thay đổi
- `src/adapters/web/runtime-lifecycle.ts` & `src/adapters/web/engine.ts`: Cho phép inject `WebRuntimeLifecycleOps` phục vụ kiểm thử đơn vị (mặc định giữ nguyên 100% hành vi production) và đảm bảo các attempt retry luôn nhận `isNewConversation: false` cùng `existingConversationId: activeConversationId`.
- `tests/web-turn-engine.test.ts`: Mở rộng từ 6 lên 22 test case bao phủ 4 ma trận:
  1. **Lifecycle Matrix:** `fail-closed` vs `fallback-local`, `manageLauncherLeaseInEngine: false`, `closeLauncherConnectionOnEnd: false`, gửi `phase=end` với `completed`/`failed`/`aborted`, và chạy `releaseWebTurnSurface` trong `finally` kể cả khi `emit` ném lỗi.
  2. **Error Policy Matrix:** `emitErrorEventOnFailure` (`true`/`false`), `rethrowError` (`true`/`false`), `errorMessagePrefix`, và abort giữa chừng khi `rethrowError: false`.
  3. **Conversation Policy Matrix:** `resolveState()` ưu tiên `leaseConversationId`, `onConversationUpdated()` lọc ID không hợp lệ, `resolveEndTurnBinding()` cho chế độ fallback khi không có ID hợp lệ.
  4. **Retry, Attachments, Loop Guard & Usage Matrix:** Chỉ trích xuất attachments ở `attempt === 0`, giữ `conversationId` mới tạo qua retry, cộng dồn `totalPromptChars`, và chặn vòng lặp công cụ (`getMaxIdenticalToolCalls` / `MAX_TOOL_ITERATIONS`).
- `tests/m365-architecture-integrity.test.ts`: Thêm CI gate cấm các file `src/adapters/<provider>/index.ts` gọi trực tiếp các hàm điều phối cấp thấp và cấm `src/adapters/web/` chứa selector DOM Scriptor đặc thù M365.

## Kết quả xác minh
- `git diff --check`: Pass.
- `bun run check:architecture`: Pass (`4 pass, 0 fail`).
- `bun test tests/web-turn-engine.test.ts`: Pass (`22 pass, 0 fail`).
- `bun run build`: Pass.

## Trạng thái
✅ Đã Confirm
