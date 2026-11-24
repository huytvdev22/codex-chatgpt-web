# 100: Menu quản lý Model, lưu trữ Overlay `models.json` và Auto-Discovery theo từng Adapter

> **Trạng thái:** ✅ Đã Confirm
> **Providers:** `m365-copilot`, `ai-studio`, `chatgpt`, `web`, `server`, `launcher`, `electron`  
> **Keywords:** `ModelConfigStore`, `ModelManagementService`, `ModelsSurface`, `models.json`, `discoverModels`, `AiStudioModelDiscovery`, `ChatGptModelDiscovery`, `M365ModelDiscovery`, `ProviderBusyError`, `AT_LEAST_ONE_MODEL_REQUIRED`

## ⚡ TL;DR
1. **Triệu chứng:** Toàn bộ danh sách model bị hardcode cố định trong từng `model-provider.ts`, không bật/tắt hoặc sửa metadata từ UI được và phải sửa code mỗi khi provider ra model mới.
2. **Nguyên nhân gốc rễ:** Chưa có tầng lưu trữ cấu hình overlay trên `ModelRegistry`, chưa có API điều khiển nóng `/admin/models*`, và mỗi adapter chưa có cơ chế `discoverModels()` đọc danh sách model trực tiếp từ Web UI.
3. **Cách sửa:** Xây dựng `ModelConfigStore` (`~/.codex-m365-copilot/models.json`) hợp nhất 3 lớp (Built-in → Discovery Cache → User Overrides) với ràng buộc còn tối thiểu 1 model bật, bổ sung `discoverModels()` riêng cho cả 3 adapter kèm khóa bận `409`, chặn model OFF/unavailable ở cả `/v1/responses` lẫn `/v2/responses`, đồng bộ nóng `catalog.json`, và thêm tab **Models** trên Electron Launcher (`ModelsSurface.tsx` + `<dialog>` edit tối giản).

## Thay đổi chính
- **Tầng Core & Lưu trữ Overlay (`src/models/`):**
  - [model-config-store.ts](../../src/models/model-config-store.ts): Đọc/ghi atomic `models.json` kèm hot-reload theo `mtimeMs`/`size`, mặc định OFF cho model mới phát hiện qua Refresh, giữ override cho model tạm unavailable, chặn tắt model bật cuối cùng (`AT_LEAST_ONE_MODEL_REQUIRED`), tự tính `auto_compact_token_limit = 90%`.
  - [types.ts](../../src/models/types.ts), [base-model-provider.ts](../../src/models/base-model-provider.ts), [model-registry.ts](../../src/models/model-registry.ts), [model-catalog.ts](../../src/models/model-catalog.ts): Thêm `buildRouteFromDiscovered()`, `listEnabledRoutes()`, `getModelStatus()`, `resolveProviderAccess()`.
- **Auto-Discovery & Chọn Model Động (`src/adapters/`):**
  - [turn-identity.ts](../../src/adapters/web/turn-identity.ts), [base.ts](../../src/adapters/base.ts), [definition.ts](../../src/adapters/web/definition.ts), [engine.ts](../../src/adapters/web/engine.ts), [web-provider-adapter.ts](../../src/adapters/web/web-provider-adapter.ts): Theo dõi turn theo `providerId`, khóa `409 ProviderBusyError` khi provider đang bận turn, và chạy discovery trên tab tạm (`retainOnCompleted: false`).
  - [ai-studio/model-discovery.ts](../../src/adapters/ai-studio/model-discovery.ts) & [ai-studio/model-provider.ts](../../src/adapters/ai-studio/model-provider.ts): Mở `ms-model-selector` + chip `Gemini`, lọc bỏ Imagen/Veo/TTS/Audio/Embedding/Nano Banana/`-image`, hỗ trợ prefix `ai-studio/`.
  - [chatgpt/model-discovery.ts](../../src/adapters/chatgpt/model-discovery.ts) & [chatgpt/model-provider.ts](../../src/adapters/chatgpt/model-provider.ts): Quét `[role="menuitemradio"]` (và submenu Legacy), dừng báo lỗi rõ nếu chưa login hoặc dính Cloudflare.
  - [m365-copilot/model-discovery.ts](../../src/adapters/m365-copilot/model-discovery.ts), [m365-copilot/model-provider.ts](../../src/adapters/m365-copilot/model-provider.ts), [m365-copilot/capability-picker.ts](../../src/adapters/m365-copilot/capability-picker.ts): Quét `#gptModeSwitcher` + submenu Fluent UI sinh `capabilityMeta`, chọn động cả model mới phát hiện.
- **Control Plane & Enforcement (`src/services/`, `src/controllers/`, `src/server.ts`):**
  - [model-management-service.ts](../../src/services/model-management-service.ts), [admin-controller.ts](../../src/controllers/admin-controller.ts), [server.ts](../../src/server.ts): Bổ sung `/admin/models*` (`GET`, `PUT /override`, `PUT /provider-toggle`, `POST /reset`, `POST /refresh`) đồng bộ ngay `catalog.json`.
  - [responses-service.ts](../../src/services/responses-service.ts) & [raw-responses-service.ts](../../src/services/raw-responses-service.ts): Chặn trả HTTP `400` khi gọi model đang tắt hoặc unavailable.
- **Electron Launcher UI (`launcher/`):**
  - [models-store.cjs](../../launcher/electron/infra/models-store.cjs), [ipc-router.cjs](../../launcher/electron/app/ipc-router.cjs), [preload.cjs](../../launcher/electron/preload.cjs), [main.cjs](../../launcher/electron/main.cjs): Proxy `/admin/models*` khi runtime online và fallback đọc/ghi trực tiếp `models.json` khi offline.
  - [ModelsSurface.tsx](../../launcher/src/components/ModelsSurface.tsx), [App.tsx](../../launcher/src/App.tsx), [types.ts](../../launcher/src/types.ts), [icons.tsx](../../launcher/src/icons.tsx), [i18n.ts](../../launcher/src/i18n.ts), [styles.css](../../launcher/src/styles.css): Tab **Models**, công tắc ON/OFF theo model & provider, `Refresh` / `Refresh All`, `Open models.json`, `Reset defaults`, và modal `<dialog>` Sửa tối giản (`step={1}` tránh HTML5 step mismatch).
- **Kiểm thử:** [tests/model-config-store.test.ts](../../tests/model-config-store.test.ts), [tests/model-management-api.test.ts](../../tests/model-management-api.test.ts), [tests/model-discovery-parsers.test.ts](../../tests/model-discovery-parsers.test.ts), [launcher/tests/models-store.test.cjs](../../launcher/tests/models-store.test.cjs).
