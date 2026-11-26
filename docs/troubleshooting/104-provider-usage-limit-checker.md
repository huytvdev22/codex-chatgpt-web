# 104 — Kiểm tra Account Usage Limits theo từng Adapter & Profile (ChatGPT & Gemini)

- **Trạng thái:** ⏳ Chờ User Test & Confirm
- **Providers / Phạm vi:** `chatgpt`, `gemini`, `web`, `server`, `launcher`, `electron`, `usage`

## ⚡ TL;DR
1. **Triệu chứng:** Cần theo dõi hạn mức gói tài khoản theo từng adapter & từng profile (trước mắt ChatGPT `/settings/usage?tab=overview` và Gemini `/usage`) ngay trong Launcher và qua HTTP API cục bộ mà không làm đổi profile đang dùng.
2. **Nguyên nhân / Thiết kế:** Khảo sát thực tế qua `chrome-devtools` cho thấy ChatGPT trả JSON chuẩn tại `GET /backend-api/wham/usage` (áp dụng chung cho Codex/Work/Workspace Agents, không gồm chat web), còn Gemini SSR trực tiếp qua `[data-usage-island-root]` với `data-testid` ổn định (`current-usage`, `weekly-usage`, `usage-updated`).
3. **Cách làm:** Thêm `src/limits/` + `LimitManagementService` lưu cache `<configDir>/provider-limits.json` theo `(providerId, profileId)`, mở rộng `TurnTabManager`/`BrowserControlServer` nhận `profileId` tùy chọn cho ephemeral tab, thêm `ChatGptUsageLimitChecker` & `GeminiUsageLimitChecker`, expose `/admin/limits`, `/admin/limits/refresh`, `/v1/limits` (cache read-only) và hiển thị trong Tab `Usage` + badge cảnh báo trên Provider/Profile switcher.

## Ghi chú kỹ thuật
- **ChatGPT (`src/adapters/chatgpt/usage-limit-checker.ts`):** Ưu tiên bắt response JSON `/backend-api/wham/usage`, fallback sang đọc `<progress aria-label="Usage remaining">` trên DOM; gắn `scopeNote` giải thích phạm vi Codex/Work.
- **Gemini (`src/adapters/gemini/usage-limit-checker.ts`):** Đọc `[data-usage-island-root] ul li[data-testid]`, hỗ trợ đa ngôn ngữ (`vi`/`en`) qua regex `%` và fallback CSS `--x-width` + fallback quét text.
- **Đa profile không đổi active:** `browser-host.cjs` ghi `providerProfiles` vào `launcher-browser.json`; `control-server.cjs` và `turn-tab-manager.cjs` cho phép truyền `profileId` trên `/v1/turn/start` để mở `WebContentsView` đúng partition.
