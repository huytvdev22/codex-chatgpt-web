# 107 — Tách Module Assistant Độc Lập (`/clients/assistant/v1/*`), Streaming Telegram & Kho Skills Riêng

- **Trạng thái:** ⏳ Chờ User Test & Confirm
- **Phạm vi / Providers:** `assistant`, `server`, `web`, `gemini`, `chatgpt`, `ai-studio`, `m365-copilot`, `launcher`, `telegram`

## ⚡ TL;DR
- **Triệu chứng:** Bot Telegram (`1.codex-assistant`) đi chung `/v1/responses` với VS Code Codex nên bị gánh prompt lập trình nặng (~11k+ ký tự ở Turn 1 gồm Personalization IDE, 4 `.system` skills, full JSON Schema `exec_command` & boilerplate 4-backtick), chờ trả nguyên cục mới hiển thị trên Telegram, không tách kho skill riêng, và tab bot có nguy cơ evict tab VS Code trên Electron Launcher.
- **Nguyên nhân gốc rễ:** Chưa có đường dẫn nghiệp vụ riêng cho khách hàng trợ lý cá nhân; mọi adapter web đều giữ nguyên chế độ gom đủ câu trả lời cuối trước khi đẩy SSE; `1.codex-assistant` chỉ đồng bộ duy nhất `gemini-image` và trỏ `openai_base_url` vào `/v1`.
- **Cách sửa:** Tạo module độc lập `src/assistant/` + route `/clients/assistant/v1/{models,responses,responses/compact,images/*}` (Zero-Touch với `/v1/responses`), bật opt-in `streamIncremental` có `AssistantStreamGate` (stream chữ thật về Telegram, chặn tuyệt đối `<tool_call>`/`apply_patch`), băm `conversationKey` thành SHA-256 64 hex kết hợp `connectorIdentity` hậu tố `:assistant` để ưu tiên evict tab `[BOT]` (tối đa 3 retained) trước tab VS Code trong `TurnTabManager`, và nâng cấp `1.codex-assistant` quản lý kho skill riêng (`~/CodexAssistant/skills/`, `extraDirs`, `inheritedHostSkillNames`, `disabledSkills`).

## Tóm tắt kỹ thuật

### 1. Gateway `codex-chatgpt-web` (Zero-Touch luồng VS Code Codex)
- **Transport streaming opt-in:** Thêm `runManagedTurn()` trên `ProviderAdapter` / `WebTurnEngine` và cờ `streamIncremental?: boolean` (mặc định `false` cho VS Code Codex) + throttle DOM snapshot `>= 650ms` trên 4 adapter (`chatgpt`, `gemini`, `ai-studio`, `m365-copilot`).
- **Module `src/assistant/` độc lập:**
  - `AssistantPromptCompiler` + `AssistantToolCatalogRenderer` + `assistant-prompt-templates.ts`: Giao thức **Strict Actions — Natural Answers** (**Natural-First** cho Final Answer để streaming tức thì + **bắt buộc bọc 4-backtick ` ````markdown ` + `<webResponse>...</webResponse>`** đồng bộ với `parseStrictWebResponse` cho Action Turn `<tool_call>`/`apply_patch` để chốt biên batch tool call và bảo toàn 100% thụt lề/code fence), cho phép Web Search nội bộ, bỏ `PersonalizationStore`/`SkillsStore`/`.codex-copilot/MEMORY.md`/`.system` skills/`*_goal`/`multi_agent_v1`, nén `exec_command` về 4 tham số (`cmd`, `workdir`, `sandbox_permissions`, `justification`).
  - `AssistantStreamGate` & `AssistantResponseParser`: Máy trạng thái `BUFFERING` → `STREAMING_TEXT` | `BLOCKED_TOOL_CALL`, chuẩn hóa escape Turndown (`<tool\_call>` → `<tool_call>`), chặn sớm `<webResponse` / `<tool_call` / `<thought` giữa luồng và giữ đuôi (tail holdback) chống rò `</webResponse>`; `AssistantResponseParser` ủy quyền toàn bộ Action Turn cho `parseStrictWebResponse` (hỗ trợ tách `commentaryText` sạch đứng trước khối Action nếu đã kịp stream lên Telegram).
  - `AssistantResponsesService` & `AssistantController`: Sở hữu riêng `assistant-thread-bindings.json` và `WebPromptSessionStore`, băm `conversationKey` thành SHA-256 hex 64 ký tự chuẩn hợp đồng Launcher kèm `connectorIdentity: "${providerId}:assistant"`, hỗ trợ header tùy chọn `x-gateway-profile-id`, và expose đầy đủ `/clients/assistant/v1/{models,responses,responses/compact,images/generations,images/edits}` (tự tương thích `$gemini-image`).
- **Bảo vệ tab Launcher (`launcher/electron/browser/turn-tab-manager.cjs`):** Tab có `connectorIdentity` kết thúc bằng `:assistant` mang nhãn `[BOT] ...`, bị ưu tiên evict trước tab VS Code và bị giới hạn tối đa `MAX_ASSISTANT_RETAINED_TABS = 3`.

### 2. Bot Telegram `1.codex-assistant`
- Chuyển `openai_base_url` sang `${gateway.baseUrl}/clients/assistant/v1`; lấy danh sách model động từ `GET /clients/assistant/v1/models` (cache RAM + fallback đĩa).
- `TurnQueueManager`: Reset `textBuffer` khi `item/started` có `item.type === "agentMessage"` mới (tránh dính commentary trước tool call vào Final Answer) và gắn cờ `isExecutingTool`.
- `TelegramBotService`: Stream mượt lên Telegram với throttle thích ứng (DM `1200ms`, Group/Topic `1800ms`) kèm trailing flush + con trỏ `▌`, chỉ thay bằng trạng thái công cụ `⚙️` khi thực thi tool.
- Kho Skills riêng: Tự động tạo & nạp `~/CodexAssistant/skills/` > `extraDirs` > kế thừa chọn lọc `~/.codex/skills` (`inheritedHostSkillNames`, mặc định `["gemini-image"]`), hỗ trợ tắt từng skill (`disabledSkills`), tự dọn symlink cũ, có API `GET /api/skills` và giao diện quản lý trên Tab 4 Admin UI.
