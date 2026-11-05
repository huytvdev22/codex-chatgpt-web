# 037: Cập nhật tài liệu SOP `docs/adding-new-web-adapter-guide.md` theo kiến trúc `WebTurnEngine`

## ⚡ TL;DR
- **Triệu chứng:** SOP cũ hướng dẫn điều phối trái kiến trúc mới; bản cập nhật đầu tiên còn nhắc API không tồn tại `deriveStableConversationKey`, mô tả lifecycle quá tuyệt đối và thiếu browser contract, policy, integration scope cùng quality gates.
- **Nguyên nhân gốc rễ:** Sau chuỗi refactor `WebTurnEngine` (`022`–`036`), tài liệu chưa được đối chiếu đầy đủ với `definition.ts`, `runtime-lifecycle.ts`, năm provider facade và trạng thái baseline kiểm thử thực tế.
- **Cách sửa:** Đồng bộ SOP với contract đang chạy: dùng `buildWebConversationKey`, ghi rõ ngoại lệ M365, bổ sung browser fields/policies, phân biệt chiến lược extraction khuyến nghị và contract bắt buộc, mở rộng integration scope cùng checklist kiểm chứng nhiều tầng.

## Phạm vi thay đổi
- `docs/adding-new-web-adapter-guide.md`:
  - Cập nhật luồng chuẩn: khảo sát DOM -> viết `browser-worker.ts` & `capability-picker.ts` -> dùng `GenericConversationStore` -> khai báo `WebProviderDefinition` & `WebProviderPolicies` -> kế thừa `WebProviderAdapter`.
  - Bổ sung quy trình tích hợp thực tế gồm 6 bước: khảo sát giao diện, tạo provider adapter, khai báo contract dùng chung, đăng ký hệ thống, kiểm chứng trên giao diện thật và bổ sung test.
  - Yêu cầu user đăng nhập và mở giao diện provider để khảo sát selector bằng DevTools; ưu tiên `data-testid`, `aria-label`, `role` và cấu trúc semantic, tránh class CSS sinh động hoặc selector phụ thuộc vị trí.
  - Liệt kê các thành phần giao diện cần xác định: URL hội thoại, composer, nút gửi/dừng, vùng phản hồi, trạng thái streaming, model/reasoning picker và khu vực upload.
  - Yêu cầu kiểm tra selector ở nhiều trạng thái UI và không đưa cookie, access token, nội dung hội thoại hoặc thông tin đăng nhập vào mã nguồn.
  - Thay API không tồn tại `deriveStableConversationKey` bằng `buildWebConversationKey` hoặc hàm conversation-key đặc thù provider.
  - Ghi rõ M365 là ngoại lệ tham chiếu được phép tự quản lý Launcher lifecycle qua `manageLauncherLeaseInEngine: false`.
  - Bổ sung browser contract: `launcherProviderId`, `connectorIdentity`, `descriptorPath`, `descriptorSubdirs`, `resolveSurfaceId`.
  - Bổ sung đầy đủ Lifecycle & Error Policies (`launcherFailureMode`, `manageLauncherLeaseInEngine`, `closeLauncherConnectionOnEnd`, `emitErrorEventOnFailure`, `rethrowError`, `errorMessagePrefix`, `abortedTurnMessage`, `maxFormatRetries`, `enableEarlyExitOnFinalAnswer`, `enableToolLoopGuard`, `traceIdOptions`).
  - Thay thế hoàn toàn các tên compatibility cũ (`parseStrictM365Response`, `M365ToolBridge`) bằng API trung lập chuẩn (`parseStrictWebResponse`, `WebToolBridge`, `WebProtocolErrorCode`, `StrictWebResponseResult`).
  - Cập nhật đường dẫn đăng ký model sang `src/models/model-registry.ts` và `src/models/model-catalog.ts`.
  - Chuyển Copy-button salvage thành chiến lược khuyến nghị, không coi là contract bắt buộc của mọi provider.
  - Đổi phạm vi tích hợp từ “chỉ 4 điểm” thành “ít nhất 4 nhóm”, có thể gồm Launcher UI, descriptor, setup/login, model selection, export và fixtures.
  - Bổ sung checklist kiểm thử theo tầng: `git diff --check`, architecture gate, contract tests, typecheck, full test và build; không coi architecture gate xanh là bằng chứng toàn repository đã xanh.

## Kết quả xác minh
- `git diff --check`: Pass.
- Nội dung đã được đối chiếu với `src/adapters/web/definition.ts`, `runtime-lifecycle.ts`, `engine.ts`, `web-provider-adapter.ts` và năm provider facade.
- `bun run check:architecture`: Đã pass ở lần cập nhật ban đầu (`4 pass, 0 fail`); chưa chạy lại sau hiệu chỉnh tài liệu.
- Baseline toàn repository hiện vẫn có lỗi typecheck và full test không liên quan trực tiếp đến thay đổi Markdown; SOP yêu cầu ghi nhận riêng thay vì che giấu lỗi có sẵn.

## Trạng thái
⏳ Chờ User Test & Confirm
