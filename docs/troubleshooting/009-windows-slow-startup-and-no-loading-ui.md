# [ISSUE-009] Mở app trên Windows mất 5–6 phút không hiện cửa sổ và không có thông báo tiến trình

> **Status:** ✅ Đã Confirm
> **Providers:** `launcher`, `electron`, `windows`
> **Keywords:** `slow startup`, `Windows Defender`, `runtime-install`, `SHA-256`, `5557 files`, `StartupLoadingModal`, `window_created`

## ⚡ TL;DR
- **Triệu chứng**: Mở bản cài `.exe` trên Windows mất ~6 phút mới hiện cửa sổ ứng dụng; trong thời gian đó tiến trình chạy ngầm không có bất kỳ giao diện hay phản hồi nào.
- **Nguyên nhân gốc rễ**: (1) `waitForPackagedRuntimeSource` và `ensurePackagedRuntime` chạy đồng bộ **trước** `app.whenReady()` và `createWindow()`; (2) `resources/runtime` chứa 5.557 file `node_modules`, nhưng bộ đệm SHA-256 cũ chỉ lưu file `>= 64 KB` và gọi `fs.writeFileSync` ngay trong vòng lặp mỗi khi lệch cache, khiến Windows Defender quét lại hơn 5.500 file nhỏ qua 3–5 lượt kiểm tra liên tiếp.
- **Cách sửa**: (1) Đưa `app.whenReady()`, `createWindow()`, `registerIpc()` và `loadRenderer(mainWindow)` lên đầu `start()` để mở cửa sổ ngay lập tức; (2) Hiển thị `StartupLoadingModal` trong `App.tsx` theo dõi 4 bước `launcher-startup` và ẩn `WebContentsView` (`!startupLoadingOpen`) khi modal đang mở; (3) Tối ưu `runtime-install.cjs` dùng `Dirent` tránh `lstatSync` thừa, kiểm tra nhanh kích thước/cấu trúc cho gói `> 200` file (vẫn băm SHA-256 đầy đủ 4 file thực thi cốt lõi + `bundleId`), tái sử dụng kết quả kiểm tra `source` và chỉ ghi cache 1 lần sau vòng lặp (giảm thời gian kiểm tra từ ~6 phút xuống ~450 ms).

---

## 🛠️ File Sửa & Quy Tắc Cốt Lõi

1. **`launcher/electron/runtime-install.cjs`**:
   - Dùng `runtimeFileEntries` (`Map<relativePath, Dirent>`) thay vì gọi lại `fs.lstatSync` cho từng file trong 5.557 file.
   - Với gói lớn (`manifest.files.length > FAST_VERIFY_FILE_COUNT_THRESHOLD`), luôn băm SHA-256 đầy đủ các file thực thi cốt lõi (`REQUIRED_RUNTIME_PATHS`) và kiểm tra kích thước byte chính xác + tính toàn vẹn đường dẫn cho các file `node_modules` còn lại.
   - Lưu `lastVerifiedSourceCache` (TTL 15 giây) để `ensurePackagedRuntime` tái sử dụng kết quả từ `waitForPackagedRuntimeSource` và chỉ ghi file cache SHA-256 đúng 1 lần khi kết thúc `inspectRuntimeBundle`.
2. **`launcher/electron/main.cjs`**:
   - Khởi tạo `mainWindow = createWindow(...)`, `registerIpc(...)` và `await loadRenderer(mainWindow)` ngay sau `await app.whenReady()`, trước khi chạy `waitForPackagedRuntimeSource` và `ensurePackagedRuntime`.
   - Phát tiến trình `publishOperation({ name: "launcher-startup", status: "running", message: ... })` qua 4 chặng: `Preparing local runtime` -> `Initializing embedded browser` -> `Checking saved sign-in session` -> `Starting local bridge service`, và đóng bằng `status: "completed"` khi hoàn tất.
   - Bảo vệ các hàm IPC (`browserHost?.`, `runtimeHost?.`) trong giai đoạn cửa sổ vừa mở nhưng runtime đang khởi tạo.
3. **`launcher/src/App.tsx` & `launcher/src/styles.css`**:
   - Bổ sung `StartupLoadingModal` hiển thị checklist 4 bước khởi động và thanh tiến trình cùng ngôn ngữ thiết kế tối của ứng dụng.
   - Cập nhật `browserSurfaceActive` có thêm điều kiện `&& !startupLoadingOpen` để `WebContentsView` gốc của Electron không đè lên popup loading.

