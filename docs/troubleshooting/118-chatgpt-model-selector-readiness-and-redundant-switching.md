# 118 — ChatGPT Model Selector Readiness & Chống Chuyển Model Thừa (BUG-02)

- **Trạng thái:** ⏳ Chờ User Test & Confirm
- **Providers / Phạm vi:** `chatgpt`, `web`, `playwright`
- **Keywords:** `ChatGptCapabilityPicker`, `ChatGptBrowserWorker`, `waitForSelectorReady`, `alreadyChecked`, `aria-disabled`, `data-selected-reasoning-effort`

## ⚡ TL;DR
1. **Triệu chứng:** Trên ChatGPT Web, ngay sau khi composer hiện ra, nút Model Switcher (`modelPickerTrigger`) có thể chưa render xong hoặc đang `disabled`/`aria-disabled="true"` khiến `ensureCapabilityDetailed` fail-closed sớm; đồng thời khi model đích đã có `aria-checked="true"` trong danh sách radio (hoặc thiếu `data-selected-reasoning-effort`), picker vẫn click lại radio và mở/đóng menu thừa.
2. **Nguyên nhân gốc rễ:** `ChatGptCapabilityPicker.ensureCapabilityDetailed` kiểm tra `trigger.isVisible()` tức thì không chờ selector sẵn sàng/thoát `disabled`, không bỏ qua `targetRadio.click()` khi `alreadyChecked === true`, và cache `appliedByPage` bỏ lỡ trường hợp model không có thuộc tính `data-selected-reasoning-effort`.
3. **Cách sửa:**
   - Thêm `waitForSelectorReady` trong [capability-picker.ts](../../src/adapters/chatgpt/capability-picker.ts) (hỗ trợ `readyTimeoutMs` và `AbortSignal` truyền từ `prepareProvider` tại [chatgpt-browser-worker.ts](../../src/adapters/chatgpt/chatgpt-browser-worker.ts)) để chờ `modelPickerTrigger` hiển thị và hết `disabled`/`aria-disabled`, hoặc nhận diện `thinkToggleButton` trên tài khoản Free.
   - Bỏ qua `targetRadio.click()` khi `alreadyChecked === true` (chỉ quay lại simple view nếu thực sự cần chỉnh slider effort) và lưu cờ `hasEffortAttr` trong `appliedByPage`.
   - Bổ sung regression test cho selector `disabled` và chống click lặp lại trong [chatgpt-browser-worker.test.ts](../../tests/chatgpt-browser-worker.test.ts).
