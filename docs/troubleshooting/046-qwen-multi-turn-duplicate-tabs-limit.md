# 046 — Qwen Web Mở Nhiều Tab Cho Cùng Cuộc Trò Chuyện Chạm Ngưỡng 5 Tab

**Trạng thái:** `⏳ Chờ User Test & Confirm`

## ⚡ TL;DR
- **Triệu chứng:** Trong cùng một cuộc trò chuyện với Qwen Web, Launcher liên tục mở thêm các tab mới trỏ về cùng một link `chat.qwen.ai/c/<uuid>`, dẫn đến lỗi HTTP 400: `ChatGPT Web already has 5 browser tabs; close one before starting another turn...`.
- **Nguyên nhân gốc rễ:** 
  1. `prepareAllocation` trong `qwen-surface-manager.cjs` có dòng `if (tabs.some(tab => tab.conversationKey === conversationKey)) return;` khiến khi có tab cũ cùng key, hàm bỏ qua toàn bộ việc thu hồi và bỏ qua kiểm tra giới hạn `MAX_QWEN_SURFACES`, sau đó Launcher tiếp tục gọi `createTurnTab` tạo thêm tab mới.
  2. Launcher không tự động thu hồi (reclaim) các tab cũ cùng `conversationKey` (hoặc các tab bị error/aborted/orphan), và không tự hòa giải (reconcile) khi có nhiều hơn 1 tab retained cho cùng một cuộc trò chuyện.
  3. Thông báo lỗi tab limit bị hardcode chữ `ChatGPT Web` thay vì hiển thị tên provider tương ứng.
- **Cách sửa:**
  1. Viết lại `prepareAllocation` trong `qwen-surface-manager.cjs`: thu hồi tab cũ cùng `conversationKey` nếu tab cũ không còn active; từ chối cấp phát nếu turn trước đang thực sự chạy; luôn duy trì tối đa `MAX_QWEN_SURFACES` (3 tab).
  2. Bổ sung cơ chế tự phục hồi (self-healing) trong `browser-host.cjs`: khi phát hiện nhiều tab retained cho cùng `conversationKey`, giữ lại tab có heartbeat mới nhất và tự động đóng các tab thừa; mở rộng `evictOldestReclaimableTurnTab` để thu hồi thêm tab lỗi (`error`/`aborted`) và tab orphan running (`processRunning(helperPid) === false`).
  3. Chuẩn hóa thông báo lỗi tab limit theo từng provider (`providerLabel`), và bổ sung fallback lấy `conversationId` từ `qwenSurfaceManager` khi endTurn.

## Chi tiết thay đổi
- `launcher/electron/qwen-surface-manager.cjs`:
  - Tích hợp `processRunning` từ `./process-tree.cjs`.
  - Loại bỏ hoàn toàn điều kiện `return` vô điều kiện khi trùng `conversationKey`.
  - Tự động đóng tab cũ cùng `conversationKey` (hoặc báo bận nếu turn đang thực sự chạy), dọn dẹp tab `error`/`aborted`, và kiểm soát chặt chẽ giới hạn 3 surfaces.
- `launcher/electron/browser-host.cjs`:
  - `beginTurn`: Hòa giải danh sách `retainedMatches` khi có nhiều hơn 1 tab, giữ tab mới nhất và đóng tab thừa.
  - `evictOldestReclaimableTurnTab`: Hỗ trợ dọn dẹp cả dead tabs (`error`/`aborted`) và orphan running tabs.
  - `createTurnTab` / `createManualTurnTab`: Hiển thị chính xác tên provider (`Qwen Web`, `Google Gemini`, `Google AI Studio`, `M365 Copilot`, `ChatGPT Web`).
  - `endTurn`: Fallback `conversationId` thông qua `this.qwenSurfaceManager?.conversationId(tab.conversationKey)`.
- `launcher/tests/qwen-surface-manager.test.cjs`: Thêm 3 test cases xác minh việc thu hồi tab cùng conversationKey, từ chối khi turn đang chạy, và dọn orphan tabs.
- `launcher/tests/browser-host.test.cjs`: Thêm 2 test cases xác minh thu hồi dead/orphan tabs và tự động hòa giải nhiều retained tabs.

## Kiểm chứng tự động
```bash
bun test launcher/tests/qwen-surface-manager.test.cjs
bun test launcher/tests/browser-host.test.cjs --test-name-pattern "reclaims error|reconciles multiple retained"
bun test tests/qwen-web-adapter.test.ts tests/qwen-conversation-store.test.ts
```
Tất cả các test đều PASS.
