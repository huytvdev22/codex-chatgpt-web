# 060 - Lỗi timeout `textarea[aria-label="Enter a prompt"]` khi mở `/generate-speech` ở chế độ Composer

> **Trạng thái:** ✅ Đã Confirm  
> **Ngày phát hiện:** 2026-11-16  
> **Phạm vi:** `src/adapters/ai-studio/ai-studio-speech-worker.ts`

## ⚡ TL;DR
1. **Triệu chứng:** Gọi `POST /v1beta/models/gemini-2.5-pro-preview-tts:streamGenerateContent` lỗi `502`: `waitFor: Timeout 15000ms exceeded - waiting for locator('textarea[aria-label="Enter a prompt"]').first() to be visible`.
2. **Nguyên nhân gốc rễ:** Sau khi click preset `The Energetic Co-Host`, Google AI Studio mở ở chế độ `Composer` (không render `textarea[aria-label="Enter a prompt"]`), nhưng worker lại chờ `promptLocator` trước rồi mới click chuyển sang tab `Text`.
3. **Cách sửa:** Đảo thứ tự trong [ai-studio-speech-worker.ts](../../src/adapters/ai-studio/ai-studio-speech-worker.ts) để chờ `textModeToggle` xuất hiện sau khi chọn preset, bấm chuyển sang chế độ `Text` trước rồi mới chờ `textarea[aria-label="Enter a prompt"]`.

