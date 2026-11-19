# 083: Tab `/generate-speech` tự phát audio sau khi tạo voice xong mà không click Pause

> **Trạng thái:** ✅ Đã Confirm  
> **Providers:** `ai-studio`, `speech`  
> **Keywords:** `generate-speech`, `AiStudioSpeechWorker`, `pauseGeneratedAudioPlayback`, `autoplay`, `pause`

## ⚡ TL;DR
1. **Triệu chứng:** Sau khi gọi TTS sinh voice thành công và giữ lại tab `/generate-speech` để tái sử dụng cho các chunk sau, trình phát trên Google AI Studio tự động phát audio thành tiếng thay vì dừng lại (`Pause`).
2. **Nguyên nhân gốc rễ:** Trước đây tab speech đóng ngay sau mỗi lượt nên autoplay bị cắt theo tab; khi chuyển sang giữ tab (`retainOnCompleted: true`), `AiStudioSpeechWorker.executeSpeech` trả WAV xong nhưng chưa click nút Pause UI hoặc dừng thẻ `<audio>` đang autoplay.
3. **Cách sửa:** Bổ sung `pauseGeneratedAudioPlayback(page)` trong [ai-studio-speech-worker.ts](../../src/adapters/ai-studio/ai-studio-speech-worker.ts) chạy ngay sau `waitForGeneratedAudio()`: ưu tiên bấm nút Pause UI đang hiển thị (chỉ khớp trạng thái Pause, tránh bấm nhầm toggle `Play`), rơi xuống `audio.pause()` trong DOM khi nút UI không có, và cài guard 2s chống autoplay khởi động trễ (tự hủy khi user thao tác).

## Thay đổi
- [src/adapters/ai-studio/ai-studio-speech-worker.ts](../../src/adapters/ai-studio/ai-studio-speech-worker.ts): Thêm selector `pauseAudioButton` và phương thức `pauseGeneratedAudioPlayback(page)` gọi ngay sau khi trích xuất audio thành công.
- [tests/gemini-speech.test.ts](../../tests/gemini-speech.test.ts): Bổ sung test xác minh tự động click nút Pause UI và fallback dừng DOM `<audio>` khi nút Pause không xuất hiện.
