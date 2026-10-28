# Lỗi 008: Electron tích lũy Renderer và sử dụng hơn 2 GB RAM

## ⚡ TL;DR
- **Triệu chứng**: Launcher tạo hơn 9 Renderer; RAM tổng vượt 2,1 GB và `renderer-client-id` tăng liên tục.
- **Nguyên nhân gốc rễ**: Bốn provider được tạo và tải ngay khi khởi động; view nền chỉ bị đưa ra ngoài màn hình, không bị detach/destroy; listener cookie có thể được đăng ký lặp.
- **Cách sửa**: Lazy-load provider, destroy renderer provider cũ khi chuyển, đóng triệt để tab, quản lý listener theo session và bật throttling Chromium.

---

## Trạng thái

⏳ Chờ User Test & Confirm

## Nguyên nhân kỹ thuật

### 1. Provider bị tạo đồng loạt

Trước bản sửa, constructor `BrowserHost` tạo ngay bốn `WebContentsView`:

- ChatGPT
- M365 Copilot
- Gemini
- Qwen

Mỗi view được gắn vào `window.contentView`, tạo renderer riêng dù người dùng chưa mở provider.

### 2. View nền vẫn hoạt động

`presentPrimaryView()` và `switchProvider()` trước đây chỉ:

- chuyển view ra ngoài vùng nhìn thấy;
- giữ `setVisible(true)`;
- giữ DOM, JavaScript và renderer sống.

Do đó chuyển provider không làm số tiến trình Renderer giảm.

### 3. Tab turn cần được đóng triệt để

Các turn tab được tạo bằng `WebContentsView` riêng. Đường đóng chuẩn phải:

1. xóa tab khỏi `turnTabs`;
2. clear timer, prompt và waiter;
3. detach khỏi `window.contentView`;
4. gọi `webContents.close()`;
5. xóa reference còn giữ tab.

### 4. Listener xác thực có thể đăng ký lặp

Khi provider được tạo trễ, listener `cookies.changed` có thể bị đăng ký lại. Bản sửa lưu binding theo đối tượng cookie session và gỡ toàn bộ khi `BrowserHost.destroy()`.

## Thay đổi đã áp dụng

### Module lifecycle

File: `launcher/electron/view-lifecycle-manager.cjs`

- Lazy-create một renderer cho provider đang dùng.
- Reuse instance hiện có nếu còn sống.
- Attach/detach view khỏi `BrowserWindow`.
- Hỗ trợ hibernate bằng `setBackgroundThrottling(true)`.
- Hỗ trợ destroy từng provider hoặc toàn bộ.
- Gỡ listener khỏi `webContents` trước khi đóng.

### Tích hợp BrowserHost

File: `launcher/electron/browser-host.cjs`

- Chỉ provider ban đầu được khởi tạo.
- Provider khác chỉ được tạo khi `switchProvider()` được gọi.
- Khi chuyển provider, renderer provider cũ bị destroy và reference được đặt về `null`.
- Cookie listener được quản lý bằng `authenticationCookieBindings`.
- `destroy()` giải phóng toàn bộ provider, turn tab, timer và listener.

### Cờ Chromium

File: `launcher/electron/main.cjs`

- `disable-background-timer-throttling=false`
- `disable-backgrounding-occluded-windows=false`
- `disable-renderer-backgrounding=false`
- `disable-component-update`

## Frontend và IPC

Kết quả rà soát:

- `launcher/electron/preload.cjs` trả về hàm unsubscribe và gọi `ipcRenderer.removeListener()`.
- `launcher/src/App.tsx` lưu các hàm unsubscribe và gọi chúng trong cleanup của `useEffect`.
- Listener resize, media query, keyboard, interval và timeout đều có cleanup.
- Log streaming phía UI đã giới hạn còn tối đa khoảng 5.000 bản ghi.
- Launcher không render lịch sử hội thoại LLM hoặc code highlight trong React; nội dung hội thoại nằm trong các website provider, nên virtual scroll phải do provider thực hiện. Không có danh sách chat nội bộ phù hợp để thêm virtual scrolling.

## Kiểm thử

- `node --check`: đạt cho các file Electron đã sửa.
- `bun run typecheck`: đạt.
- `git diff --check`: đạt.
- `bun test tests/browser-host.test.cjs`: 107/113 test đạt.
- 6 test còn lỗi thuộc nhóm hành vi authentication/Temporary Chat có sẵn, không nằm trong lifecycle renderer vừa thay đổi.
- `node --test` không chạy được trên môi trường hiện tại do Windows trả `spawn EPERM`; dùng `bun test` để kiểm tra trực tiếp.

## Checklist User Test

1. Khởi động launcher và ghi nhận số process `--type=renderer`.
2. Chưa mở provider khác: chỉ renderer shell và provider mặc định được tạo.
3. Chuyển ChatGPT → M365 → Gemini → Qwen nhiều lần.
4. Xác nhận renderer provider cũ biến mất sau mỗi lần chuyển.
5. Mở và đóng turn tab; xác nhận mỗi renderer tab đóng tương ứng.
6. Kiểm tra lại đăng nhập provider sau khi renderer được tạo lại.
7. Theo dõi RAM trong 15-30 phút và xác nhận không tăng tuyến tính theo số lần đổi tab.

