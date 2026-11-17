# 074 - Gỡ bỏ Bigger Context và New browser chat for each turn khỏi giao diện Settings

> **Trạng thái:** ⏳ Chờ User Test & Confirm  
> **Providers:** `launcher`, `ui`  
> **Keywords:** `biggerContext`, `freshConversation`, `SettingsSurface`, `dead-flag`

## ⚡ TL;DR
1. **Triệu chứng:** Giao diện **Settings** vẫn hiển thị hai công tắc `Bigger Context (experimental)` và `New browser chat for each turn` dù cả hai cờ này không còn được các adapter hiện tại (`m365-copilot`, `ai-studio`) hay `WebTurnEngine` đọc khi chạy turn.
2. **Nguyên nhân gốc rễ:** Sau khi loại bỏ `chatgpt-web` adapter, `SettingsSurface` trong [App.tsx](../../launcher/src/App.tsx) vẫn giữ lại UI và chuỗi i18n cho hai tùy chọn cũ.
3. **Cách sửa:** Gỡ bỏ hai `<SettingRow>` và handler `setBiggerContext`, `setFreshConversationPerTurn` trong [App.tsx](../../launcher/src/App.tsx), xóa 4 khóa i18n (`biggerContext`, `biggerContextBody`, `freshConversation`, `freshConversationBody`) trong [i18n.ts](../../launcher/src/i18n.ts) ở cả 5 ngôn ngữ và cập nhật test tương ứng; giữ nguyên `Skills as files` và các IPC/CLI backend flags hiện có.

## Thay đổi
- [launcher/src/App.tsx](../../launcher/src/App.tsx): Xóa handler `setBiggerContext`, `setFreshConversationPerTurn` và hai hàng `SettingRow` tương ứng trong `SettingsSurface`.
- [launcher/src/i18n.ts](../../launcher/src/i18n.ts): Xóa `biggerContext`, `biggerContextBody`, `freshConversation`, `freshConversationBody` ở cả 5 ngôn ngữ.
- [launcher/tests/renderer-wiring.test.cjs](../../launcher/tests/renderer-wiring.test.cjs), [tests/launcher-localization.test.ts](../../tests/launcher-localization.test.ts): Cập nhật assertion xác nhận hai mục này đã được gỡ khỏi UI Settings.

## Xác minh
- `bun run launcher:build`: Pass (`tsc --noEmit` + `vite build`).
- `bun run launcher:test`: 252 pass, 0 fail (2 skipped sẵn có của Windows installer).
- `bun test tests/launcher-localization.test.ts`: 1 pass, 0 fail.
