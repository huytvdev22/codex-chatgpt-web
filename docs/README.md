# Tài liệu dự án

> **Status:** Current
> **Last verified:** 2026-11-05
> **Verified against commit:** `ade242a`
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
| [Hướng dẫn Web adapter](adding-new-web-adapter-guide.md) | Mở rộng provider | Current, verify | Kiểm tra bằng contract hiện tại |
| [Build Windows](build-windows.md) | Build launcher trên Windows | Review required | Chạy lại trên môi trường sạch |
| troubleshooting/README.md | Chỉ mục lỗi đã xử lý | Current | Cập nhật sau mỗi bug fix |

## Tài liệu lịch sử đã loại bỏ

Ngày 2026-11-05, ba tài liệu không còn phản ánh implementation hiện tại đã được xóa:

- `m365-multi-provider-plan.md`: kế hoạch tích hợp đã hoàn thành và bị thay thế bởi source/tests.
- `m365-copilot-architecture.md`: mô tả module, dependency và lifecycle cũ.
- `codex_m365_engineering_control_assessment_report.md`: snapshot kiểm toán chứa observability,
  Trace Explorer và nhiều đường dẫn đã bị xóa.

Git history là nơi tra cứu các tài liệu này khi cần rationale lịch sử. Không khôi phục chúng làm
living documentation nếu chưa đối chiếu lại toàn bộ với implementation hiện hành.

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

1. Audit `architecture.md` theo server, adapters, launcher và Responses bridge.
2. Đồng bộ `security-model.md` với approval, launcher authorization và MCP lifecycle.
3. Đồng bộ `release-validation.md` với quality gates thực tế và local launcher logging.
4. Chuẩn hóa `build-windows.md`, loại bỏ đường dẫn máy cá nhân và version runtime ghi cứng.
5. Kiểm tra định kỳ link tương đối, file reference và metadata xác minh của tài liệu hiện hành.
