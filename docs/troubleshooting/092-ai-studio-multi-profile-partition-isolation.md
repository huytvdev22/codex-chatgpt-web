# 092 — Hỗ trợ Đa Profile Google AI Studio (Giai đoạn 1: 1-Click Switcher & Cách ly Partition)

- **Trạng thái:** ⏳ Chờ User Test & Confirm
- **Phạm vi:** `ai-studio`, `launcher`, `electron`, `profiles`
- **Ngày:** 2026-11-20

## ⚡ TL;DR
- **Yêu cầu / Triệu chứng:** Người dùng có nhiều tài khoản Google AI Studio muốn chuyển qua lại nhanh để tránh chạm giới hạn ngày (`Quota exceeded`) mà không cần đăng xuất/đăng nhập lại hoặc đá chéo phiên chat `/prompts/{id}`.
- **Kiến trúc xử lý:** Thêm hệ thống Profile (`default` giữ nguyên partition cũ `persist:codex-web-aistudio` + `ai-studio-conversations.json`; profile phụ dùng `persist:codex-web-aistudio-<id>` + `ai-studio-profile-<id>-conversations.json`).
- **Cách hoạt động:** Cô lập 100% cookie, `ConversationStore` và `TurnTabManager` theo `(providerId, profileId)`; khóa đổi/sửa/xóa profile khi đang có turn chạy (`activeTraceId` / `navigationLocked`); cung cấp Profile Switcher ngay trên Browser Toolbar và mục Account Profiles trong Setup.

## Chi tiết thay đổi
- `launcher/electron/infra/state-store.cjs`: Lưu và chuẩn hóa `providerProfiles` (mặc định có `"default"`).
- `launcher/electron/browser/providers/base-browser-provider.cjs` & `launcher/electron/browser/providers/ai-studio/ai-studio-browser-provider.cjs`: Tách `partitionForProfile()` và `ConversationStore` theo `profileId` bằng `Map`.
- `launcher/electron/browser/turn-tab-manager.cjs` & `launcher/electron/browser/browser-host.cjs`: Gắn `tab.profileId`, chỉ reuse `retainedMatches` cùng `profileId`, thêm `switchProviderProfile` / `createProviderProfile` / `renameProviderProfile` / `deleteProviderProfile`, tự hủy/tạo lại PrimaryView theo partition mới và khóa thao tác profile khi có turn đang chạy.
- `launcher/electron/main.cjs`, `ipc-router.cjs`, `preload.cjs`, `launcher/src/types.ts`, `launcher/src/App.tsx`, `launcher/src/styles.css`: Nối IPC + thêm Profile Switcher trên Browser Toolbar và trình quản lý Profile trong tab Setup.
- `launcher/tests/browser-host.test.cjs`, `launcher/tests/renderer-wiring.test.cjs`, `tests/launcher-browser-host.test.ts`: Bổ sung unit test cô lập partition/tab/store và khóa khi turn đang chạy.
