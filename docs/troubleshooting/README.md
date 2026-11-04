# Tra Cứu Nhanh Lỗi Đã Xử Lý (AI Quick Troubleshooting Index)

> Thư mục này lưu trữ các lỗi đã xử lý và đã được user confirm. 
> Định dạng tối ưu cho AI đọc nhanh (TL;DR 3-5 dòng đầu). Trước khi sửa lỗi tương tự, tra cứu nhanh bảng dưới đây.

| ID | Vấn đề / Lỗi | Providers | Trạng thái | File chi tiết |
| :--- | :--- | :--- | :--- | :--- |
| **020** | Gom mã nguồn catalog và registry model vào thư mục `src/models/` | `core`, `catalog`, `all-providers` | ⏳ Chờ User Test & Confirm | ./020-group-model-management-files.md |
| **019** | Google AI Studio gửi tin nhắn thứ 2 mở new chat thay vì tiếp tục hội thoại và bị Permission Denied | `google-ai-studio`, `launcher`, `electron`, `playwright` | ⏳ Chờ User Test & Confirm | [019-google-ai-studio-multi-turn-creates-new-chat-and-permission-denied.md](./019-google-ai-studio-multi-turn-creates-new-chat-and-permission-denied.md) |
| **018** | Google AI Studio trả về khối code block dính tiền tố rác và lộ thẻ XML trực tiếp | `google-ai-studio`, `playwright`, `m365-copilot-protocol` | ⏳ Chờ User Test & Confirm | [018-google-ai-studio-raw-xml-codeblock-and-quarantine-leak.md](./018-google-ai-studio-raw-xml-codeblock-and-quarantine-leak.md) |
| **017** | Triển khai adapter mới Google AI Studio kế thừa chuẩn M365 Copilot | `google-ai-studio`, `launcher`, `electron` | ⏳ Chờ User Test & Confirm | [017-google-ai-studio-adapter-integration.md](./017-google-ai-studio-adapter-integration.md) |
| **016** | Tự động lưu raw request vào thư mục `scratch` | `server`, `privacy`, `filesystem` | ⏳ Chờ User Test & Confirm | ./016-remove-raw-request-scratch-dump.md |
| **015** | M365 đóng/mở tab liên tục gây bootstrap timeout `Browser idle document did not commit within 10000ms` | `launcher`, `m365-copilot`, `electron` | ✅ Đã Confirm | ./015-m365-tab-churn-bootstrap-timeout.md |
| **014** | GitHub Actions release thất bại do lỗ hổng bảo mật mới trong vite và minimatch | `launcher`, `ci/cd` | ⏳ Chờ User Test & Confirm | [014-launcher-audit-vite-and-minimatch-vulnerability.md](./014-launcher-audit-vite-and-minimatch-vulnerability.md) |
| **013** | M365 Copilot sinh patch vụn vặt và lệch thụt lề dẫn đến apply_patch +0 -0 | `m365-copilot`, `prompts`, `patch` | ✅ Đã Confirm | [013-m365-apply-patch-fragmentation-and-indentation-mismatch.md](./013-m365-apply-patch-fragmentation-and-indentation-mismatch.md) |
| **012** | Final answer nhắc cú pháp tool bị nhận nhầm mixed content và batch read bị chặn | `m365-copilot`, `parser`, `tools` | ✅ Đã Confirm | [012-inline-control-syntax-false-positive.md](./012-inline-control-syntax-false-positive.md) |
| **011** | Lệnh quét đệ quy bị từ chối và giới hạn đọc file làm giảm quyền tự chủ của model | `m365-copilot`, `prompts`, `tools` | ⏳ Chờ User Test & Confirm | [011-unblock-recursive-scan-and-relax-file-limits.md](./011-unblock-recursive-scan-and-relax-file-limits.md) |
| **010** | Final answer nhắc cú pháp response envelope bị nhận nhầm là nhiều envelope | `m365-copilot`, `parser` | ⏳ Chờ User Test & Confirm | [010-m365-final-answer-envelope-false-positive.md](./010-m365-final-answer-envelope-false-positive.md) |
| **009** | Mở app trên Windows mất 5–6 phút không hiện cửa sổ và không có thông báo tiến trình | `launcher`, `electron`, `windows` | ✅ Đã Confirm | [009-windows-slow-startup-and-no-loading-ui.md](./009-windows-slow-startup-and-no-loading-ui.md) |
| **008** | Electron tích lũy Renderer và sử dụng hơn 2 GB RAM | `launcher`, `electron` | ⏳ Chờ User Test & Confirm | [008-electron-renderer-memory-lifecycle.md](./008-electron-renderer-memory-lifecycle.md) |
| **001** | Mỗi tin nhắn trên Codex tạo 1 đoạn chat mới trên Web | `qwen-web`, `chatgpt-web` | ✅ Đã Confirm | [001-multi-turn-creates-new-chat.md](./001-multi-turn-creates-new-chat.md) |
| **002** | HTTP 400: provider is invalid khi kết nối Launcher | `qwen-web` | ✅ Đã Confirm | [002-launcher-invalid-provider.md](./002-launcher-invalid-provider.md) |
| **003** | Launcher browser partition không hợp lệ cho Qwen | `qwen-web` | ✅ Đã Confirm | [003-launcher-browser-partition.md](./003-launcher-browser-partition.md) |
| **004** | Release verify gate thất bại do check-version và test suite cũ | `core`, `ci/cd` | ✅ Đã Confirm | [004-release-verify-gate-failure.md](./004-release-verify-gate-failure.md) |
| **005** | Rơi rụng chỉ dẫn AGENTS.md khi gửi sang ChatGPT Web và M365 Copilot | `core`, `prompt` | ✅ Đã Confirm | [005-agents-md-instructions-dropped.md](./005-agents-md-instructions-dropped.md) |
| **006** | Lệnh vi phạm SafeCommandGuard làm sập SSE stream và gây lặp kết quả cũ Chunk ID | `m365-copilot`, `core` | ⏳ Chờ User Test & Confirm | [006-m365-safe-command-stream-disconnect.md](./006-m365-safe-command-stream-disconnect.md) |
| **007** | bun run launcher:audit thất bại do lỗ hổng bảo mật mới trong vite <= 6.4.3 | `launcher`, `ci/cd` | ✅ Đã Confirm | [007-launcher-audit-vite-vulnerability.md](./007-launcher-audit-vite-vulnerability.md) |
