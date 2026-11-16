# 064 - Đảo `Speaker 2:` lên dòng đầu trong Transcript nhưng giọng mở đầu vẫn đọc bằng voice của `Speaker 1`

> **Trạng thái:** ✅ Đã Confirm  
> **Ngày phát hiện:** 2026-11-16  
> **Phạm vi:** `src/adapters/ai-studio/ai-studio-speech-worker.ts`

## ⚡ TL;DR
1. **Triệu chứng:** Khi giữ nguyên cấu hình `Speaker 1 = Umbriel`, `Speaker 2 = Callirrhoe` nhưng đưa dòng `Speaker 2:` lên trước `Speaker 1:` trong Transcript, audio sinh ra ở dòng đầu vẫn đọc bằng giọng của `Speaker 1`.
2. **Nguyên nhân gốc rễ:** Trên AI Studio chế độ `Text`, các card `Speaker settings` luôn giữ nguyên thứ tự mặc định `[Card 0: Speaker 1, Card 1: Speaker 2]` sau khi dán transcript; kết hợp với việc model Gemini 2.5 Pro Preview TTS thường map slot `speaker_voice_configs[0]` (Card 0) cho lượt nói mở đầu nên câu `Speaker 2:` đầu tiên bị áp giọng Card 0.
3. **Cách sửa:** Bổ sung `orderSpeakersByTranscript` và cập nhật `configureSpeakers` trong [ai-studio-speech-worker.ts](../../src/adapters/ai-studio/ai-studio-speech-worker.ts) để tự động hoán đổi alias & voice trên các card `Speaker settings` khớp đúng thứ tự xuất hiện lần đầu trong Transcript (đưa `Speaker 2` + `Callirrhoe` lên Card 0, `Speaker 1` + `Umbriel` xuống Card 1).

