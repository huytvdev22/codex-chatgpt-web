# 065 - Job `windows-latest` treo vô hạn tại `tests/base-browser-worker.test.ts` trên GitHub Actions

> **Trạng thái:** ✅ Đã Confirm  
> **Ngày phát hiện:** 2026-11-17  
> **Phạm vi:** `tests/base-browser-worker.test.ts`, `scripts/verify.ts`

## ⚡ TL;DR
1. **Triệu chứng:** Build Release trên GitHub Actions chạy bình thường ở Linux/macOS (2–5 phút), nhưng `windows-latest` treo vô hạn ngay trong `tests/base-browser-worker.test.ts` sau test heartbeat mà `--timeout` của `bun test` không tự ngắt.
2. **Nguyên nhân gốc rễ:** Test hủy `AbortSignal` và các test deadline dùng `Bun.sleep(2)` / `Bun.sleep(timeoutMs)` với độ trễ siêu ngắn (2–8ms) chạy đua bất định dưới timer quantum ~15.6ms của Windows, gây treo event loop trong `Bun 1.4.0` trên `windows-latest`.
3. **Cách sửa:** Tách [verify.ts](../../scripts/verify.ts) chạy cô lập từng file test với watchdog OS 45s và sửa [base-browser-worker.test.ts](../../tests/base-browser-worker.test.ts) dùng `setTimeout` + kích hoạt `controller.abort()` tất định bên trong hook `onWait` thay cho `Bun.sleep(2)`.

