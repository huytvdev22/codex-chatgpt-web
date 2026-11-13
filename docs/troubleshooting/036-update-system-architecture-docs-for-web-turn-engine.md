# 036: Cập nhật tài liệu `docs/system-architecture.md` phản ánh kiến trúc `WebTurnEngine` và 7 file đặc thù của M365

## ⚡ TL;DR
- **Triệu chứng:** `docs/system-architecture.md` vẫn mô tả trạng thái chuyển tiếp trước refactor ("Giai đoạn này chỉ thay đổi ownership... Browser orchestration, provider lifecycle... vẫn thuộc từng provider" và `src/adapters/m365-copilot/translation/`).
- **Nguyên nhân gốc rễ:** Sau các lát cắt nguyên tử chuẩn hóa các Web Provider về `WebProviderAdapter` -> `WebTurnEngine` và tinh gọn `m365-copilot` về 7 file, tài liệu kiến trúc tổng thể cần được đồng bộ trong một commit tài liệu độc lập.
- **Cách sửa:** Cập nhật các mục 3.5, 3.7, 3.17, 5 và 6 trong `docs/system-architecture.md` để phản ánh chính xác kiến trúc `ProviderAdapter -> WebProviderAdapter -> WebTurnEngine -> WebProviderDefinition`, `runtime-lifecycle.ts`, `conversation/`, `execution/`, `harness/`, 7 file đặc thù của M365 và ngoại lệ `manageLauncherLeaseInEngine: false`.

## Phạm vi thay đổi
- `docs/system-architecture.md`:
  - Mục 3.5 & 5.2: Sơ đồ luồng `ProviderAdapter.runTurn() -> WebProviderAdapter.runTurn() -> WebTurnEngine.runTurn()`.
  - Mục 3.7 & 6.2: Luồng thực thi M365 qua `WebTurnEngine`, danh sách đúng 7 file đặc thù trong `src/adapters/m365-copilot/` và ghi chú kiến trúc về lease theo attempt (`manageLauncherLeaseInEngine: false`).
  - Mục 3.17 & 6.1: Bảng ánh xạ module mới (`engine.ts`, `definition.ts`, `runtime-lifecycle.ts`, `conversation/`, `execution/`, `harness/`).
  - Mục 6.3: Mô tả cấu trúc tinh gọn của `chatgpt-web`.

## Kết quả xác minh
- `git diff --check`: Pass.
- `bun run check:architecture`: Pass (`4 pass, 0 fail`).

## Trạng thái
✅ Đã Confirm
