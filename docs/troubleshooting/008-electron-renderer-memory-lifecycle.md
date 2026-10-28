# [ISSUE-008] Electron tích lũy Renderer và sử dụng hơn 2 GB RAM

> **Status:** ⏳ Chờ User Test & Confirm
> **Providers:** `launcher`, `electron`, `chatgpt-web`, `m365-copilot`, `gemini-web`, `qwen-web`
> **Keywords:** `renderer`, `WebContentsView`, `RAM`, `memory leak`, `ViewLifecycleManager`, `turnTabs`, `backgroundThrottling`

## ⚡ TL;DR
- **Triệu chứng**: Launcher tạo 9–12 tiến trình `--type=renderer`, tổng RAM vượt 2,1 GB và `renderer-client-id` tăng liên tục.
- **Nguyên nhân gốc rễ**: (1) Khởi tạo đồng loạt 4 Primary `WebContentsView` lúc mở app; (2) Các `turnTabs` sau khi hoàn thành (`retain: true`) không gọi `syncViewVisibility()` khi chạy ngầm nên vẫn giữ `setVisible(true)` + `deviceEmulation` khiến Chromium không bao giờ throttle; (3) Tích lũy tối đa 5 `turnTabs` chờ cùng lúc suốt 30 phút; (4) Cờ `appendSwitch("disable-...", "false")` trong `main.cjs` vô tình bật cờ boolean `HasSwitch` của Chromium làm tắt hoàn toàn throttling nền.
- **Cách sửa**: Dùng `ViewLifecycleManager` lazy-load đúng 1 Primary View đang chọn và hủy view + tab chờ của provider cũ khi chuyển; gọi `removeSwitch` cho các cờ `disable-*` ở `main.cjs`; trong `endTurn()` và `presentTurnView()`, thu hồi ngay các tab `ready` cũ hơn, tắt `deviceEmulation`, đặt `setVisible(false)` và dọn sạch listener khi đóng tab; đồng bộ `GeminiWebAdapter` qua `notifyLauncherTurn`.

---

## 🛠️ File Sửa & Quy Tắc Cốt Lõi

1. **`launcher/electron/main.cjs`**:
   - Dùng `app.commandLine.removeSwitch(...)` cho `disable-background-timer-throttling`, `disable-backgrounding-occluded-windows`, `disable-renderer-backgrounding` (TUYỆT ĐỐI không dùng `appendSwitch(..., "false")` vì Chromium kiểm tra sự tồn tại của cờ bằng `HasSwitch`).
2. **`launcher/electron/view-lifecycle-manager.cjs`**:
   - Quản lý lazy-create, attach/detach, hibernate và destroy `WebContentsView` của từng provider.
3. **`launcher/electron/browser-host.cjs`**:
   - Chỉ tạo Primary View cho provider hiện hành; `initializePrimaryView()` và `markOwnedSurface()` phân nhánh đúng URL/ownership cho cả `chatgpt`, `m365`, `gemini`, `qwen`.
   - `releaseInactivePrimaryViews()`: khi đổi provider, hủy Primary View của provider không dùng và đóng luôn các `turnTabs` đang ở trạng thái `ready` của provider cũ.
   - `presentTurnView()`: chỉ bật `enableHiddenTurnViewport` khi `tab.status === "running"`; khi tab đã `ready` và ở nền (`!visible`), gọi `disableDeviceEmulation()` và `setVisible(false)` để Chromium kích hoạt `backgroundThrottling`.
   - `endTurn()`: khi giữ lại tab hoàn thành (`retain = true`), thu hồi các tab automatic `ready` cũ hơn và gọi `syncViewVisibility()` ngay cả khi `hideAfterTurn === false`.
   - `removeTurnTab()` & `destroy()`: gỡ `shellZoomShortcutBindings`, tắt `deviceEmulation`, gọi `removeAllListeners()` trước khi `webContents.close()`, và gỡ `authenticationCookieBindings`.
   - `bindChatGptBackendRecovery()`: chỉ gắn vào session của ChatGPT và tự gắn lại khi lazy-create `chatGptView`.
4. **`launcher/electron/gemini-surface-manager.cjs`, `launcher/electron/gemini-turn-surface.cjs` & `src/adapters/gemini-web/index.ts`**:
   - Đồng nhất 100% quy trình vòng đời lượt (`notifyLauncherTurn` `phase: "start"` / `"end"`, `GeminiSurfaceManager`, `bindGeminiTurnContents`, `markGeminiTurnSurface`) của Gemini với ChatGPT, M365 và Qwen.
