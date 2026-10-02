# Hướng dẫn Build File Cài Đặt Windows (.exe)

Tài liệu này hướng dẫn chi tiết quy trình chuẩn bị môi trường, biên dịch và đóng gói bộ cài đặt Windows (`.exe`) cho dự án **Codex M365 Copilot** (Desktop Launcher & Bridge Runtime).

---

## 1. Kiến trúc bản cài đặt Windows

Bản cài đặt Windows được đóng gói dưới dạng **NSIS Installer** hoàn chỉnh:
- **Desktop Control Center (GUI)**: Ứng dụng Electron 41 kết hợp giao diện React 19 + Vite nằm trong thư mục [launcher/](file:///d:/HUYTVDEV/codex-chatgpt-web/launcher/).
- **Embedded Durable Runtime**: Tự động tích hợp sẵn **Bun 1.4.0** và mã nguồn core CLI [src/cli.ts](file:///d:/HUYTVDEV/codex-chatgpt-web/src/cli.ts).
- **Tính độc lập**: Người dùng cuối khi cài đặt file `.exe` này **không cần phải tự cài Node.js hay Bun** trước trên máy.

---

## 2. Yêu cầu môi trường (Prerequisites)

- **Hệ điều hành**: Windows 10 hoặc Windows 11 (kiến trúc x64).
- **Bun**: Bắt buộc đúng phiên bản **`1.4.0`** (dự án kiểm tra nghiêm ngặt phiên bản trong [scripts/build-runtime-bundle.ts](file:///d:/HUYTVDEV/codex-chatgpt-web/scripts/build-runtime-bundle.ts)).
  - *Nguồn file thực thi*: Có thể lấy từ phiên bản đã cài trên máy tại:
    `C:\Users\huytv\.codex-m365-copilot\versions\6.1.4-win32-x64\runtime\bun.exe`
  - *Khuyến nghị an toàn*: Nên copy file `bun.exe` này sang một thư mục độc lập (ví dụ `C:\Users\huytv\.bun\bin\bun.exe`) để không bị mất nếu bạn gỡ cài đặt ứng dụng Codex M365 Copilot.
```PowerShell
# 1. Tạo thư mục Bun độc lập và copy bun.exe sang
New-Item -ItemType Directory -Path "$env:USERPROFILE\.bun\bin" -Force | Out-Null
Copy-Item "C:\Users\huytv\.codex-m365-copilot\versions\6.1.4-win32-x64\runtime\bun.exe" "$env:USERPROFILE\.bun\bin\bun.exe" -Force

# 2. Cập nhật PATH vĩnh viễn trỏ vào thư mục độc lập này
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";$env:USERPROFILE\.bun\bin", "User")

```
- **PowerShell**: Khuyến nghị dùng PowerShell 5.1 hoặc PowerShell 7+.

---

## 3. Cấu hình môi trường

Hệ thống cần nhận diện lệnh `bun`. Bạn có thể cấu hình theo các cách sau:

### Cách 1: Thiết lập cho phiên làm việc hiện tại (Tạm thời)
Mở PowerShell tại thư mục gốc của dự án (`d:\HUYTVDEV\codex-chatgpt-web`) và chạy:

```powershell
$env:PATH = "C:\Users\huytv\.bun\bin;$env:PATH"
```

### Cách 2: Thiết lập vĩnh viễn vào biến môi trường người dùng (Khuyên dùng)
Nếu đã copy `bun.exe` vào `C:\Users\huytv\.bun\bin`:
```powershell
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";C:\Users\huytv\.bun\bin", "User")
```
*(Hoặc trỏ trực tiếp vào `C:\Users\huytv\.codex-m365-copilot\versions\6.1.4-win32-x64\runtime` nếu vẫn giữ ứng dụng)*.

> **Kiểm tra**: Chạy `bun --version`. Nếu hiển thị `1.4.0` là đã cấu hình thành công.

---

## 4. Cài đặt Dependencies

Trước khi build lần đầu hoặc sau khi cập nhật mã nguồn:

```powershell
# 1. Cài đặt dependencies cho core backend
bun install --frozen-lockfile

# 2. Cài đặt dependencies cho desktop launcher
bun install --cwd launcher --frozen-lockfile
```

---

## 5. Quy trình phát triển và kiểm thử nhanh khi đang Code

Trong quá trình phát triển tính năng, sửa giao diện hoặc sửa lỗi, **bạn không cần phải đóng gói lại file `.exe` hay gỡ và cài đặt lại**. Bạn có thể dùng 2 phương pháp sau:

### 🌟 Cách A: Chạy trực tiếp để TEST VỚI CODEX THẬT (Khuyên dùng nhất)
Cách này giúp bạn chạy ngay mã nguồn mới nhất với **Profile thật**, kết nối trực tiếp vào ứng dụng Codex (`~/.codex`) trên máy mà không cần qua trình cài đặt `.exe`:

- **Bước 1: Biên dịch code giao diện mới nhất**
  ```powershell
  bun run --cwd launcher build
  ```
  *(Chỉ mất ~1 giây để Vite và TypeScript biên dịch giao diện vào `launcher/dist`)*.

- **Bước 2: Khởi chạy Electron từ mã nguồn**
  ```powershell
  bun run --cwd launcher start
  ```
  *(Ứng dụng sẽ mở lên ngay lập tức, tự động kết nối vào phiên ChatGPT Web và cầu nối Codex thật của bạn y hệt như bản đã cài đặt)*.

---

### ⚡ Cách B: Chế độ Dev UI với Hot Reload (Khi chỉ sửa giao diện React/CSS)
Nếu bạn chỉ cần tinh chỉnh giao diện, canh chỉnh CSS hay layout mà không cần tương tác với bridge Codex thật:

- *Lưu ý*: Nếu gặp lỗi `Electron failed to install correctly` trong lần đầu, chạy:
  ```powershell
  bun run launcher/node_modules/electron/install.js
  ```
- Khởi động Dev Server:
  ```powershell
  bun run launcher:dev
  ```
  *(Có tính năng Hot Module Replacement - HMR, sửa file `.tsx` hay `.css` là giao diện tự động cập nhật ngay trên màn hình)*.

---

## 6. Các bước đóng gói bộ cài đặt (.exe) khi phát hành

Chỉ khi nào bạn đã hoàn thiện code, kiểm thử xong và muốn **tạo file cài đặt hoàn chỉnh để phân phối hoặc dùng lâu dài**, bạn mới cần đóng gói:

### Lựa chọn 1: Build tự động 1 lệnh (Khuyên dùng)

Từ thư mục gốc dự án, chạy lệnh:

```powershell
bun run app:package
```

*(Lệnh này tự động thực hiện: kiểm tra TypeScript -> Build Vite UI -> Build Runtime bundle -> Đóng gói Electron Builder ra file `.exe`)*.

---

### Lựa chọn 2: Chạy chi tiết từng công đoạn

Nếu bạn muốn kiểm soát hoặc xử lý lỗi từng phần:

#### Bước 1: Build giao diện người dùng (Renderer UI)
```powershell
bun run --cwd launcher build
```
Lệnh này chạy kiểm tra kiểu (`tsc --noEmit`) và biên dịch Vite sang thư mục `launcher/dist/`.

#### Bước 2: Chuẩn bị runtime nhúng (Embedded Runtime)
```powershell
bun run --cwd launcher build:runtime
```
Lệnh này kích hoạt script [scripts/build-runtime-bundle.ts](file:///d:/HUYTVDEV/codex-chatgpt-web/scripts/build-runtime-bundle.ts) nhằm:
1. Biên dịch CLI core ([src/cli.ts](file:///d:/HUYTVDEV/codex-chatgpt-web/src/cli.ts)) thành `cli.js`.
2. Sao chép binary `bun.exe` vào `launcher/build/runtime/runtime/`.
3. Cài đặt production dependencies độc lập và xuất `THIRD_PARTY_NOTICES.txt`.

#### Bước 3: Đóng gói NSIS Installer
```powershell
bun run --cwd launcher scripts/package.cjs --win
```
Lệnh này gọi `electron-builder` để:
1. Đóng gói mã nguồn và runtime vào file ASAR.
2. Tạo bộ cài đặt NSIS cho Windows x64.
3. Xuất file cài đặt hoàn chỉnh ra thư mục artifacts.

---

## 7. Vị trí file kết quả sau khi build

File cài đặt Windows `.exe` xuất hiện tại:

- **Thư mục**: [launcher/artifacts/](file:///d:/HUYTVDEV/codex-chatgpt-web/launcher/artifacts/)
- **Tên file**: `codex-m365-copilot-6.1.4-win-x64.exe`
- **Dung lượng**: ~144 MB

---

## 8. Kiểm thử bộ cài đặt (Smoke Testing)

Sau khi tạo xong file `.exe`, bạn có thể chạy smoke test tự động để xác nhận bộ cài hoạt động tốt:

```powershell
bun run app:smoke
```

Khi kiểm thử thành công, màn hình sẽ thông báo:
```text
PACKAGED_LAUNCHER_SMOKE_OK win32/x64
```

---

## 9. Xử lý các lỗi thường gặp trên Windows

### Lỗi 1: `bun : The term 'bun' is not recognized...`
- **Nguyên nhân**: Chưa thiết lập đường dẫn chứa `bun.exe` vào biến môi trường `PATH`.
- **Khắc phục**: Chạy lệnh gán `$env:PATH = ...` ở Mục 3.

### Lỗi 2: `Runtime bundle requires Bun 1.4.0, received x.x.x`
- **Nguyên nhân**: Phiên bản Bun đang chạy không khớp với `1.4.0`.
- **Khắc phục**: Kiểm tra lại đường dẫn `bun.exe` xem có trỏ đúng vào phiên bản `1.4.0` trong máy hay không.

### Lỗi 3: `EPERM: operation not permitted, rename ... win-unpacked.tmp`
- **Nguyên nhân**: Tính năng bảo vệ thời gian thực (Real-time Protection) của Windows Defender hoặc phần mềm Antivirus đang quét file nhị phân lớn (`electron.exe` ~220MB) ngay khi vừa giải nén, khiến hệ thống tạm thời khóa file.
- **Khắc phục**: 
  - Đã có cơ chế tự động thử lại (retry loop) sau vài giây.
  - Hoặc thêm thư mục dự án và `%TEMP%` vào danh sách loại trừ (Exclusion) của Windows Defender nếu cần tăng tốc độ đóng gói.
