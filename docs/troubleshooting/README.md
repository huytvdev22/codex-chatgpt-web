# Tra Cứu Nhanh Lỗi Đã Xử Lý (AI Quick Troubleshooting Index)

> Thư mục này lưu trữ các lỗi đã xử lý và đã được user confirm. 
> Định dạng tối ưu cho AI đọc nhanh (TL;DR 3-5 dòng đầu). Trước khi sửa lỗi tương tự, tra cứu nhanh bảng dưới đây.

| ID | Vấn đề / Lỗi | Providers | Trạng thái | File chi tiết |
| :--- | :--- | :--- | :--- | :--- |
| **008** | Electron tích lũy Renderer và sử dụng hơn 2 GB RAM | `launcher`, `electron` | ⏳ Chờ User Test & Confirm | [008-electron-renderer-memory-lifecycle.md](./008-electron-renderer-memory-lifecycle.md) |
| **001** | Mỗi tin nhắn trên Codex tạo 1 đoạn chat mới trên Web | `qwen-web`, `chatgpt-web` | ✅ Đã Confirm | [001-multi-turn-creates-new-chat.md](./001-multi-turn-creates-new-chat.md) |
| **002** | HTTP 400: provider is invalid khi kết nối Launcher | `qwen-web` | ✅ Đã Confirm | [002-launcher-invalid-provider.md](./002-launcher-invalid-provider.md) |
| **003** | Launcher browser partition không hợp lệ cho Qwen | `qwen-web` | ✅ Đã Confirm | [003-launcher-browser-partition.md](./003-launcher-browser-partition.md) |
| **004** | Release verify gate thất bại do check-version và test suite cũ | `core`, `ci/cd` | ✅ Đã Confirm | [004-release-verify-gate-failure.md](./004-release-verify-gate-failure.md) |
| **005** | Rơi rụng chỉ dẫn AGENTS.md khi gửi sang ChatGPT Web và M365 Copilot | `core`, `prompt` | ✅ Đã Confirm | [005-agents-md-instructions-dropped.md](./005-agents-md-instructions-dropped.md) |
| **006** | Lệnh vi phạm SafeCommandGuard làm sập SSE stream và gây lặp kết quả cũ Chunk ID | `m365-copilot`, `core` | ⏳ Chờ User Test & Confirm | [006-m365-safe-command-stream-disconnect.md](./006-m365-safe-command-stream-disconnect.md) |
| **007** | bun run launcher:audit thất bại do lỗ hổng bảo mật mới trong vite <= 6.4.3 | `launcher`, `ci/cd` | ✅ Đã Confirm | [007-launcher-audit-vite-vulnerability.md](./007-launcher-audit-vite-vulnerability.md) |

