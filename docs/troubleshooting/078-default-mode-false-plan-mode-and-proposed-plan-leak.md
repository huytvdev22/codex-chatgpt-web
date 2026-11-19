# Lỗi 078: Bật nhầm Plan Mode từ `function_call_output` và lộ thẻ `<proposed_plan>` ở Default Mode

> **Trạng thái:** ✅ Đã Confirm
> **Providers:** `web`, `m365-copilot`
> **Keywords:** `detectCollaborationMode`, `CodexPayloadNormalizer`, `proposed_plan`, `UNEXPECTED_PROPOSED_PLAN`, `stripStandaloneProposedPlanTags`

## ⚡ TL;DR
- **Triệu chứng:** Khi chat ở Default Mode (không bật `/plan`) và AI chạy lệnh đọc source code có chứa chuỗi `<collaboration_mode># Plan Mode`, lượt tiếp theo trả về thẻ `<proposed_plan>` hiển thị thô trong bong bóng chat Codex UI thay vì văn bản Markdown thường.
- **Nguyên nhân gốc rễ:** `CodexPayloadNormalizer.detectCollaborationMode()` gọi `JSON.stringify(rawPayload)` trên toàn bộ request (gồm cả `function_call_output`, `user`, `assistant`) rồi lấy vị trí match cuối cùng -> bắt nhầm chuỗi `<collaboration_mode># Plan Mode` nằm trong output đọc file ở lượt trước, tự lật `collaborationMode` sang `"plan"` và gửi `PLAN_SURVEY_CONTINUATION_PROMPT` yêu cầu xuất `<proposed_plan>`; đồng thời `WebTurnEngine` không kiểm soát `<proposed_plan>` ở đầu ra khi `!isPlanMode`.
- **Cách sửa:** Giới hạn `detectCollaborationMode()` chỉ đọc từ control-plane đáng tin cậy (`role: "developer" | "system"`, metadata `collaboration_mode.instructions`, hoặc top-level `collaboration_mode`), bỏ qua hoàn toàn tool output/user/assistant; bổ sung chốt chặn đầu ra trong `WebTurnEngine`: tự lột thẻ `<proposed_plan>` ngoài code block ở Default Mode (`stripStandaloneProposedPlanTags`) và retry `UNEXPECTED_PROPOSED_PLAN` nếu AI xuất lại `<proposed_plan>` khi `isImplementingPlan === true`.

## Thay đổi
- [src/adapters/web/normalization/codex-normalizer.ts](../../src/adapters/web/normalization/codex-normalizer.ts): Tái cấu trúc `detectCollaborationMode()` chỉ đọc control-plane `<collaboration_mode>` và structured `collaboration_mode`, loại trừ `function_call_output` / `user` / `assistant`.
- [src/adapters/web/protocol/strict-response-parser.ts](../../src/adapters/web/protocol/strict-response-parser.ts): Thêm `UNEXPECTED_PROPOSED_PLAN`, `hasStandaloneProposedPlanTag()`, `stripStandaloneProposedPlanTags()` (tôn trọng fenced code block và inline backticks).
- [src/adapters/web/prompt/templates.ts](../../src/adapters/web/prompt/templates.ts): Thêm nhánh retry hướng dẫn cho `UNEXPECTED_PROPOSED_PLAN` trong `buildFormatRetryPrompt()`.
- [src/adapters/web/engine.ts](../../src/adapters/web/engine.ts): Kiểm tra đầu ra `final_answer` khi `!isPlanMode` (retry ở `isImplementingPlan`, auto-strip ngoài code block ở Default Mode).
- [tests/codex-payload-normalizer.test.ts](../../tests/codex-payload-normalizer.test.ts) & [tests/m365-plan-mode.test.ts](../../tests/m365-plan-mode.test.ts): Bổ sung test tái hiện và regression test.
