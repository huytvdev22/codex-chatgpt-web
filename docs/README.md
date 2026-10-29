# Tài liệu dự án

> **Status:** Current
> **Last verified:** 2026-10-21
> **Verified against commit:** `059a594`
> **Nguồn sự thật:** Source code, tests và scripts trong `package.json`

## Nguyên tắc

Thứ tự ưu tiên khi tài liệu và implementation khác nhau:

1. Source code đang chạy.
2. Tests và contract tests.
3. Build, release và configuration scripts.
4. Tài liệu có trạng thái `Current`.
5. Kế hoạch, báo cáo đánh giá và historical snapshot.

Tài liệu kiến trúc không được tự nhận là nguồn sự thật cao hơn source code.

## Tài liệu hiện hành

| Tài liệu | Vai trò | Trạng thái | Hành động |
| --- | --- | --- | --- |
| ../README.md | Cài đặt và sử dụng | Current | Kiểm tra theo mỗi release |
| [Kiến trúc tổng thể](architecture.md) | Boundary và runtime chính | Review required | Đối chiếu source trước khi cập nhật |
| [Mô hình bảo mật](security-model.md) | Trust boundary và invariant | Review required | Đối chiếu tests bảo mật |
| [Release validation](release-validation.md) | Quality gate phát hành | Review required | Đồng bộ với `package.json` và CI |
| [DEV chat](dev-chat.md) | Môi trường development cô lập | Review required | Đồng bộ với `src/dev-chat/` |
| [Hướng dẫn Web adapter](adding-new-web-adapter-guide.md) | Mở rộng provider | Current, verify | Kiểm tra bằng contract hiện tại |
| [Build Windows](build-windows.md) | Build launcher trên Windows | Review required | Chạy lại trên môi trường sạch |
| troubleshooting/README.md | Chỉ mục lỗi đã xử lý | Current | Cập nhật sau mỗi bug fix |

## Tài liệu M365 cần phân loại lại

### `m365-copilot-architecture.md`

- **Trạng thái:** Review required.
- Source hiện vẫn có đầy đủ các phân hệ chính như `browser`, `guards`, `harness`,
  `normalization`, `prompts`, `session`, `tools` và `translation`.
- Không được xóa chỉ dựa trên tuổi tài liệu.
- Cần bỏ tuyên bố tài liệu là nguồn sự thật cao hơn source.
- Cần đối chiếu từng public API, dependency rule và request lifecycle với source/tests.
- Sau audit, giữ một bản living architecture ngắn; chuyển nội dung khảo sát dài sang archive.

### `m365-multi-provider-plan.md`

- **Trạng thái:** Historical candidate.
- Đây là kế hoạch, không phải contract hiện hành.
- Nếu nội dung đã triển khai hoặc bị thay thế, chuyển vào `docs/archive/` và ghi commit/ngày.
- Quyết định còn hiệu lực phải được chuyển thành architecture hoặc ADR.

### `codex_m365_engineering_control_assessment_report.md`

- **Trạng thái:** Historical snapshot.
- Đây là báo cáo đánh giá tại một thời điểm, không phải tài liệu vận hành.
- Nên chuyển vào `docs/archive/` với ngày và commit được đánh giá.
- Technical debt còn hiệu lực nên được quản lý bằng issue hoặc backlog riêng.

## Quy tắc trạng thái

Mỗi tài liệu kiến trúc hoặc vận hành nên có metadata:

```text
Status: Current | Review required | Draft | Superseded | Historical
Last verified: YYYY-MM-DD
Verified against commit: <sha>
Source of truth: <source/test paths>
```

Ý nghĩa:

- **Current:** Đã đối chiếu implementation tại commit được ghi.
- **Review required:** Có giá trị tham khảo nhưng chưa được xác minh đầy đủ.
- **Draft:** Đề xuất chưa trở thành contract.
- **Superseded:** Đã có tài liệu thay thế và phải liên kết tới tài liệu đó.
- **Historical:** Snapshot chỉ dùng để tra cứu rationale.

## Quy tắc duy trì

1. Không trộn roadmap vào living architecture.
2. Không đặt tên model hoặc phiên bản dễ thay đổi trong phần kiến trúc nền.
3. Security invariant phải có test hoặc enforcement tương ứng.
4. Dependency rule phải được kiểm tra bằng test/lint nếu có thể.
5. PR thay đổi boundary, public API hoặc lifecycle phải cập nhật docs liên quan.
6. Báo cáo đánh giá phải ghi ngày, commit và trạng thái `Historical`.
7. Không xóa tài liệu có rationale quan trọng trước khi archive.

## Kế hoạch audit

1. Audit `m365-copilot-architecture.md` theo source và M365 tests.
2. Audit `architecture.md` theo server, adapters, launcher và Responses bridge.
3. Đồng bộ `security-model.md` với approval, launcher authorization và MCP lifecycle.
4. Đồng bộ `release-validation.md` với quality gates thực tế.
5. Archive các plan/report sau khi đã tách thông tin còn hiệu lực.

