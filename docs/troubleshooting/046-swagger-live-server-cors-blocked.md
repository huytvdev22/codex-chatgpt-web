# 046 - Mở `docs/swagger.html` bằng VS Code Live Server bị lỗi CORS Network Failure

> **Trạng thái:** ⏳ Chờ User Test & Confirm

## ⚡ TL;DR
- **Triệu chứng:** Mở [docs/swagger.html](../../docs/swagger.html) qua VS Code Live Server (`http://127.0.0.1:5500`) và bấm Execute gặp lỗi `CORS Network Failure`.
- **Nguyên nhân gốc rễ:** [src/server.ts](../../src/server.ts) chưa xử lý `OPTIONS` preflight và chưa trả header `Access-Control-Allow-Origin` cho các origin loopback khác port (như `:5500` → `:17841`).
- **Cách sửa:** Thêm `applyLoopbackCors` và xử lý `OPTIONS` preflight (`204`) trong `startServer()` tại [src/server.ts](../../src/server.ts) chỉ cho phép các origin loopback (`localhost`, `127.0.0.1`, `[::1]`).
