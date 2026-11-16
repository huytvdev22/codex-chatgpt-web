# 054 - Đồng bộ `docs/adding-new-web-adapter-guide.md` theo Kiến trúc Đa Provider Hiện tại

> **Trạng thái:** ⏳ Chờ User Test & Confirm  
> **Ngày thực hiện:** 2026-11-16  
> **Phạm vi:** `docs/adding-new-web-adapter-guide.md`

## ⚡ TL;DR
1. **Triệu chứng:** Tài liệu [adding-new-web-adapter-guide.md](../adding-new-web-adapter-guide.md) trỏ tới file không tồn tại (`src/adapters/register-default-adapters.ts`), ghi sai mẫu partition Launcher (`persist:codex-<provider>`), thiếu quy trình `BaseModelProvider`/`BaseBrowserProvider` và chạy `bun test` trần dễ quét nhầm test Electron Launcher.
2. **Nguyên nhân gốc rễ:** Sau các đợt refactor `BaseModelProvider`, `AdapterRegistry`, Launcher OOP (`052`) và dọn nợ kỹ thuật đa provider (`053`), phần hướng dẫn tích hợp hệ thống và checklist chưa được rà soát đối chiếu lại toàn bộ.
3. **Cách sửa:** Cập nhật đầy đủ quy trình đăng ký `BaseModelProvider` → `ModelRegistry.defaultInstance`, `AdapterRegistry.defaultInstance` (khớp `providerId`), `BaseBrowserProvider` → `createDefaultProviderRegistry()`, sửa regex `partition` (`persist:codex-web-<provider>`), bổ sung `json_schema`/`retain: false` và checklist script chuẩn (`bun run test`, `launcher:typecheck`/`test`/`build`).

## Thay đổi chính
- Gỡ bỏ tham chiếu sai `src/adapters/register-default-adapters.ts`; ghi rõ cơ chế đăng ký tại [adapter-registry.ts](../../src/adapters/adapter-registry.ts) và phân giải động trong [responses-service.ts](../../src/services/responses-service.ts).
- Chuẩn hóa bước Model Provider kế thừa `BaseModelProvider` ([base-model-provider.ts](../../src/models/base-model-provider.ts)) và đăng ký vào `ModelRegistry.defaultInstance` ([model-registry.ts](../../src/models/model-registry.ts)), nhấn mạnh yêu cầu khớp `id` với `AdapterRegistry`.
- Bổ sung quy trình tạo `BaseBrowserProvider` ([base-browser-provider.cjs](../../launcher/electron/browser/providers/base-browser-provider.cjs)) đăng ký vào `createDefaultProviderRegistry()` ([browser-host.cjs](../../launcher/electron/browser/browser-host.cjs)) và quy tắc regex `partition` thực tế trong [launcher-browser-host.ts](../../src/launcher-browser-host.ts).
- Bổ sung cơ chế `retain: false` / `json_schema` và đầy đủ Quality gates cho cả root lẫn Electron Launcher (`bun run test`, `launcher:typecheck`, `launcher:test`, `launcher:build`).

