# 055 - Thêm nút mở Swagger UI trong Settings Launcher và đóng gói `docs/swagger.html` cho bản Packaged

> **Trạng thái:** ✅ Đã Confirm  
> **Ngày thực hiện:** 2026-11-16  
> **Phạm vi:** `scripts/build-runtime-bundle.ts`, `launcher/electron/`, `launcher/src/`

## ⚡ TL;DR
1. **Triệu chứng / Nhu cầu:** Cần mở Swagger UI (`/swagger`) trực tiếp từ Launcher Settings, đồng thời ở bản packaged runtime chưa có file `docs/swagger.html` nên `GET /swagger` trả về `404`.
2. **Nguyên nhân gốc rễ:** `scripts/build-runtime-bundle.ts` chưa copy `docs/swagger.html` vào runtime bundle (trong khi `src/server.ts` resolve `../docs/swagger.html` từ `app/cli.js`), và `launcher:open-external` chỉ allowlist GitHub/X.
3. **Cách sửa:** Copy `docs/swagger.html` vào `<runtime>/docs/swagger.html` trước khi hash `manifest.json`; thêm IPC `launcher:open-swagger` kiểm tra profile production, cấu hình loopback, `/healthz` rồi mở trình duyệt hệ thống; thêm nút `Open Swagger UI` trong `SettingsSurface` → Diagnostics (bỏ qua DEV profile).

## Thay đổi chính
- [build-runtime-bundle.ts](../../scripts/build-runtime-bundle.ts): copy `docs/swagger.html` sang `docs/swagger.html` trong output bundle trước bước `runtimeManifestFiles()` để `manifest.json` và `validateRuntimeBundle` tự xác thực.
- [ipc-router.cjs](../../launcher/electron/app/ipc-router.cjs) & [preload.cjs](../../launcher/electron/preload.cjs): thêm `launcher:open-swagger` (`openSwagger()`) kiểm tra `!isDevProfile`, `runtimeConfigSnapshot()`, probe `/healthz` (timeout 1.5s) và mở `http://127.0.0.1:<port>/swagger` qua `openWebUrl`.
- [App.tsx](../../launcher/src/App.tsx), [types.ts](../../launcher/src/types.ts), [i18n.ts](../../launcher/src/i18n.ts): thêm nút `Open Swagger UI` trong `SettingsSurface` mục Diagnostics (chỉ hiện khi `!devProfile`, disable khi `!coreSetupComplete`), hỗ trợ đủ 5 ngôn ngữ.
- Tests: bổ sung test trong [renderer-wiring.test.cjs](../../launcher/tests/renderer-wiring.test.cjs) và [packaging-contract.test.cjs](../../launcher/tests/packaging-contract.test.cjs).

