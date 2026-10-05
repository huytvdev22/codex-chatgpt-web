# Nhiệm vụ

Tạo mới file:

AGENTS.md

ở thư mục root của project.

Mục tiêu:

Thiết lập bộ quy tắc kiến trúc, quy tắc phát triển và quy tắc refactor dành cho tất cả AI Coding Agents làm việc trong repository này.

File này sẽ được sử dụng bởi:

- Antigravity
- Codex
- Claude Code
- Gemini CLI
- Copilot Agents
- Các AI coding assistants khác

Mọi nội dung phải phản ánh chính xác kiến trúc hiện tại của project.

Không được tạo các quy tắc mâu thuẫn với source code hiện có.

---

# Cấu trúc mong muốn

# AGENTS.md

## Project Overview

Mô tả ngắn:

- Dự án là gì
- Vai trò của M365 Copilot Adapter
- Mục tiêu chính của adapter

---

## Architecture Principles

Dự án tuân theo:

- Modular Architecture
- Technical Slicing
- Explicit Named Exports
- Backward Compatibility First
- Single Responsibility Principle
- Zero Breaking Changes

Mọi thay đổi phải tôn trọng các nguyên tắc này.

---

## M365 Adapter Architecture

Nêu rõ cấu trúc:

```text
src/adapters/m365-copilot/

session/
guards/
normalization/
prompts/
browser/
translation/
tools/
harness/
temp-chat/
```

Giải thích ngắn trách nhiệm từng module.

---

## Dependency Rules

### Allowed

normalization
→ canonical-types

prompts
→ templates

browser
→ translation

tools
→ command-strategies

session
→ internal state

### Forbidden

tools
✗ browser

browser
✗ tool execution

translation
✗ prompt assembly

session
✗ browser

prompt templates
✗ compiler

Không được tạo circular dependency.

---

## Circular Dependency Policy

Bắt buộc:

- Không tạo dependency cycle.
- Khi thêm import mới phải kiểm tra direction dependency.
- Nếu cần chia sẻ logic, tạo shared utility hoặc module trung gian.
- Không giải quyết circular dependency bằng lazy import trừ khi được yêu cầu rõ ràng.

---

## Export Policy

Ưu tiên:

```ts
export {
  MyClass,
  myFunction,
};
```

Không khuyến khích:

```ts
export * from "...";
```

trừ các facade compatibility layers đã tồn tại.

---

## Backward Compatibility Policy

Các facade cũ phải tiếp tục hoạt động:

```text
prompt.ts
prompts.ts
prompt-strategy.ts
markdown.ts
output-translator.ts
tool-bridge.ts
strategies/*
```

Không được xóa hoặc thay đổi contract public nếu chưa có migration plan.

---

## Refactoring Rules

Khi refactor:

1. Dependency Mapping trước.
2. Xác định public APIs.
3. Tạo compatibility layer.
4. Chạy test.
5. Chạy facade audit.
6. Xác nhận không có circular dependency.

Không được move file hàng loạt mà không bảo toàn imports hiện có.

---

## Testing Requirements

Mọi thay đổi trong:

```text
src/adapters/m365-copilot/
```

phải chạy:

```bash
bun test tests/m365-*.test.ts

bun test tests/codex-*.test.ts

bun test tests/prompt-strategy.test.ts
```

Nếu có thay đổi kiến trúc:

```bash
node scratch/dependency-map.js
```

---

## Public API Contract

Khi thêm hoặc xóa export:

- Cập nhật inventory public API.
- Cập nhật facade tương ứng.
- Đảm bảo consumer hiện tại không bị phá vỡ.

Backward compatibility là yêu cầu bắt buộc.

---

## Technical Debt Roadmap

### browser-worker.ts

Ứng viên refactor tiếp theo.

Mục tiêu:

```text
browser/
├─ cdp/
├─ dom/
└─ streaming/
```

Trigger:

- >1500 LOC
- CDP complexity tăng

### output-translator.ts

Ứng viên refactor tiếp theo.

Mục tiêu:

```text
translation/
├─ detectors/
│ ├─ patch
│ ├─ json
│ ├─ xml
│ └─ bash
```

Trigger:

- thêm detector mới
- protocol mới

### CI Dependency Gate

Khuyến nghị duy trì:

```bash
node scratch/dependency-map.js
```

hoặc:

```bash
madge --circular src/adapters/m365-copilot
```

Fail build nếu phát hiện circular dependency.

---

## Agent Behavior

Khi được yêu cầu thay đổi code:

1. Đọc module liên quan trước.
2. Hiểu dependency graph trước khi sửa.
3. Ưu tiên sửa tối thiểu.
4. Không refactor ngoài phạm vi yêu cầu.
5. Không tự ý đổi public API.
6. Không tự ý xóa compatibility facade.
7. Giữ kiến trúc modular hiện tại.

Nếu phát hiện rủi ro kiến trúc:

- nêu rõ rủi ro
- mô tả impact
- đề xuất migration plan

trước khi sửa code.

---

## Success Criteria

Một thay đổi chỉ được coi là hoàn thành khi:

- Build pass
- Test pass
- Không có circular dependency
- Không phá vỡ public API
- Không làm suy giảm modular boundaries