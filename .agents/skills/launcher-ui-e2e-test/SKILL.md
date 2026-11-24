---
name: launcher-ui-e2e-test
description: >-
  Runbook kiểm thử UI thật của Electron Launcher (React shell + WebContentsView)
  bằng agent-desktop MCP. Dùng khi cần test Setup, chuyển provider, đa profile
  Google AI Studio, nút Use/Open/Sign in with Chrome mà không thao tác tay.
---

# Kiểm thử UI Electron Launcher bằng `agent-desktop`

Dùng quy trình này khi cần kiểm chứng tương tác UI thật trên cửa sổ Launcher (`Codex Web GPT`) thông qua `agent-desktop` MCP (`desktop_*`).

## 1. Xác định đúng cửa sổ Launcher
- Nếu Launcher chưa chạy, khởi động từ terminal trong IDE nhớ unset `ELECTRON_RUN_AS_NODE`:
  ```sh
  env -u ELECTRON_RUN_AS_NODE bun run --cwd launcher start
  ```
- Cửa sổ dev thường mang tên `"Electron"` hoặc `"Codex Web GPT"`. Luôn tìm `pid` trước rồi lọc trong `desktop_list_windows()` theo `pid` để tránh nhầm với Antigravity IDE / VS Code:
  ```sh
  pgrep -fl "codex-chatgpt-web/launcher"
  ```
- **Tránh timeout hệ thống:** Không gọi `desktop_list_windows({ app: "Google Chrome" })` để check xem Chrome có bật hay không (dễ dính `APP_UNRESPONSIVE` nếu hệ thống có app nền treo). Dùng lệnh shell kiểm tra tiến trình sẽ nhanh và chắc chắn hơn:
  ```sh
  pgrep -fl "chrome-login-tmp|Google Chrome" || echo "NO_CHROME_RUNNING"
  ```

## 2. Quy tắc Snapshot 2 tầng (`webarea` kép)
Cửa sổ Launcher có 2 `webarea` song song trong cùng `window_id`:
1. **`Codex Web GPT`** (`native_id: "root"`): React shell (Sidebar `Browser`/`Setup`/`Usage`, Profile Switcher, nút `Use`/`Open`/`Sign in with Chrome`).
2. **`Google AI Studio`** hoặc **`M365 Copilot`**: `WebContentsView` nhúng bên trong.

Luôn snapshot theo 2 bước để tránh timeout `3000ms` mặc định của Electron:
1. `desktop_snapshot({ window_id, skeleton: true, interactive_only: true, compact: true, timeout_ms: 10000 })`
2. Lấy `ref_id` của `Codex Web GPT` (`root`) hoặc `WebContentsView`, sau đó gọi `desktop_snapshot({ root: "<ref>", compact: true, timeout_ms: 10000 })` (hoặc `desktop_find({ root: "<ref>", name: "Enter a prompt", timeout_ms: 10000 })`).

## 3. Kịch bản kiểm chứng nhanh (Multi-Profile & Chrome Sign-In)
1. **Setup sync:** Mở tab **Setup** -> kiểm tra mục `Sign in to Google AI Studio` và `Sign in to ChatGPT` (`Signed in` vs `Sign in with Chrome`) và từng dòng profile (`Default`, `Account 2`, ...) có nút **`Open`** (đã auth) hay **`Sign in with Chrome`** (chưa auth).
2. **Switch / Open profile đã đăng nhập:** Chuyển provider (`M365 Copilot` / `Google AI Studio` / `ChatGPT`) rồi bấm **`Use`** hoặc **`Open`** trên profile đã auth -> xác nhận `NO_CHROME_RUNNING` qua `pgrep`, toolbar đổi đúng tên profile (`<Name> ●`), URL lên `aistudio.google.com/...` hoặc `chatgpt.com/`, và tìm thấy ô `Enter a prompt` / `Ask ChatGPT` trong `WebContentsView`.
3. **Profile chưa đăng nhập:** Bấm `+` tạo profile mới hoặc chọn profile chưa auth -> xác nhận UI hiện màn `Sign in with Chrome` theo đúng provider đang chọn thay vì trang lỗi OAuth/Cloudflare nhúng.

## 4. Lưu ý giữ nguyên trạng thái cho user
- `desktop_click` (`AXPress`) chạy nền không cướp focus hay giật chuột, nhưng **làm thay đổi state thật** trên app Launcher đang mở (đổi tab/profile hiện tại).
- Sau khi test xong, nếu cần hãy chuyển trả lại đúng profile/tab ban đầu cho user.
