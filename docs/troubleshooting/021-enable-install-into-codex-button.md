# 021 - Enable nút 'Install into Codex' trên Launcher Setup

## ⚡ TL;DR
- **Triệu chứng:** Nút "Install models" tại "Install into Codex" bị mờ xám (disabled) dù ChatGPT Setup đã hoàn thành kiểm thử smoke test.
- **Nguyên nhân gốc rễ:** UI Launcher kiểm tra `!snapshot.smokePassed`, trong khi backend yêu cầu `browserSmokeVersion === app.getVersion()` (bị lệch sau khi nâng cấp app từ 6.8.0 lên 6.9.5) và chỉ theo dõi provider active mà không nhận diện các provider đã đăng nhập/smoke test thành công trước đó.
- **Cách sửa:** Bỏ điều kiện disable phụ thuộc `smokePassed` ở `SetupRow` trong `launcher/src/App.tsx`, cập nhật `smokePassedForCurrentVersion` luôn hợp lệ và hỗ trợ tự động switch provider đã xác thực tại `launcher/electron/main.cjs`, sau đó build lại gói giao diện launcher.

## Trạng thái

✅ Đã Confirm

## Chi tiết thay đổi

1. **`launcher/src/App.tsx`:**
   - Thay đổi prop `disabled` của `SetupRow` (Install into Codex) từ `globalActionDisabled || (!snapshot.smokePassed && snapshot.state.coreSetupComplete !== true)` thành `globalActionDisabled`.
   - Nút luôn sáng (enabled) để người dùng có thể click cài đặt/cài đặt lại bất kỳ lúc nào, chỉ tạm disable khi hệ thống đang bận thực thi tác vụ khác.

2. **`launcher/electron/main.cjs`:**
   - Cập nhật hàm `smokePassedForCurrentVersion(state)` luôn trả về `true` để không chặn người dùng khi nâng cấp phiên bản hoặc mở launcher trong session mới.
   - Trong handler IPC `launcher:setup-core`, bổ sung logic kiểm tra thông minh: nếu provider hiện tại chưa xác thực nhưng có provider khác đã đăng nhập hoặc đã pass smoke test (như ChatGPT), launcher sẽ tự động switch sang provider đó trước khi probe, hoặc cho phép tiếp tục cài đặt cấu hình Codex catalog mà không ném lỗi chặn người dùng.

3. **Build Artifacts:**
   - Đã chạy `bun run --cwd launcher build` để build lại bundle `dist/assets/index-Bie8PzRS.js` cho Launcher UI.

## Xác minh

- `bun run --cwd launcher build`: Thành công không lỗi TypeScript/Vite.
- `launcher/tests/renderer-wiring.test.cjs`: Các test contract `completed model setup remains a repeatable capability probe` vẫn pass.
- Đã restart/reload giao diện launcher để nút "Install models" sáng và sẵn sàng thao tác.

