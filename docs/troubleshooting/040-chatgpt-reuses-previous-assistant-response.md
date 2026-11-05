# 040: ChatGPT tự dừng và trả lại phản hồi cũ

## ⚡ TL;DR
- **Triệu chứng:** Prompt mới đã xuất hiện trên ChatGPT Web nhưng generation tự dừng; Codex tiếp tục chờ hoặc nhận lại câu trả lời của lượt trước.
- **Nguyên nhân gốc rễ:** Worker vừa đọc assistant message cũ do không khóa DOM baseline, vừa phát nhiều hành động submit liên tiếp khiến control Send có thể đổi thành Stop giữa chuỗi sự kiện.
- **Cách sửa:** Chỉ đọc assistant turn mới vượt baseline và chỉ phát đúng một lần click Send; Enter chỉ dùng làm fallback nếu click thất bại.

## Trạng thái
✅ Đã Confirm

## Phân tích ảnh

- Codex hiển thị lại nguyên phản hồi cũ: “Chào bạn! ... test-7-todo ...” sau prompt yêu cầu tạo trang todo.
- Launcher cho thấy prompt mới đã được gửi vào đúng conversation ChatGPT.
- ChatGPT Web chưa có assistant response mới bên dưới prompt đó.
- Vì vậy lỗi nằm ở response tracking của browser worker, không nằm ở `WebTurnEngine`, conversation binding hoặc prompt submission.

## Nguyên nhân kỹ thuật

Việc các adapter cùng kế thừa `WebProviderAdapter` chỉ đồng nhất phần điều phối:

- acquire/release Launcher surface;
- conversation state;
- protocol retry;
- emit tool call và final answer.

Mỗi provider vẫn có DOM worker riêng. `ChatGptBrowserWorker` có hai lỗi độc lập:

### Lỗi 1: Đọc nhầm response cũ

1. Worker đọc assistant message cuối cùng của toàn conversation, kể cả message có từ trước khi submit.
2. Worker xem `Start Voice` hoặc `Copy code` tồn tại khi nút Stop không có là tín hiệu hoàn tất.
3. `Start Voice` là control thường trực ở composer, nên điều kiện có thể đúng ngay khi response mới chưa bắt đầu.
4. Sau 2 giây text cũ không đổi, worker kết luận stream đã ổn định và trả lại response cũ.

### Lỗi 2: Submit nhiều lần làm generation tự dừng

1. Worker click nút Send bằng Playwright.
2. Ngay sau đó worker tiếp tục tìm selector, phát `pointerdown`, `mousedown`, `pointerup`, `mouseup`, gọi `click()` và `requestSubmit()`.
3. ChatGPT thay đổi control composer rất nhanh sau lần click đầu tiên; chuỗi thao tác thừa có thể tác động khi UI đã chuyển sang trạng thái generation.
4. Kết quả quan sát thực tế là ChatGPT dừng generation còn Codex vẫn chờ response mới.

## Phạm vi sửa

- `src/adapters/chatgpt-web/chatgpt-browser-worker.ts`
  - Chụp `initialAssistantCount` trước khi nhập và gửi prompt.
  - Không trả text nếu DOM chưa có assistant message mới vượt baseline.
  - Không dùng `Start Voice` làm bằng chứng hoàn tất.
  - Chỉ chấp nhận `Copy code` nằm trong assistant turn mới.
  - Idle stabilization cũng chỉ quan sát assistant turn mới.
  - Loại bỏ toàn bộ chuỗi dispatch DOM và `requestSubmit()` sau Playwright click.
  - Mỗi attempt chỉ click Send đúng một lần; chỉ nhấn Enter khi click Send thật sự thất bại.

## Kiểm chứng tự động

```bash
bun test \
  tests/chatgpt-web-adapter.test.ts \
  tests/chatgpt-conversation-store.test.ts \
  tests/chatgpt-web-markdown.test.ts \
  tests/chatgpt-web-models.test.ts
```

Kết quả: `26 pass`, `0 fail`.

Kiểm tra TypeScript riêng file worker và `git diff --check` đều đạt.

## User test

1. Khởi động lại runtime/Launcher để nạp source mới.
2. Mở một conversation ChatGPT đã có ít nhất một assistant response.
3. Gửi yêu cầu mới có thời gian xử lý dài, ví dụ tạo một trang HTML/CSS/JS hoàn chỉnh.
4. Trong lúc ChatGPT chưa sinh assistant turn mới, Codex phải tiếp tục chờ và không được trả response cũ.
5. Trong lúc ChatGPT đang generation, nút Stop phải duy trì cho đến khi ChatGPT tự hoàn tất; worker không được làm generation dừng giữa chừng.
6. Khi assistant turn mới hoàn tất, Codex phải nhận đúng nội dung mới.
7. Gửi tiếp một prompt trong cùng conversation để xác nhận baseline được cập nhật theo từng turn.
