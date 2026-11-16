# 063 - Treo 15s chờ `Enter a prompt` vì AI Studio không bấm được nút chuyển chế độ `Text` (`data-value="TEXT"`)

> **Trạng thái:** ✅ Đã Confirm  
> **Ngày phát hiện:** 2026-11-16  
> **Phạm vi:** `src/adapters/ai-studio/ai-studio-speech-worker.ts`

## ⚡ TL;DR
1. **Triệu chứng:** Request TTS bị timeout 15000ms tại `textarea[aria-label="Enter a prompt"]` (`502 Bad Gateway`), trong khi màn hình AI Studio vẫn đứng yên ở chế độ `Composer` với nút `Text` (`aria-checked="false"`).
2. **Nguyên nhân gốc rễ:** Selector cũ (`button.toggle-button:has-text("Text"), [role="radio"]:has-text("Text")`) thiếu thuộc tính đặc hiệu `data-value="TEXT"` và chỉ gọi `click()` một lần ngay khi rời preset nên có thể trượt hoặc bị Angular/tooltip nuốt khi chưa hydrate xong.
3. **Cách sửa:** Ưu tiên selector `button.toggle-button[data-value="TEXT"]` và tách `ensureTextMode` trong [ai-studio-speech-worker.ts](../../src/adapters/ai-studio/ai-studio-speech-worker.ts) để retry xen kẽ `click({ force })` và DOM `el.click()` cho tới khi `aria-checked="true"` hoặc `Enter a prompt` hiện ra.

