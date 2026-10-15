# Hướng dẫn Tích hợp Web Adapter Mới từ Đầu đến Cuối

Tài liệu hướng dẫn chuẩn hóa (Checklist hành động) để Agent tích hợp một AI Web Adapter mới vào hệ thống `codex-chatgpt-web` mà không bị thiếu bước.

---

## 1. Khảo sát Giao diện Web của AI Target (DOM Selectors)
Trước khi viết mã, cần thu thập các selector cốt lõi trên giao diện web của AI (ví dụ: Google Gemini, Claude Web, v.v.):
- **App URL**: Đường dẫn trang chat chính (vd: `https://gemini.google.com/app`).
- **Composer/Input**: Khung nhập prompt (`rich-textarea div[contenteditable="true"]`, `[role="textbox"]`).
- **Send Button**: Nút gửi tin nhắn (`button[aria-label*="Send" i]`, `button.send-button`).
- **Response Container**: Khung chứa câu trả lời (`model-response`, `[role="article"]`).
- **Generating/Stop Indicator**: Nút/trạng thái khi AI đang sinh văn bản.
- **Model Selector (nếu có)**: Menu dropdown chọn model.

---

## 2. Xây dựng Adapter Core (`src/adapters/<adapter-name>/`)
Tạo thư mục `src/adapters/<adapter-name>/`:
1. **Model Definitions & Routes**:
   - Định nghĩa `is<Name>ModelSlug(slug)`: Nhận diện model slug của adapter.
   - Định nghĩa `available<Name>ModelRoutes()`: Trả về danh sách model ID, display name, description.
2. **Khai báo Selectors**:
   - Khai báo hằng số `<NAME>_SELECTORS` chứa các selector đã khảo sát ở Bước 1.
3. **Tái sử dụng Prompt & Response Protocol (KHÔNG viết lại từ đầu)**:
   - Dùng chung `buildUnifiedToolProtocol(assistantName)` từ `src/adapters/m365-copilot/prompts/templates.ts`.
   - Luôn sử dụng envelope cố định: `<webResponse>...</webResponse>`.
   - Tái sử dụng các anchor ngắn gọn: `buildShortOutputFormatAnchor()`.
4. **Adapter Class**:
   - Tạo class `<Name>WebAdapter` implements `ProviderAdapter`.
   - Cung cấp hàm khởi tạo: `create<Name>WebAdapter(options)`.

---

## 3. Đăng ký Adapter & Model Catalog vào Server
Cập nhật các điểm định tuyến trung tâm:
1. **Catalog Export (`src/server.ts` hoặc `src/chatgpt-backend.ts`)**:
   - Bổ sung `available<Name>ModelRoutes()` vào danh sách trả về của API `/models` để Codex IDE hiển thị trong danh sách model.
2. **Request Routing (`src/server.ts`)**:
   - Nhận diện model slug thuộc adapter mới trong endpoint `/v1/chat/completions` hoặc `/v1/responses`.
   - Định tuyến request sang adapter tương ứng.

---

## 4. Tích hợp vào Giao diện Launcher Electron (`launcher/`)

### A. Định nghĩa Type & State (`launcher/src/types.ts`)
- Mở rộng `selectedProvider`: `"chatgpt" | "m365" | "<new-provider>"`.
- Thêm trường `<newProvider>Authenticated?: boolean` vào `BrowserState` và `LauncherState`.
- Thêm trường `<newProvider>SmokePassed?: boolean` vào `LauncherSnapshot`.
- Cập nhật hàm `setProvider(provider: "chatgpt" | "m365" | "<new-provider>")`.

### B. UI Components (`launcher/src/`)
1. **Icons (`launcher/src/icons.tsx`)**:
   - Thêm icon đại diện cho adapter vào `IconName` và render SVG (vd: icon `spark` cho Gemini).
