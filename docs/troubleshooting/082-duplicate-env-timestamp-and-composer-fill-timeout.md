# 082: Lặp 2 dòng `Thời gian:` qua nửa đêm và treo `composer.fill: Timeout 30000ms exceeded` ở AI Studio

> **Trạng thái:** ✅ Đã Confirm  
> **Providers:** `web`, `ai-studio`  
> **Keywords:** `environmentContext`, `Thời gian`, `codex-normalizer`, `insertPrompt`, `fill Timeout 30000ms`, `DOM setter fallback`

## ⚡ TL;DR
1. **Triệu chứng:** (a) Prompt gửi sang AI bị lặp 2 dòng `- Thời gian: 2026-11-19 ...` và `- Thời gian: 2026-11-20 ...` khi phiên chat đi qua `00:00`; (b) Các lượt trả `tool_result` dài (~95KB) hoặc khi AI Studio hiện card `Enable URL Context` bị treo 30s rồi fail `fill: Timeout 30000ms exceeded` khiến Codex `Reconnecting 1/5..5/5`.
2. **Nguyên nhân gốc rễ:** (a) `CodexPayloadNormalizer` nối cộng dồn chuỗi mọi thẻ `<environment_context>` cũ + mới trong `input[]` khiến 2 block khác ngày cùng lọt vào prompt; (b) `AiStudioBrowserWorker.insertPrompt` gọi `composer.fill(promptText)` không đặt `force: true` / `timeout` và không bọc `try/catch`, nên khi actionability check kẹt hoặc fill chuỗi lớn 30s timeout, code ném thẳng lỗi chứa cả 95KB prompt mà không bao giờ chạy xuống fallback DOM setter bên dưới.
3. **Cách sửa:** (a) Trong [codex-normalizer.ts](../../src/adapters/web/normalization/codex-normalizer.ts), tách `extractEnvironmentFields` + `formatEnvironmentFields` để hợp nhất theo field và chỉ render duy nhất một `<environment_context>` mới nhất; (b) Trong [ai-studio-browser-worker.ts](../../src/adapters/ai-studio/ai-studio-browser-worker.ts), tự đóng card `.urlcontext-nudge` (`button[mattooltip="Dismiss"]`) trước khi thao tác composer, đồng thời dùng `composer.fill(promptText, { force: true, timeout })` (`4_000ms` với prompt > 8KB, `8_000ms` với prompt ngắn) bọc `.catch(() => {})` để rơi tức thì xuống fallback DOM setter và kiểm chứng lại `inputValue()`.

## Thay đổi
- [src/adapters/web/normalization/codex-normalizer.ts](../../src/adapters/web/normalization/codex-normalizer.ts): Hợp nhất field môi trường mới nhất (`latestEnvFields`) thay vì cộng dồn nhiều `<environment_context>`.
- [src/adapters/ai-studio/ai-studio-browser-worker.ts](../../src/adapters/ai-studio/ai-studio-browser-worker.ts): Bổ sung `dismissObstructingNudges()` đóng card `.urlcontext-nudge` (`button[mattooltip="Dismiss"]`), `{ force: true, timeout }` + `.catch(() => {})` cho `composer.fill()` và kiểm chứng giá trị sau fallback DOM setter trong `insertPrompt()`.
- [tests/codex-payload-normalizer.test.ts](../../tests/codex-payload-normalizer.test.ts) & [tests/ai-studio-adapter.test.ts](../../tests/ai-studio-adapter.test.ts): Bổ sung unit test cho hợp nhất `<environment_context>` qua ngày, tự dismiss card `.urlcontext-nudge`, và fallback DOM setter khi `composer.fill` lỗi/timeout.
