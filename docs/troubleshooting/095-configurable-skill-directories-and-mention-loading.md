# 095 - Cấu hình Thư mục Skills, Tự Quét Đĩa & Tự Nạp `$skill` cho Custom Folder

> **Trạng thái:** ✅ Đã Confirm  
> **Ngày thực hiện:** 2026-11-20  
> **Phạm vi:** `src/skills/`, `src/adapters/web/`, `launcher/electron/`, `launcher/src/`

## ⚡ TL;DR
1. **Vấn đề:** Cơ chế Skills Bridge trước đây chỉ nghe lén thụ động `<skills_instructions>` từ payload Codex ghi vào cache `discovered-skills.json`, không cho cấu hình/quét thư mục chứa skills tùy chỉnh, nút Refresh không quét lại đĩa, và copy UI ghi nhầm `/skill ($skill)` gây hiểu nhầm trigger trong Codex IDE.
2. **Giải pháp:** Bổ sung `SkillDirectoryScanner` (quét `SKILL.md` an toàn giới hạn độ sâu, parse YAML frontmatter, tôn trọng `agents/openai.yaml` `allow_implicit_invocation: false`, chống symlink loop), mặc định tự quét `~/.codex/skills`, hợp nhất theo ưu tiên `workspace > custom > user > system`, giữ nguyên index siêu gọn `name -> path`, và tự nhận diện `$tên-skill` ở proxy để bơm nội dung `SKILL.md` cho Custom Folder skills.
3. **Giao diện:** Nâng cấp tab `Skills` với mục `Skill Directories` (chọn thư mục native qua `dialog.showOpenDialog`, nhập path tay, Quick-add thư mục phát hiện trên máy, mở/xóa/bật-tắt thư mục), bộ lọc nguồn, nhãn `Overridden` / `Direct $skill only`, và sửa copy thành `$skill`.

## Thay đổi chính
- **Core (`src/skills/`, `src/adapters/web/`):** [types.ts](../../src/skills/types.ts), [skill-directory-scanner.ts](../../src/skills/skill-directory-scanner.ts), [skills-store.ts](../../src/skills/skills-store.ts), [skill-prompt-builder.ts](../../src/skills/skill-prompt-builder.ts), [index.ts](../../src/skills/index.ts), [engine.ts](../../src/adapters/web/engine.ts), [compiler.ts](../../src/adapters/web/prompt/compiler.ts).
- **Electron Launcher (`launcher/`):** [skill-directory-scanner.cjs](../../launcher/electron/infra/skill-directory-scanner.cjs), [skills-store.cjs](../../launcher/electron/infra/skills-store.cjs), [ipc-router.cjs](../../launcher/electron/app/ipc-router.cjs), [preload.cjs](../../launcher/electron/preload.cjs), [SkillsSurface.tsx](../../launcher/src/components/SkillsSurface.tsx), [skills-preview.ts](../../launcher/src/skills-preview.ts), [types.ts](../../launcher/src/types.ts), [icons.tsx](../../launcher/src/icons.tsx), [i18n.ts](../../launcher/src/i18n.ts), [styles.css](../../launcher/src/styles.css).
- **Kiểm thử:** [tests/skills-bridge.test.ts](../../tests/skills-bridge.test.ts), [launcher/tests/skills.test.cjs](../../launcher/tests/skills.test.cjs).
