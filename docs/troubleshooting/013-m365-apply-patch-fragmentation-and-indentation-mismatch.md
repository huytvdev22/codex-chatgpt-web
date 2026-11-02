# Lỗi 013: M365 Copilot sinh patch vụn vặt và lệch thụt lề dẫn đến apply_patch +0 -0 và vòng lặp vô tận

## ⚡ TL;DR
- **Triệu chứng**: Giao diện Codex hiển thị `Edited file <file> +0 -0` liên tục nhiều lần; model M365 bị kẹt trong vòng lặp agent lặp lại các patch hỏng tương tự cho đến khi người dùng phải bấm dừng sau hơn 1 phút; file trên đĩa vẫn còn nguyên lỗi cú pháp TypeScript.
- **Nguyên nhân gốc rễ**: Model tự ý phân mảnh một vùng sửa đổi gần nhau thành 4-5 hunk `@@` lắt nhắt; mức thụt lề sâu (36-40 spaces) trong TSX khiến tokenizer làm rụng ký tự đầu dòng (ví dụ `ource:` thay vì `source:`) và lệch số khoảng trắng context line, khiến engine `apply_patch` của Codex từ chối patch (context mismatch) hoặc các hunk rỗng (`- {` / `+ {`) tạo diff rỗng +0 -0.
- **Cách sửa**: Bổ sung các chỉ dẫn cốt lõi vào prompt hệ thống M365 Copilot (`templates.ts` & `compiler.ts`):
  1. **Nguyên tắc gộp hunk**: Bắt buộc gộp các thay đổi gần nhau vào đúng 1 hunk `@@` duy nhất bao bọc toàn bộ khối thay đổi, cấm chia vụn vặt lắt nhắt.
  2. **Bảo toàn thụt lề và ký tự**: Bắt buộc giữ đúng 100% khoảng trắng thụt lề và không để rụng ký tự đầu dòng context.
  3. **Clean Code trong JSX/TSX**: Khuyến khích tách logic cập nhật object thành hàm helper riêng thay vì lồng 5-6 tầng ngoặc inline trong JSX.
  4. **Self-Verification**: Hướng dẫn model chủ động chạy lệnh kiểm tra cú pháp (`npm run typecheck` / `tsc --noEmit`) sau khi patch.

---

## Chi tiết kỹ thuật

- **File cập nhật**:
  - `src/adapters/m365-copilot/prompts/templates.ts`
  - `src/adapters/m365-copilot/prompts/compiler.ts`
- **Thay đổi cụ thể**:
  - Trong `templates.ts`:
    - Mục `3. Khi bạn tạo mới hoặc chỉnh sửa file (Sử dụng apply_patch)`: Bổ sung các quy tắc "NGUYÊN TẮC GỘP HUNK", "BẢO TOÀN THỤT LỀ & DÒNG NGỮ CẢNH", "CLEAN CODE TRONG JSX/TSX".
    - `IMPLEMENT_PLAN_PROMPT`: Thêm hướng dẫn gộp hunk khi implement plan và tự động chạy test kiểm tra kiểu (`tsc --noEmit`).
    - `TOOL_REMINDER_PROMPT`: Nhắc nhở gộp hunk và chạy test sau khi sửa file mã nguồn.
  - Trong `compiler.ts`:
    - Cập nhật ghi chú của `Mẫu 2: Sửa file bằng apply_patch` để model luôn ưu tiên gộp 1 hunk duy nhất.
- **Kiểm thử**:
  - `bun x tsc --noEmit src/adapters/m365-copilot/prompts/templates.ts src/adapters/m365-copilot/prompts/compiler.ts`: Exit code 0 (sạch typecheck).
  - `bun test tests/m365-prompt-strategy.test.ts tests/prompt-strategy.test.ts tests/m365-plan-mode.test.ts`: Pass 100%.
- **Trạng thái**: ✅ Đã Confirm

