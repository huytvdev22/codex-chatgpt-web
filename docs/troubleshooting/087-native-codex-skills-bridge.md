# 087 - Triển khai Native Codex Skills Bridge & Skills Control (`/v1/responses` + Electron Launcher)

> **Trạng thái:** ✅ Đã Confirm  
> **Ngày thực hiện:** 2026-11-20  
> **Phạm vi:** `src/skills/`, `src/adapters/web/`, `launcher/electron/`, `launcher/src/`

## ⚡ TL;DR
1. **Vấn đề:** `CodexPayloadNormalizer` và `instruction-sanitizer.ts` xóa sạch `<skills_instructions>` (`host_skills.instructions`), còn `skills.selected_skill_instructions` khi dùng `/skill` bị đẩy nhầm vào `priorHistory` (nằm sau user request ở Turn 1 và mất hẳn ở Turn 2+ do `priorHistory` không lặp lại).
2. **Giải pháp:** Tạo `src/skills/` (`CodexSkillParser`, `SkillsStore`, `SkillPromptBuilder`) trích tách cả `availableSkills` (chỉ xuất dạng siêu gọn `name -> absolutePath`, mặc định ẩn Codex `.system` skills) và `selectedSkills` (lọc theo ranh giới turn hiện tại, đặt ngay trước `[Yêu cầu hiện tại của mình]`), kèm dedup theo digest trong `WebPromptSessionStore`.
3. **Giao diện:** Thêm tab `Skills` trên Sidebar Electron Launcher (`SkillsSurface.tsx`), IPC `launcher:skills-get`/`save`, i18n 5 ngôn ngữ và Live Preview.

## Thay đổi chính
- **Domain & Prompt (`src/skills/`):** [types.ts](../../src/skills/types.ts), [codex-skill-parser.ts](../../src/skills/codex-skill-parser.ts), [skills-store.ts](../../src/skills/skills-store.ts), [skill-prompt-builder.ts](../../src/skills/skill-prompt-builder.ts), [index.ts](../../src/skills/index.ts).
- **Web Core Integration (`src/adapters/web/`):** [canonical-types.ts](../../src/adapters/web/normalization/canonical-types.ts), [codex-normalizer.ts](../../src/adapters/web/normalization/codex-normalizer.ts), [web-prompt-session-store.ts](../../src/adapters/web/execution/web-prompt-session-store.ts), [conversation-scenario-builder.ts](../../src/adapters/web/prompt/conversation-scenario-builder.ts), [compiler.ts](../../src/adapters/web/prompt/compiler.ts), [compile-prompt.ts](../../src/adapters/web/compile-prompt.ts), [engine.ts](../../src/adapters/web/engine.ts).
- **Electron Launcher (`launcher/`):** [skills-store.cjs](../../launcher/electron/infra/skills-store.cjs), [main.cjs](../../launcher/electron/main.cjs), [ipc-router.cjs](../../launcher/electron/app/ipc-router.cjs), [preload.cjs](../../launcher/electron/preload.cjs), [SkillsSurface.tsx](../../launcher/src/components/SkillsSurface.tsx), [skills-preview.ts](../../launcher/src/skills-preview.ts), [App.tsx](../../launcher/src/App.tsx), [i18n.ts](../../launcher/src/i18n.ts), [types.ts](../../launcher/src/types.ts), [icons.tsx](../../launcher/src/icons.tsx), [styles.css](../../launcher/src/styles.css).
- **Kiểm thử:** [tests/skills-bridge.test.ts](../../tests/skills-bridge.test.ts), [launcher/tests/skills.test.cjs](../../launcher/tests/skills.test.cjs).
