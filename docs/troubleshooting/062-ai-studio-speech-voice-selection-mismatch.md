# 062 - Chọn sai/không đổi được giọng đọc (`Umbriel`, `Callirrhoe`, ...) trên AI Studio Speech UI

> **Trạng thái:** ✅ Đã Confirm  
> **Ngày phát hiện:** 2026-11-16  
> **Phạm vi:** `src/adapters/ai-studio/ai-studio-speech-worker.ts`

## ⚡ TL;DR
1. **Triệu chứng:** Dù gửi `Speaker 1: Umbriel` và `Speaker 2: Callirrhoe`, panel **Speaker settings** trên AI Studio vẫn giữ nguyên `Puck` và `Zephyr` mặc định khiến audio phát ra sai giọng.
2. **Nguyên nhân gốc rễ:** `applySpeakerDrawerSettings` so sánh `btn.textContent()` với tên voice (`"umbriel"`), nhưng DOM thật của mỗi nút giọng (`button.voice-card-content`) chứa cả mô tả tính chất (`"UmbrielEasy-goingLower middle pitch"`), nên không khớp bất kỳ giọng nào và lặng lẽ đóng drawer.
3. **Cách sửa:** Đổi sang đọc `aria-label` (bỏ hậu tố `(Current)`) hoặc `.voice-name` trên `button.voice-card-content` tại [ai-studio-speech-worker.ts](../../src/adapters/ai-studio/ai-studio-speech-worker.ts), đồng thời throw lỗi rõ ràng nếu không tìm thấy voice thay vì im lặng giữ voice cũ.

