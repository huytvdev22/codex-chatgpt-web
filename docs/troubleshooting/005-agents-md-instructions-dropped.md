# Lỗi 005: Rơi rụng chỉ dẫn AGENTS.md khi gửi sang ChatGPT Web và M365 Copilot

## ⚡ TL;DR
- **Triệu chứng**: Dự án có file `AGENTS.md` nhưng tin nhắn prompt gửi sang ChatGPT Web hoặc M365 Copilot không chứa mục quy ước dự án `[Một số quy ước làm việc trong dự án của mình]`.
- **Nguyên nhân gốc rễ**: Codex Client đóng gói `AGENTS.md` trong message `role: "user"` (kẹp chung với `<environment_context>` và metadata `agents_md.instructions`), nhưng `CodexPayloadNormalizer` chỉ trích xuất `developerInstructions` khi `role === "developer"` và `isInternalSystemMessage()` đánh dấu toàn bộ tin nhắn là hệ thống nội bộ rồi bỏ qua (`continue;`).
- **Cách sửa**: 
  1. Trong `CodexPayloadNormalizer.normalize()`: Bổ sung regex bóc tách khối thẻ `<INSTRUCTIONS>([\s\S]*?)<\/INSTRUCTIONS>` và `# AGENTS.md instructions` từ mọi tin nhắn (kể cả `user`, `developer`, preamble) nạp vào `developerInstructions`.
  2. Trong `isInternalSystemMessage()`: Bổ sung nhận diện `agents_md.instructions` và `# AGENTS.md instructions` để không đưa preamble vào `priorHistory`.
  3. Trong `M365PromptCompiler`: Tinh chỉnh cách format `developerRulesText` để bảo toàn cấu trúc Markdown nhiều dòng và danh sách.

---

## Chi Tiết Kỹ Thuật

- **File cập nhật**:
  - `src/adapters/m365-copilot/normalization/codex-normalizer.ts`: Bóc tách `<INSTRUCTIONS>` và tiêu đề `AGENTS.md instructions`, cập nhật `isInternalSystemMessage()`.
  - `src/adapters/m365-copilot/prompts/compiler.ts`: Cập nhật `sanitizeCodexInstructions()` và cách render `developerRulesText`.
  - `tests/m365-agents-instructions.test.ts`: Thêm bài test kiểm thử hồi quy cho payload thực tế.
- **Trạng thái**: ✅ Đã Confirm
