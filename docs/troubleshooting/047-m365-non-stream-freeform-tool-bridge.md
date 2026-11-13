# 047: M365 Copilot non-streaming response đánh rơi `freeformToolNames` / `toolSearchToolNames`

**Trạng thái:** ⏳ Chờ User Test & Confirm  
**Ngày phát hiện:** 2026-11-13  
**Phạm vi:** `src/server.ts` (`handleM365ResponseRequest`)

---

## ⚡ TL;DR
1. **Triệu chứng:** Request `POST /v1/responses` không stream (`stream: false`) tới `m365-copilot` trả về `function_call` thay vì `custom_tool_call` cho freeform tool như `exec`.
2. **Nguyên nhân gốc rễ:** `handleM365ResponseRequest` trong `src/server.ts` đã truyền `maps.freeformToolNames` và `maps.toolSearchToolNames` vào `bridgeToResponsesSSE()` nhưng quên truyền 2 tập hợp này vào `buildResponseJSON()` ở nhánh non-streaming.
3. **Cách sửa:** Bổ sung `freeformToolNames: maps.freeformToolNames` và `toolSearchToolNames: maps.toolSearchToolNames` vào object options truyền cho `buildResponseJSON()`.

---

## Chi tiết
- Trong `src/bridge.ts`, `buildResponseJSON(events, modelId, options)` sử dụng `options?.freeformToolNames` để phân biệt tool freeform (`custom_tool_call`) với JSON function tool (`function_call`).
- Khi nhánh non-streaming ở [src/server.ts](file:///Users/huytv/IdeaProjects/1.m365-codex/codex-chatgpt-web/src/server.ts#L572-L577) bỏ sót `freeformToolNames` và `toolSearchToolNames`, toàn bộ tool call trả về ở chế độ `stream: false` đều bị serialize sai thành `function_call`.
- Được phát hiện khi chạy test `Responses Lite native exec survives a complete server request as one custom call` trong `tests/responses-lite-tools.test.ts` với model `m365-copilot/gpt-5.6`.
