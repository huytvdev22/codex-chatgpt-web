# 073 - Gỡ bỏ mục chỉnh sửa Plugin name khỏi giao diện Settings Launcher

> **Trạng thái:** ⏳ Chờ User Test & Confirm  
> **Providers:** `launcher`, `ui`  
> **Keywords:** `pluginName`, `plugin-name-setting`, `SettingsSurface`, `flushAfter`, `connectorName`

## ⚡ TL;DR
1. **Triệu chứng:** Màn hình **Settings** hiển thị khối `Plugin name` (`Codex stays fixed. Edit the rest of the name.` + ô nhập `Codex Native2` + nút `Change name`).
2. **Nguyên nhân gốc rễ:** `SettingsSurface` trong [App.tsx](../../launcher/src/App.tsx) render khối `.plugin-name-setting` kèm state `nameSuffix`/`confirmNameChange` và gắn `flushAfter` lên dòng `Launch at login` để ẩn đường kẻ ngăn cách phía trên nó.
3. **Cách sửa:** Gỡ bỏ khối `.plugin-name-setting`, state/handler `changePluginName`, prop `openSetup` của `SettingsSurface` và `flushAfter` trong [App.tsx](../../launcher/src/App.tsx); xóa CSS `.plugin-name-*` và `.setting-row.is-flush-after` trong [styles.css](../../launcher/src/styles.css); xóa 5 khóa i18n `pluginName*` trong [i18n.ts](../../launcher/src/i18n.ts) (giữ nguyên IPC/backend `setConnectorNameSuffix`).

## Thay đổi
- [launcher/src/App.tsx](../../launcher/src/App.tsx): Xóa UI `.plugin-name-setting`, state `nameSuffix` / `confirmNameChange`, `changePluginName`, prop `openSetup` và `flushAfter`.
- [launcher/src/styles.css](../../launcher/src/styles.css): Xóa các rule `.plugin-name-setting*`, `.plugin-name-input*`, `.plugin-name-actions` và `.setting-row.is-flush-after`.
- [launcher/src/i18n.ts](../../launcher/src/i18n.ts): Xóa 5 khóa `pluginName`, `pluginNameBody`, `pluginNameChange`, `pluginNameWarning`, `pluginNameConfirm` ở cả 5 ngôn ngữ.
- [launcher/tests/renderer-wiring.test.cjs](../../launcher/tests/renderer-wiring.test.cjs), [launcher/tests/localization.test.cjs](../../launcher/tests/localization.test.cjs): Cập nhật test xác nhận UI `Plugin name` đã bị gỡ và `Launch at login` không còn `flushAfter`.

## Xác minh
- `bun run launcher:build`: Pass (`tsc --noEmit` + `vite build`).
- `bun run launcher:test`: 252 pass, 0 fail (2 skipped sẵn có của Windows installer).
- `bun test tests/launcher-localization.test.ts`: 1 pass, 0 fail.
