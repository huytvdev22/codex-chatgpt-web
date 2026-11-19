# 084: M365 Copilot lặp retry khi hết hạn mức ngày & lỗi font tiếng Việt khi Windows PowerShell chạy `Get-Content`

> **Trạng thái:** ✅ Đã Confirm  
> **Providers:** `m365-copilot`, `web`, `server`  
> **Keywords:** `daily chat limit`, `fai-CopilotMessage__content`, `insufficient_quota`, `retryable`, `powershell`, `Get-Content`, `Encoding UTF8`

## ⚡ TL;DR
1. **Triệu chứng:** (a) Khi M365 Copilot hết hạn mức ngày (`You've used your daily chat limit. Please try again tomorrow.` trong `.fai-CopilotMessage__content`), adapter tưởng đó là câu trả lời thiếu `<webResponse>` và liên tục lặp vòng retry; (b) Lệnh PowerShell `Get-Content` từ AI đọc file tiếng Việt UTF-8 không BOM ra chuỗi mojibake kiểu `Cáº¥u trÃºc project vÃ  quy trÃ¬nh CR`.
2. **Nguyên nhân gốc rễ:** (a) `M365DomObserver` chỉ quét banner `[role="alert"]`/`.fai-ErrorMessage` nên bỏ sót thông báo quota nằm trong `.fai-CopilotMessage__content`, đồng thời `src/lib/errors.ts` chưa map cụm `used your daily chat limit` sang `insufficient_quota` (`429`); (b) Windows PowerShell 5.1 (`powershell.exe`) mặc định đọc file không BOM bằng ANSI codepage (`Windows-1252`), làm sai UTF-8 ngay từ output của `exec_command`.
3. **Cách sửa:** (a) Bắt thông báo quota ngay trong `.fai-CopilotMessage__content` (loại bỏ nút `Share feedback`, bỏ qua code block/`<webResponse>`), map sang HTTP `429` + `insufficient_quota` kèm `retryable: false` ở `WebTurnEngine` để dừng ngay; (b) Thêm chỉ dẫn PowerShell dùng `-Encoding UTF8` và `[Console]::OutputEncoding=[Text.Encoding]::UTF8` vào [templates.ts](../../src/adapters/web/prompt/templates.ts).

## Thay đổi
- [src/adapters/m365-copilot/m365-dom-observer.ts](../../src/adapters/m365-copilot/m365-dom-observer.ts): Thêm `detectM365MessageQuotaError()` và kiểm tra `.fai-CopilotMessage__content` chưa gắn baseline trong `captureStatus()`, đồng thời baseline các node `.fai-CopilotMessage__content` đứng lẻ.
- [src/lib/errors.ts](../../src/lib/errors.ts): Thêm `isInsufficientQuotaMessage()` để phân loại `used your daily chat limit` / `daily chat limit` sang `{ type: "insufficient_quota", code: "insufficient_quota" }` và HTTP `429`.
- [src/adapters/web/engine.ts](../../src/adapters/web/engine.ts): Gắn `retryable: false` trên sự kiện `error` khi lỗi là `insufficient_quota`.
- [src/adapters/web/prompt/templates.ts](../../src/adapters/web/prompt/templates.ts): Bổ sung lưu ý `-Encoding UTF8` và `[Console]::OutputEncoding=[Text.Encoding]::UTF8` khi chạy PowerShell trên Windows.
- [tests/m365-turn-isolation.test.ts](../../tests/m365-turn-isolation.test.ts) & [tests/web-turn-engine.test.ts](../../tests/web-turn-engine.test.ts): Bổ sung unit test DOM `.fai-CopilotMessage__content` daily limit, guard chống bắt nhầm nội dung kỹ thuật, `insufficient_quota` (`429`) và dừng ngay 1 attempt trên `WebTurnEngine`.
