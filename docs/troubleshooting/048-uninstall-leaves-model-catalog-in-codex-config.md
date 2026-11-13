# 048: Tắt/Uninstall bridge vẫn để sót `model_catalog_json` và model adapter trong `~/.codex/config.toml`

**Trạng thái:** ✅ Đã Confirm  
**Ngày phát hiện:** 2026-11-13  
**Phạm vi:** `src/codex-integration.ts`, `src/server.ts`, `launcher/src/App.tsx`

---

## ⚡ TL;DR
1. **Triệu chứng:** Khi ngắt/gỡ tích hợp bridge để Codex quay về gọi thẳng OpenAI API mặc định, `~/.codex/config.toml` vẫn giữ nguyên `model_catalog_json = ".../catalog.json"` và `model = "m365-copilot/gpt-5.6"`.
2. **Nguyên nhân gốc rễ:** `startServer()` trong `src/server.ts` luôn vô điều kiện gọi `syncCodexModelCatalogConfig()`, trong khi `removeCodexModelCatalogConfig()` ở `src/codex-integration.ts` chưa bao giờ được gọi trong `deactivateCodexIntegration()` hay `uninstallCodexIntegration()`.
3. **Cách sửa:** Chỉ sync `model_catalog_json` khi journal đang active qua `reconcileCodexModelCatalogConfig()`; tự động gỡ `model_catalog_json` do bridge quản lý và `model` của adapter khi deactivate/uninstall (vẫn giữ nguyên `[projects.*]` của user), đồng thời đặt nút Remove (Uninstall) ngay dưới Setup trong Launcher.

