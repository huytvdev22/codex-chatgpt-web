# 080: Định tuyến lại request sinh tiêu đề thread của Codex sang đúng provider đang dùng

> **Trạng thái:** ✅ Đã Confirm  
> **Providers:** `server`, `ai-studio`, `m365-copilot`  
> **Keywords:** `thread_title`, `codex_output_schema`, `STRUCTURED_JSON_OUTPUT`, `m365-copilot/gpt-5.6`, `ResponsesService`

## ⚡ TL;DR
1. **Triệu chứng:** Khi người dùng gửi tin nhắn đầu tiên (`"xin chào"`) trên Codex với model `ai-studio/gemini-4-hydrogen`, Launcher mở đồng thời 2 tab: 1 tab Google AI Studio và 1 tab M365 Copilot.
2. **Nguyên nhân gốc rễ:** Codex (`tui/src/app/thread_title.rs`) gửi kèm 1 request nền sinh tiêu đề (`codex_output_schema`) đòi model nội bộ `gpt-5.6-luna`; khi không thấy trong `catalog.json`, Codex fallback về model đầu tiên của catalog (`m365-copilot/gpt-5.6`) bất kể người dùng đang chọn `ai-studio`.
3. **Cách sửa:** Bổ sung `readCodexConfiguredModel()` trong [codex-integration-document.ts](../../src/codex-integration-document.ts) và logic `resolveEffectiveTurnTarget()` trong [responses-service.ts](../../src/services/responses-service.ts) để phát hiện request `codex_output_schema` sinh tiêu đề đang fallback sang model đầu tiên của catalog và tự định tuyến về model của turn chính gần nhất (hoặc model cấu hình trong `~/.codex/config.toml`).

## Thay đổi
- [src/codex-integration-document.ts](../../src/codex-integration-document.ts): Thêm `readCodexConfiguredModel()` đọc key `model` ở top-level `~/.codex/config.toml`.
- [src/services/responses-service.ts](../../src/services/responses-service.ts): Thêm `isCodexThreadTitleRequest()` và `resolveEffectiveTurnTarget()` để ghi nhớ `recentPrimaryModel` (TTL 60s) và định tuyến request `thread_title` về đúng provider đang sử dụng.
- [tests/responses-service-title-reroute.test.ts](../../tests/responses-service-title-reroute.test.ts): Bổ sung unit test cho nhận diện `codex_output_schema`, ưu tiên `recentPrimaryModel` vs `config.toml` và không ảnh hưởng request thường.
