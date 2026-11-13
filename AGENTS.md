# Quy Tắc Hoạt Động Của Agent (Agent Guidelines)

1. **Tra cứu trước khi sửa:** Luôn kiểm tra thư mục `docs/troubleshooting/` để xem tiền sử lỗi tương tự trước khi điều tra hoặc viết code.
2. **Ghi chép sau khi fix:** Mỗi khi sửa xong một lỗi, BẮT BUỘC tạo file `docs/troubleshooting/XXX-<tên-lỗi>.md` và cập nhật vào `docs/troubleshooting/README.md`.
3. **Định dạng tối ưu cho AI:** Viết cực ngắn gọn, súc tích để AI đọc nhanh (tập trung mục `⚡ TL;DR` 3 dòng: Triệu chứng, Nguyên nhân gốc rễ, Cách sửa).
4. **Quy trình xác nhận:** Đặt trạng thái ban đầu là `⏳ Chờ User Test & Confirm`; chỉ đổi sang `✅ Đã Confirm` khi user phản hồi xác nhận.
5. **Ngôn ngữ & Môi trường:** Luôn phản hồi, lên plan và commit bằng Tiếng Việt; chỉ dùng Node.js/Bun (máy user không có Python).
6. **Tư duy phản biện & Chủ động làm rõ:** Không làm theo lệnh một cách máy móc. Nếu yêu cầu còn mơ hồ, mâu thuẫn với kiến trúc/quy tắc hiện tại, hoặc có hướng thiết kế/kỹ thuật tối ưu hơn rõ rệt, hãy chủ động hỏi lại hoặc phản biện thẳng thắn kèm lý do cụ thể và phương án đề xuất trước khi sửa code.
7. **Kiến trúc OOP thực dụng (Pragmatic Java-style OOP):**
   - **Tổ chức file:** Mỗi class nghiệp vụ/service/provider nằm trong 1 file riêng, đặt tên file khớp với tên class (`kebab-case`). Các file `types.ts`, constants, entrypoint (`main`/`preload`), cấu hình hoặc pure helper nhỏ không cần ép bọc thành class.
   - **Dùng `abstract class` đúng chỗ:** Ưu tiên dùng `abstract class` + Template Method/Strategy (tương tự `BaseModelProvider`) khi có nhiều implementation chia sẻ khung xử lý chung, đóng gói rõ `private`/`protected`/`public`.
   - **Tránh OOP cực đoan:** Không tạo `abstract class`, interface 1-1 hay pattern cầu kỳ khi chỉ có 1 implementation duy nhất hoặc khi một function/type đơn giản giải quyết gọn hơn.

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