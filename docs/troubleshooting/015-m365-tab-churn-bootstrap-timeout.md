# Lỗi 015: M365 đóng/mở tab liên tục gây bootstrap timeout

> **Trạng thái:** ✅ Đã Confirm (03/11/2026)
> **Providers:** `launcher`, `m365-copilot`, `electron`
> **Keywords:** `tab churn`, `Browser idle document`, `10000ms`, `prepareAllocation`, `retry`

## ⚡ TL;DR
- **Triệu chứng:** M365 ngắt stream với lỗi `Browser idle document did not commit within 10000ms`.
- **Nguyên nhân gốc rễ:** Tab `ready` bị đóng quá sớm, buộc Electron liên tục tạo renderer và tải lại M365; lần tải chậm bị hủy ngay sau timeout đầu tiên.
- **Cách sửa:** Giữ tối đa 3 tab M365 theo `conversationKey`, chỉ thu hồi tab cũ nhất khi đầy, giữ retained tab đến TTL và retry bootstrap một lần trong 30 giây.

## Thay đổi

- `launcher/electron/m365-surface-manager.cjs`
  - Không thu hồi toàn bộ tab `ready` khi mở conversation khác.
  - Tái sử dụng tab có cùng `conversationKey`.
  - Khi đạt `MAX_M365_SURFACES`, chỉ thu hồi tab `ready` tự động cũ nhất.
- `launcher/electron/browser-host.cjs`
  - `endTurn()` không đóng các retained tab khác cùng provider.
  - Tab `ready` tiếp tục được dọn theo TTL 30 phút hoặc khi cần cấp phát slot.
  - Bootstrap timeout được retry đúng một lần sau 500 ms với timeout 30 giây.
- `launcher/tests/view-lifecycle-manager.test.cjs`
  - Cập nhật regression test để xác nhận retained tab cũ được bảo toàn.

## Kiểm thử

- `node --check launcher/electron/m365-surface-manager.cjs`: pass.
- `node --check launcher/electron/browser-host.cjs`: pass.
- `bun test launcher/tests/view-lifecycle-manager.test.cjs`: 7 pass, 0 fail.

## Ghi chú

Một số test ChatGPT authentication trong toàn bộ `browser-host.test.cjs` đang thất bại do kỳ vọng URL `?temporary-chat=true` không khớp hành vi hiện tại. Các lỗi này không liên quan đến thay đổi lifecycle M365.