2. **Sidebar Workspace Navigation (`launcher/src/App.tsx`)**:
   - Thêm `SidebarItem` trong nhóm Workspace.
   - Cập nhật hiển thị Brand Header trên góc trái theo provider đang chọn.
3. **Màn hình Setup (`launcher/src/App.tsx`)**:
   - Thêm Setup Section riêng cho provider mới gồm 2 bước:
     * **Bước 1 (Sign in)**: Kích hoạt WebView điều hướng tới trang web để đăng nhập.
     * **Bước 2 (Smoke test)**: Gửi prompt xác thực `Reply with exactly: CODEX WEB GPT READY`.
4. **Màn hình Settings (`launcher/src/App.tsx`)**:
   - Thêm nút chuyển đổi provider trong mục chọn AI Provider (kèm highlight màu thương hiệu).
5. **Browser Toggle & Empty View (`launcher/src/App.tsx`)**:
   - Cập nhật nhãn nút "Open/Hide <Name>" và thông báo khi chưa mở browser.

### C. Electron Main & Browser Host (`launcher/electron/`)
1. **Browser Host (`launcher/electron/browser-host.cjs`)**:
   - Khai báo URL constants: `<NAME>_CHAT_URL`, `<NAME>_ORIGIN`.
   - Khởi tạo `this.<name>View = new WebContentsView(...)` với phân vùng độc lập: `persist:codex-<name>-web`.
   - Khai báo partition mới vào danh sách `allowedPartitions` trong constructor.
   - Cập nhật `switchProvider(provider)`: Hiển thị `<name>View`, ẩn các view còn lại, load URL nếu cần.
   - Cập nhật `initializePrimaryView()`: Khởi tạo view bounds và load URL.
   - Cập nhật `openLogin()`: Kích hoạt view và mở URL đăng nhập.
   - Cập nhật `probeAuthentication()`: Kiểm tra domain, phát hiện login page và kiểm tra sự hiện diện của composer.
   - Cập nhật `runSmokeTest()`: Nhập prompt `CODEX WEB GPT READY`, click gửi, polling kiểm tra câu trả lời hoàn tất.
   - Cập nhật `runSessionInspection()`: Bổ sung nhánh trả về mock capabilities cho provider mới để pass qua CLI setup.
   - Cập nhật `snapshot()` và `writeDescriptor()`: Bổ sung `<name>Authenticated` và `<name>SurfaceId`.
2. **Control Server (`launcher/electron/control-server.cjs`)**:
   - Thêm `<name>` vào danh sách provider hợp lệ trong payload `/v1/turn/start`.
3. **Core Descriptor Validation (`src/launcher-browser-host.ts`)**:
   - Thêm `persist:codex-<name>-web` vào mảng `allowedPartitions` trong `assertDescriptorShape()`.
   - Bổ sung `<name>SurfaceId?: string` và mở rộng `provider` trong interface `LauncherBrowserHostDescriptor`.
4. **IPC Handlers (`launcher/electron/main.cjs`)**:
   - `launcher:set-provider`: Chấp nhận provider mới.
   - `launcher:browser-smoke`: Lưu `<name>SmokePassed: true` vào `stateStore`.
   - `launcher:setup-core`: Hiển thị đúng nhãn của provider khi có thông báo xác thực.

---

## 5. Kiểm thử & Xác nhận (Verification)
Chạy lần lượt các lệnh sau để đảm bảo không lỗi:
1. **Build Launcher UI**:
   ```bash
   bun run --cwd launcher build
   ```
2. **Kiểm tra TypeScript Core**:
   ```bash
   bun run typecheck
   ```
3. **Chạy Unit Tests**:
   ```bash
   bun test tests/<name>-web-adapter.test.ts
   ```
4. **Khởi chạy kiểm tra trực quan**:
   ```bash
   bun run --cwd launcher start
   ```
   - Xác nhận tab xuất hiện trên Sidebar.
   - Xác nhận đăng nhập và smoke test trên màn hình Setup hoạt động chính xác.
