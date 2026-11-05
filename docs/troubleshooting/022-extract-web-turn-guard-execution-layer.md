# 022 - Bóc tách Turn Execution Guard sang Shared Web Adapter Layer (`src/adapters/web/execution`)

## ⚡ TL;DR
- **Triệu chứng:** Cơ chế kiểm soát vòng lặp công cụ (`conversationGuard`, `MAX_TOOL_ITERATIONS`, `stableToolFingerprint`) và nhận diện câu trả lời cuối (`isAssistantFinalAnswer`) nằm trong `src/adapters/m365-copilot/session/` dù không phụ thuộc DOM hay policy riêng của M365.
- **Nguyên nhân gốc rễ:** Kiến trúc V2 ban đầu được phát triển trong `m365-copilot` và chưa tách ownership của lớp kiểm soát thực thi lượt (turn execution guard) sang `src/adapters/web/`.
- **Cách sửa:** Chuyển implementation sang `src/adapters/web/execution/` (`conversation-state.ts`, `turn-guard.ts`, `index.ts`) và giữ nguyên các compatibility shim tại `src/adapters/m365-copilot/session/` để bảo toàn 100% hành vi và đường dẫn import hiện có.

## Trạng thái

⏳ Chờ User Test & Confirm

## Phạm vi thay đổi (Atomic Slice #1)

- **Canonical modules mới:**
  - `src/adapters/web/execution/conversation-state.ts`
  - `src/adapters/web/execution/turn-guard.ts`
  - `src/adapters/web/execution/index.ts`
  - Export qua `src/adapters/web/index.ts`
- **Compatibility shims giữ nguyên:**
  - `src/adapters/m365-copilot/session/conversation-state.ts`
  - `src/adapters/m365-copilot/session/conversation-guard.ts`
  - `src/adapters/m365-copilot/session/index.ts`
- **Bảo toàn hành vi:** Không thay đổi hằng số, thuật toán fingerprint, TTL cleanup, hay `runTurn()` của bất kỳ adapter nào.

## Xác minh

- `git diff --check`: Pass.
- `bun run check:architecture`: Pass (0 circular dependencies, 0 reverse imports).
- `bun test tests/m365-*.test.ts`: 220 pass, 0 fail.
- Bộ test Web Adapters (7 files): 59 pass, 0 fail.
- `bun run build`: Pass.
- `bun run typecheck`: 0 lỗi trong `src/`, giữ nguyên baseline 288 lỗi legacy trên 35 files `tests/` và `scripts/`.

