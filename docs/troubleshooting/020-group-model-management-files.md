# 020 - Gom mã nguồn quản lý model vào `src/models`

## ⚡ TL;DR
- **Triệu chứng:** Các registry và catalog model nằm rải rác ở thư mục `src/`, khó nhận biết phạm vi quản lý model.
- **Nguyên nhân gốc rễ:** Chưa có module/folder chuyên trách cho model catalog và model route của từng provider.
- **Cách sửa:** Chuyển toàn bộ 6 file quản lý model vào `src/models/` và cập nhật tất cả import trong source, scripts, tests.

## Trạng thái

⏳ Chờ User Test & Confirm

## Luồng bắt đầu từ `/v1/models`

1. `server.ts` nhận `GET /v1/models`.
2. Server kiểm tra trạng thái draining và theo dõi request bằng `httpTurns`.
3. Server chuẩn hóa `subagentProtocol`.
4. `modelsRequest()` lấy catalog native từ upstream hoặc fallback.
5. `augmentNativeModelCatalog()` ghép model native với route của các Web provider.
6. Catalog cuối cùng được ghi vào `catalog.json` và trả về Codex.

## Cấu trúc mới

```text
src/models/
├── model-catalog.ts
├── model-registry.ts
├── chatgpt-web-models.ts
└── m365-models.ts
```

## Phạm vi thay đổi

- Di chuyển 6 file bằng `git mv` để giữ lịch sử Git.
- Cập nhật import trong `src/`, `scripts/` và `tests/`.
- Không thay đổi logic catalog hoặc model route.

## Xác minh

- Không còn import tới đường dẫn model cũ.
- `git diff --check` thành công.
- TypeScript toàn dự án chưa sạch do nhiều lỗi có sẵn ở các module ChatGPT Web và test cũ, không phát sinh từ việc di chuyển model.
