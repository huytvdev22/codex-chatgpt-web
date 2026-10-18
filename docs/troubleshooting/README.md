# Tra Cứu Nhanh Lỗi Đã Xử Lý (AI Quick Troubleshooting Index)

> Thư mục này lưu trữ các lỗi đã xử lý và đã được user confirm. 
> Định dạng tối ưu cho AI đọc nhanh (TL;DR 3-5 dòng đầu). Trước khi sửa lỗi tương tự, tra cứu nhanh bảng dưới đây.

| ID | Vấn đề / Lỗi | Providers | Trạng thái | File chi tiết |
| :--- | :--- | :--- | :--- | :--- |
| **001** | Mỗi tin nhắn trên Codex tạo 1 đoạn chat mới trên Web | `qwen-web`, `chatgpt-web` | ✅ Đã Confirm | [001-multi-turn-creates-new-chat.md](./001-multi-turn-creates-new-chat.md) |
| **002** | HTTP 400: provider is invalid khi kết nối Launcher | `qwen-web` | ✅ Đã Confirm | [002-launcher-invalid-provider.md](./002-launcher-invalid-provider.md) |
| **003** | Launcher browser partition không hợp lệ cho Qwen | `qwen-web` | ✅ Đã Confirm | [003-launcher-browser-partition.md](./003-launcher-browser-partition.md) |
| **004** | Release verify gate thất bại do check-version và test suite cũ | `core`, `ci/cd` | ✅ Đã Confirm | [004-release-verify-gate-failure.md](./004-release-verify-gate-failure.md) |
