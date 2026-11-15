# 052 - Tái cấu trúc Electron Launcher theo hướng OOP đa Provider và phân tách Module (`launcher/electron`)

> **Trạng thái:** ⏳ Chờ User Test & Confirm  
> **Ngày thực hiện:** 2026-11-15  
> **Nhánh:** `refactor/electron-launcher`  
> **Phạm vi:** `launcher/electron/**`, `launcher/src/**`, `launcher/scripts/**`, `launcher/tests/**`, `src/**`, `tests/**`

## ⚡ TL;DR
1. **Triệu chứng:** `launcher/electron/` dàn trải ~30 file ở root, `main.cjs` (1.290 dòng), `browser-host.cjs` (3.813 dòng) và `runtime.cjs` (1.167 dòng) ôm nhiều trách nhiệm, còn sót dead code ChatGPT Web và 2 chế độ Zero Risk / Manual khiến việc bảo trì và mở rộng provider mới gặp khó khăn.
2. **Nguyên nhân gốc rễ:** Logic provider M365, quản lý vòng đời tab/view, IPC, tray, catalog monitor và giao dịch setup nhúng lẫn vào `BrowserHost`, `RuntimeHost` và `main.cjs` thay vì được trừu tượng hóa theo OOP và gom nhóm theo tầng.
3. **Cách sửa:** Xóa dead code ChatGPT Web + Zero Risk / Manual (bảo toàn 5 ngôn ngữ i18n và `/v1/session/inspect`); thiết kế `BaseBrowserProvider` + `BrowserProviderRegistry` + `M365BrowserProvider` + `ConversationStore` + `PrimaryViewManager` + `TurnTabManager` + `SetupTransaction` + `IpcRouter` + `TrayController` + `CatalogMonitor`; chia `launcher/electron/` thành 4 thư mục `app/`, `browser/`, `runtime/`, `infra/`.

## Thay đổi chính
- **Phase 1 (Xóa dead code & chế độ thừa):**
  - Gỡ `chatGptUrl`/`chatGptPartition`, fallback điều hướng ChatGPT Web và `browserInteractionMode` (`zero-risk`/`manual`) trong `src/`, `launcher/src/`, `launcher/electron/`.
  - Bảo toàn đầy đủ 5 ngôn ngữ `en`, `zh-CN`, `zh-TW`, `ja`, `ko` trong [languages.json](../../launcher/electron/languages.json) và route `/v1/session/inspect`.
- **Phase 2 (Pragmatic OOP & Strategy/Template Method):**
  - Tầng Provider: [base-browser-provider.cjs](../../launcher/electron/browser/providers/base-browser-provider.cjs), [browser-provider-registry.cjs](../../launcher/electron/browser/providers/browser-provider-registry.cjs), [m365-browser-provider.cjs](../../launcher/electron/browser/providers/m365/m365-browser-provider.cjs), [m365-smoke-tester.cjs](../../launcher/electron/browser/providers/m365/m365-smoke-tester.cjs), [conversation-store.cjs](../../launcher/electron/browser/conversation-store.cjs).
  - Tầng Điều phối Browser/Runtime/App: [primary-view-manager.cjs](../../launcher/electron/browser/primary-view-manager.cjs), [turn-tab-manager.cjs](../../launcher/electron/browser/turn-tab-manager.cjs), [setup-transaction.cjs](../../launcher/electron/runtime/setup-transaction.cjs), [tray-controller.cjs](../../launcher/electron/app/tray-controller.cjs), [catalog-monitor.cjs](../../launcher/electron/app/catalog-monitor.cjs), [ipc-router.cjs](../../launcher/electron/app/ipc-router.cjs).
- **Phase 3 (Tổ chức thư mục & Kiểm thử):**
  - Quy hoạch `launcher/electron/` theo 4 thư mục (`app/`, `browser/` kèm `providers/m365/`, `runtime/`, `infra/`), rút gọn [main.cjs](../../launcher/electron/main.cjs) từ 1.290 xuống 777 dòng, [browser-host.cjs](../../launcher/electron/browser/browser-host.cjs) từ 3.813 xuống 1.414 dòng, và tách [runtime.cjs](../../launcher/electron/runtime/runtime-host.cjs) (1.167 dòng) thành `runtime-host.cjs` (855 dòng) + `setup-transaction.cjs` (265 dòng).
  - Sửa bug `navigationOriginForLog` trả về `"invalid"` thay `"invalid-url"` và bảo vệ `releaseInactivePrimaryViews` tương thích mock fixture; bổ sung [browser-providers.test.cjs](../../launcher/tests/browser-providers.test.cjs).
- **Tinh chỉnh UI (theo phản hồi test thực tế):**
  - Nới khoảng cách `.titlebar-left` trên macOS trong [styles.css](../../launcher/src/styles.css) (`left: 86px`, nút `28px × 28px`, và `padding-left: 122px` cho `.browser-tab-strip` khi đóng sidebar) để tránh dính nút traffic lights, kèm `aria-expanded` trong [App.tsx](../../launcher/src/App.tsx).
  - Sửa chuỗi mojibake UTF-8 (`Â·` → `·`, `â€“` → `—–`) trong [App.tsx](../../launcher/src/App.tsx).
