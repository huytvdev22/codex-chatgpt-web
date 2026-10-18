# [ISSUE-003] Launcher Browser Partition Không Hợp Lệ Cho Qwen

> **Status:** ✅ RESOLVED & CONFIRMED BY USER (18/10/2026)  
> **Providers:** `qwen-web`  
> **Keywords:** `partition`, `persist:codex-web-gpt-qwen`, `browser partition`, `browser-helper`

## ⚡ TL;DR (AI Đọc Nhanh 5 Giây)
- **Triệu chứng:** Launcher báo lỗi `Launcher browser descriptor identifies an unexpected browser partition` khi helper cố gắng kết nối CDP tới session Qwen.
- **Nguyên nhân:** Danh sách `allowedPartitions` trong `src/launcher-browser-host.ts` chỉ có ChatGPT và M365, chưa có `persist:codex-web-gpt-qwen`.
- **Giải pháp:** Thêm `persist:codex-web-gpt-qwen` vào `allowedPartitions` và chạy build lại `.launcher-runtime/browser-helper.cjs`.

## 🛠️ File Sửa & Quy Tắc Cốt Lõi
- `src/launcher-browser-host.ts`:
  ```typescript
  const allowedPartitions = new Set([
    "persist:codex-web-gpt-chatgpt",
    "persist:codex-m365-copilot",
    "persist:codex-web-gpt-qwen",
  ]);
  ```
- Build helper: `bun run scripts/build-browser-helper.ts` (sinh file `.launcher-runtime/browser-helper.cjs`).
