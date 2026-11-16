# 061 - AI Studio TTS hiện thông báo lỗi `http status code: 403` nhưng API bị treo không báo lỗi

> **Trạng thái:** ✅ Đã Confirm  
> **Ngày phát hiện:** 2026-11-16  
> **Phạm vi:** `src/adapters/ai-studio/ai-studio-speech-worker.ts`

## ⚡ TL;DR
1. **Triệu chứng:** Giao diện AI Studio bật banner lỗi `Http response at 400 or 500 level, error: , http status code: 403` nhưng API Bruno treo chờ hơn 50s không trả lỗi.
2. **Nguyên nhân gốc rễ:** `ERROR_TEXT_PATTERN` và `errorBanner` trong `AiStudioSpeechWorker` chưa khớp chuỗi `Http response at 400 or 500 level` / `http status code: 403` và selector `.mdc-snackbar` / `[role="status"]`, khiến vòng polling chờ mãi tới hard timeout.
3. **Cách sửa:** Mở rộng `errorBanner` (thêm `[role="status"]`, `.mdc-snackbar`, `[class*="snackbar" i]`) và `ERROR_TEXT_PATTERN` (bắt thêm `Http response at 400 or 500 level`, `http status code:\s*(?:4\d\d|5\d\d)`, `forbidden`), dùng chung pattern trong `page.evaluate` để fail-fast trả `502` ngay khi lỗi xuất hiện.

