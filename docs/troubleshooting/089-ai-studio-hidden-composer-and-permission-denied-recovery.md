# 089 — Tự phục hồi lỗi AI Studio `permission denied` & `hidden <textarea>` + Bỏ `Recent Turns` ở Tab Usage

- **Trạng thái:** ✅ Đã Confirm
- **Phạm vi:** `ai-studio`, `electron`, `launcher`, `usage`
- **Ngày:** 2026-11-20

## ⚡ TL;DR
- **Triệu chứng:** Google AI Studio hay văng lỗi `[AI Studio Web Error] ... permission denied. Please try again.` giữa các lượt tool call, và `waitForSelector` timeout 20s do `locator resolved to hidden <textarea aria-label="Enter a prompt">`; ngoài ra tab `Usage` hiển thị thêm danh sách `Recent Turns` gây dài giao diện.
- **Nguyên nhân gốc rễ:** (1) Lỗi BotGuard/403 tạm thời làm `executeTurn` văng lỗi ngay, khiến `WebTurnEngine` đóng tab và ép Codex `Reconnecting`; (2) `hiddenTurnBounds`/`HIDDEN_TURN_VIEWPORT` fallback về `800x600` (dễ vào breakpoint ẩn/mobile) và selector composer dùng phần tử đầu tiên thay vì lọc `visible=true` hoặc reload khi bị Angular ẩn.
- **Cách sửa:** Override `executeTurn` trong `AiStudioBrowserWorker` để tự phục hồi tối đa 2 lần (đóng snackbar lỗi, reload giữ nguyên `/prompts/{id}` và chạy lại); nâng viewport ẩn tối thiểu lên `1024x720` + lọc composer `visible=true` + reload phục hồi layout khi hidden; bỏ mục `Recent Turns` trong `UsageSurface.tsx`.

## Chi tiết thay đổi
- `src/adapters/ai-studio/ai-studio-browser-worker.ts`:
  - Thêm `isTransientAiStudioWebError()` và override `executeTurn()` tự phục hồi nội bộ (`MAX_TRANSIENT_WEB_RETRIES = 2`), giữ nguyên `liveConversationId` (`/prompts/{id}`) sau `page.reload()`.
  - Thêm `getVisibleComposerLocator()` (`locator("visible=true").first()`) và `waitForVisibleComposer()` (dispatch `resize`, dismiss nudges, reload trang nếu Angular vẫn giữ textarea ở trạng thái hidden).
  - Cập nhật `isCleanBlankNewChat()` và DOM setter fallback trong `insertPrompt()` để kiểm tra kích thước + `display`/`visibility` trên toàn bộ node `textarea[aria-label="Enter a prompt"]` khớp được.
- `launcher/electron/browser/browser-host.cjs` & `launcher/electron/browser/turn-tab-manager.cjs`: Nâng kích thước tối thiểu khi tab chạy ẩn từ `800x600` lên `1024x720`.
- `launcher/src/components/UsageSurface.tsx`: Xoá phần `Recent Turns` list và helper `formatTurnTime`, chỉ giữ Toggle Footer, Toolbar lọc thời gian, 3 thẻ KPI, `By Provider` và `By Model`.
- `tests/ai-studio-adapter.test.ts`: Bổ sung test cho `isTransientAiStudioWebError`, `executeTurn` retry/reload, và `waitForVisibleComposer`.
