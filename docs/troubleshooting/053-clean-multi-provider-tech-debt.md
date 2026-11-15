# 053 - Dọn dẹp Nợ Kỹ thuật Kiến trúc Đa Provider trước khi Thêm Adapter Mới

> **Trạng thái:** ⏳ Chờ User Test & Confirm  
> **Ngày thực hiện:** 2026-11-15  
> **Phạm vi:** `src/adapters/web/**`, `src/adapters/m365-copilot/**`, `src/**`, `launcher/electron/**`, `launcher/src/**`, `scripts/check-circular-deps.js`, `tests/**`, `launcher/tests/**`, `docs/adding-new-web-adapter-guide.md`

## ⚡ TL;DR
1. **Triệu chứng:** Codebase còn tồn đọng alias `M365*` cũ ở shared layer (`src/adapters/web`), probe capability ChatGPT legacy (`temporary`, `solAvailable`, `extraHighAvailable`, `proAvailable`, `--refresh-account-capabilities`), và nhiều singleton/state/UI hardcoded cho M365 trong Electron Launcher (`m365SurfaceManager`, `m365Authenticated`, `m365SmokePassed`).
2. **Nguyên nhân gốc rễ:** Quá trình chuyển đổi từ single-provider (ChatGPT/M365) sang kiến trúc đa provider (`WebTurnEngine`, `AdapterRegistry`, `BrowserProviderRegistry`) trước đó vẫn giữ lại lớp tương thích tạm thời ở config, IPC, state store và giao diện React.
3. **Cách sửa:** Gỡ toàn bộ alias `M365*` khỏi `src/adapters/web` và tự động quét provider trong gate kiến trúc; loại bỏ capability probe ChatGPT legacy (tự động bỏ qua/strip trường cũ khi đọc `config.json`); tách auth/smoke state theo `providerId`, mở IPC `launcher:list-providers` + `launcher:switch-provider` và render động danh sách provider + `.provider-switcher` trong Launcher UI.

## Thay đổi chính
- **Giai đoạn 1 — Chuẩn hóa Shared Web Layer & Architecture Gate:**
  - Xóa toàn bộ alias `M365*` cũ trong [src/adapters/web](../../src/adapters/web/index.ts), chuyển `m365HtmlToMarkdown` sang [m365-dom-observer.ts](../../src/adapters/m365-copilot/m365-dom-observer.ts) và re-export tại [m365-copilot/index.ts](../../src/adapters/m365-copilot/index.ts).
  - Cập nhật [check-circular-deps.js](../../scripts/check-circular-deps.js) và [m365-architecture-integrity.test.ts](../../tests/m365-architecture-integrity.test.ts) tự động quét mọi thư mục provider dưới `src/adapters/` và cấm tái xuất hiện alias `M365*` trong shared layer.
- **Giai đoạn 2 — Gỡ Legacy ChatGPT Capability Probe & Config:**
  - Xóa `solAvailable`, `extraHighAvailable`, `proAvailable`, `temporary`, `detectCapabilities` và cờ `--refresh-account-capabilities` trong [types.ts](../../src/types.ts), [config.ts](../../src/config.ts), [setup.ts](../../src/setup.ts), [cli.ts](../../src/cli.ts), [launcher-browser-host.ts](../../src/launcher-browser-host.ts), [browser-host.cjs](../../launcher/electron/browser/browser-host.cjs), [control-server.cjs](../../launcher/electron/browser/control-server.cjs) và [runtime-host.cjs](../../launcher/electron/runtime/runtime-host.cjs), đồng thời bỏ qua an toàn các trường legacy khi đọc `config.json` cũ.
- **Giai đoạn 3 & 4 — Đa Provider trong Launcher Backend, IPC & React UI:**
  - Thay thế singleton `m365SurfaceManager`/`m365SurfaceId`/`m365View`/`m365Authenticated`/`m365SmokePassed` bằng `providerViews`, `authenticatedByProvider`, `providerSurfaceIds` và `smokePassedByProvider` tại [state-store.cjs](../../launcher/electron/infra/state-store.cjs), [browser-host.cjs](../../launcher/electron/browser/browser-host.cjs), [turn-tab-manager.cjs](../../launcher/electron/browser/turn-tab-manager.cjs), [ipc-router.cjs](../../launcher/electron/app/ipc-router.cjs) và [preload.cjs](../../launcher/electron/preload.cjs).
  - Cập nhật [App.tsx](../../launcher/src/App.tsx), [types.ts](../../launcher/src/types.ts) và [styles.css](../../launcher/src/styles.css) để render động bước đăng nhập/smoke test theo danh sách `providers`, bổ sung `.provider-switcher` accessible trong `BrowserSurface`, và chuẩn hóa tài liệu [adding-new-web-adapter-guide.md](../adding-new-web-adapter-guide.md).

