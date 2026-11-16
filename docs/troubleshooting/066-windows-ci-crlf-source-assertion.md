# 066 - `tests/m365-base-browser-worker.test.ts` fail 1/12 trên `windows-latest` do lệch line ending CRLF (`\r\n`)

> **Trạng thái:** ⏳ Chờ User Test & Confirm  
> **Ngày phát hiện:** 2026-11-17  
> **Phạm vi:** `tests/m365-base-browser-worker.test.ts`

## ⚡ TL;DR
1. **Triệu chứng:** Job `windows-latest` vượt qua `tests/base-browser-worker.test.ts` nhưng fail `11 pass / 1 fail` ở `tests/m365-base-browser-worker.test.ts`.
2. **Nguyên nhân gốc rễ:** Git checkout trên Windows (`core.autocrlf = true`) ghi file `.ts` với `\r\n`, khiến assertion `toContain("await this.findVisibleLocator(\n      page,\n      M365_CHAT_EDITOR_SELECTOR,")` trong test 1 không khớp chuỗi `\n`.
3. **Cách sửa:** Chuẩn hóa `.replace(/\r\n/g, "\n")` trong `readWorkerSource()` và `readObserverSource()` tại [m365-base-browser-worker.test.ts](../../tests/m365-base-browser-worker.test.ts#L14-L20).

