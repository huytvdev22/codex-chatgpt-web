# 105 — Nâng cấp Auto-Updater Launcher (Hybrid OOP, 2 bước, sửa macOS bundle & Windows GUI)

- **Trạng thái:** ⏳ Chờ User Test & Confirm
- **Providers / Phạm vi:** `launcher`, `electron`, `ui`, `updater`, `macos`, `windows`, `linux`

## ⚡ TL;DR
1. **Triệu chứng:** Updater cũ của Launcher hardcode binary `"Codex Web GPT"` khiến tự cập nhật macOS fail sau khi đổi `productName` sang `"Codex M365 Copilot"`, đồng thời thiếu UI kiểm tra thủ công trong Settings, Release Notes, tiến độ tải, hủy tải, bỏ qua phiên bản và thông báo OS.
2. **Nguyên nhân / Thiết kế:** `update-controller.cjs` & `update-worker.cjs` vốn đã có engine đa nền tảng (5 target mac/win/linux) nhưng chưa tách cấu hình, chưa đọc `CFBundleExecutable` động, thiếu kiểm tra `AppTranslocation`/`codesign`/`xattr`, và chưa có luồng 2 bước (`available` → `downloading` → `downloaded` → `installing`).
3. **Cách sửa:** Tách `UpdaterSettingsStore` (`updater-settings.json`), nâng cấp `AppUpdaterService` hỗ trợ 2 bước + SHA-256 + abort + skip version + check quyền macOS, chuyển `updateWindows` sang mở GUI `.exe` (bỏ `/S`), giữ tắt hoàn toàn ở Dev mode (`!app.isPackaged || IS_DEV_PROFILE`), thêm `AppUpdaterSection.tsx` trong Settings + nút Sidebar mở thẳng Settings + Electron `Notification`.

## Ghi chú kỹ thuật
- **macOS (`update-controller.cjs`, `update-worker.cjs`):** Đọc động `CFBundleExecutable` từ `Contents/Info.plist` (fallback `Contents/MacOS/`), kiểm tra `/AppTranslocation/`, quyền ghi thư mục cha, `codesign --verify --deep --strict` và `xattr -cr`. Nếu không ghi đè được thì fallback mở gói `.zip` cho người dùng cài thủ công (`mac-opened-file`).
- **Windows (`update-worker.cjs`):** Đợi tiến trình Launcher thoát (`waitForParent`) rồi mở trình cài đặt `.exe` với `windowsHide: false` (không truyền `/S`).
- **Contract tests (`launcher/tests/packaging-contract.test.cjs`):** Giữ nguyên ràng buộc `update-worker.cjs` không chứa từ khóa `backup` (dùng `previous`) và `main.cjs` giữ biểu thức `packaged: app.isPackaged && !IS_DEV_PROFILE`.
