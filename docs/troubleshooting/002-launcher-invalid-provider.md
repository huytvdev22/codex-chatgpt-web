# [ISSUE-002] Lỗi Kết Nối Launcher: Provider is Invalid (HTTP 400)

> **Status:** ✅ RESOLVED & CONFIRMED BY USER (18/10/2026)  
> **Providers:** `qwen-web`  
> **Keywords:** `HTTP 400`, `provider is invalid`, `notifyLauncherTurn`, `control-server`

## ⚡ TL;DR (AI Đọc Nhanh 5 Giây)
- **Triệu chứng:** Client báo `stream disconnected before completion: [qwen-adapter] Không thể kết nối với Launcher browser tab`. Terminal Launcher báo `HTTP 400: provider is invalid`.
- **Nguyên nhân:** Whitelist provider trên Control Server của Launcher chỉ chấp nhận `chatgpt`, `m365`, `gemini`, chưa cho phép `qwen`.
- **Giải pháp:** Bổ sung `"qwen"` vào danh sách kiểm tra provider hợp lệ trên cả Control Server và BrowserHost.

## 🛠️ File Sửa & Quy Tắc Cốt Lõi
- `launcher/electron/control-server.cjs` (dòng ~184):
  ```javascript
  if (body.provider !== undefined && body.provider !== "chatgpt" && body.provider !== "m365" && body.provider !== "gemini" && body.provider !== "qwen") {
    throw new Error("provider is invalid");
  }
  ```
- `launcher/electron/browser-host.cjs` (dòng ~2814):
  ```javascript
  if (provider !== "chatgpt" && provider !== "m365" && provider !== "gemini" && provider !== "qwen") {
    throw new Error("Browser turn provider is invalid");
  }
  ```
