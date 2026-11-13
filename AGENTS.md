# Quy Tắc Hoạt Động Của Agent (Agent Guidelines)

1. **Tra cứu trước khi sửa:** Luôn kiểm tra thư mục `docs/troubleshooting/` để xem tiền sử lỗi tương tự trước khi điều tra hoặc viết code.
2. **Ghi chép sau khi fix:** Mỗi khi sửa xong một lỗi, BẮT BUỘC tạo file `docs/troubleshooting/XXX-<tên-lỗi>.md` và cập nhật vào `docs/troubleshooting/README.md`.
3. **Định dạng tối ưu cho AI:** Viết cực ngắn gọn, súc tích để AI đọc nhanh (tập trung mục `⚡ TL;DR` 3 dòng: Triệu chứng, Nguyên nhân gốc rễ, Cách sửa).
4. **Quy trình xác nhận:** Đặt trạng thái ban đầu là `⏳ Chờ User Test & Confirm`; chỉ đổi sang `✅ Đã Confirm` khi user phản hồi xác nhận.
5. **Ngôn ngữ & Môi trường:** Luôn phản hồi, lên plan và commit bằng Tiếng Việt; chỉ dùng Node.js/Bun (máy user không có Python).

## Electron Development Guidelines

This project is an Electron desktop application.

For tasks involving Renderer Process, HTML, CSS,
client-side JavaScript, UI, animations, accessibility,
or browser performance:
- Use the modern-web-guidance skill when relevant.
- Prefer modern native Chromium APIs when appropriate.
- Verify compatibility with the Chromium version
  bundled in this project's Electron version.
- Avoid unnecessary polyfills and dependencies.

For Electron Main Process, Preload, IPC, Node.js,
filesystem, SQLite, and background automation:
- Follow Electron-specific best practices.
- Do not force modern-web-guidance for these tasks.

Always preserve Electron security boundaries,
including contextIsolation and IPC restrictions.
