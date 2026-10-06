# AGENTS.md

> **Quy chuẩn kiến trúc, phát triển và tái cấu trúc cho AI Coding Agents**  
> Áp dụng cho: Antigravity, Codex, Claude Code, Gemini CLI, Copilot Agents và các AI assistants khác khi làm việc trên repository này.  
> Mục tiêu cốt lõi: Bảo toàn kiến trúc module, triệt tiêu phụ thuộc vòng (Zero Circular Dependencies), và đảm bảo tính tương thích ngược tuyệt đối (100% Backward Compatibility).

---

## Project Overview

- **Dự án là gì**: [codex-chatgpt-web](file:///d:/HUYTVDEV/codex-chatgpt-web/README.md) là cầu nối cục bộ (Responses API Bridge) cho phép nhà phát triển sử dụng các mô hình ChatGPT Web và Microsoft 365 Copilot trực tiếp từ môi trường Codex IDE trên máy trạm mà không tiêu tốn hạn ngạch API trả phí (Work/Codex quota).
- **Vai trò của M365 Copilot Adapter**: Nằm tại thư mục [src/adapters/m365-copilot/](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/), là một implementation của interface [ProviderAdapter](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/base.ts). Adapter chịu trách nhiệm tiếp nhận request chuẩn từ Codex IDE, biên dịch prompt đặc thù, tự động hóa tương tác qua giao thức Chrome DevTools Protocol (CDP) trong Desktop Launcher, thu nhận stream phản hồi từ giao diện M365 Copilot Web và dịch ngược thành các cuộc gọi công cụ (Tool Calls) chuẩn OpenAI.
- **Mục tiêu chính của adapter**:
  - Biến giao diện chat web của Microsoft 365 Copilot thành một Autonomous Coding Agent thực thụ.
  - Hỗ trợ đầy đủ các thao tác đọc/ghi file an toàn (kèm băm SHA256), áp dụng unified patch và thực thi lệnh shell (POSIX/PowerShell).
  - Bảo đảm an toàn ngữ cảnh, ngăn chặn vòng lặp vô hạn và bảo vệ độ nguyên vẹn của luồng streaming.

---

## Architecture Principles

Mọi thay đổi mã nguồn trong repository này bắt buộc phải tuân thủ nghiêm ngặt 6 nguyên lý kiến trúc:

1. **Modular Architecture**: Mã nguồn được chia ranh giới theo các thư mục phân hệ chức năng rõ ràng. Không được trộn lẫn hạ tầng (browser/CDP) với logic nghiệp vụ (domain/normalization/translation).
2. **Technical Slicing**: Phân lớp kỹ thuật rõ ràng theo chiều ngang: Ingress Normalization $\rightarrow$ Prompt Engineering $\rightarrow$ Browser Automation $\rightarrow$ Grammar Output Translation $\rightarrow$ Tool Bridge Execution.
3. **Explicit Named Exports**: Xuất tường minh các symbol tại file `index.ts` của từng phân hệ. Không xuất bừa bãi hoặc làm rò rỉ các cài đặt private.
4. **Backward Compatibility First**: Ưu tiên bảo toàn tính tương thích ngược. Bất kỳ sự tái cấu trúc nội bộ nào cũng không được làm hỏng các import path và contract cũ.
5. **Single Responsibility Principle (SOLID)**: Mỗi module, class, hàm chỉ đảm nhận một trách nhiệm duy nhất (ví dụ: tách riêng Stateless Guards và Stateful Session Management).
6. **Zero Breaking Changes**: Không tạo ra breaking change đối với các consumers và test suites hiện có. Mọi thay đổi public API đều phải có kế hoạch chuyển dịch (migration path) rõ ràng.

---

## M365 Adapter Architecture

Cấu trúc phân hệ tại [src/adapters/m365-copilot/](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/):

```text
src/adapters/m365-copilot/
├── session/           # Quản lý trạng thái phiên, TTL cleanup và bộ chống lặp vô hạn (Loop Guard)
├── guards/            # Các bộ bảo vệ ngắt sớm không trạng thái (ví dụ: TitleGuard phản hồi trong 5ms)
├── normalization/     # Chuẩn hóa Ingress payload từ Codex IDE sang Canonical Domain Model
├── prompts/           # Kỹ thuật prompt phân tầng: mẫu tĩnh (templates), compiler và assembler
├── browser/           # Tự động hóa trình duyệt qua Playwright CDP, điều khiển capability picker
├── translation/       # Phân tích ngữ pháp đa hình thức, lọc rò rỉ streaming và specialized detectors
├── tools/             # Cầu nối công cụ (Tool Bridge), atomic file writer và command strategies đa nền tảng
├── harness/           # Khung kiểm thử và đánh giá độc lập (M365AgentLoop, LocalToolExecutor)
└── temp-chat/         # Chế độ Stateless Temporary Chat Per Request và Live DOM Scraper
```

### Trách nhiệm từng module:

- [session/](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/session/): Theo dõi trạng thái in-memory của từng `conversationKey`, tính toán fingerprint công cụ ổn định (`stableToolFingerprint`), phát hiện và ngắt sớm vòng lặp vô hạn (`MAX_TOOL_ITERATIONS = 100`, `MAX_IDENTICAL_TOOL_CALLS = 10`), tự động dọn dẹp bộ nhớ theo TTL (15 phút).
- [guards/](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/guards/): Bộ bảo vệ ngắt nhanh không trạng thái (`title-guard.ts`). Đánh chặn các request sinh tiêu đề cuộc hội thoại ngầm và phản hồi ngay lập tức trong 5ms mà không cần gọi browser.
- [normalization/](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/normalization/): Tiếp nhận raw JSON payload (`CodexRawPayload`), bảo toàn snapshot bất biến và chuyển đổi thành cấu trúc chuẩn [NormalizedCodexRequest](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/normalization/canonical-types.ts).
- [prompts/](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/prompts/): Hệ thống prompt 3 tầng: `templates.ts` (mẫu tĩnh), `compiler.ts` (trình biên dịch chỉ dẫn công cụ động), `assembler.ts` (lắp ráp prompt hoàn chỉnh và cắt tỉa ngữ cảnh).
- [browser/](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/browser/): Quản lý vòng đời kết nối CDP với Desktop Launcher, chọn model phù hợp trên giao diện người dùng (`capability-picker.ts`) và điều khiển luồng chat trình duyệt (`browser-worker.ts`).
- [translation/](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/translation/): Tiếp nhận chuỗi phản hồi thô, chặn rò rỉ cú pháp tool call trong lúc stream (`toolcall-detector.ts`) và dịch sang Tool Call chuẩn thông qua chuỗi Detectors chuyên biệt (`patch`, `json`, `xml`, `bash`).
- [tools/](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/tools/): Ánh xạ lời gọi công cụ sang lệnh phía client ([M365ToolBridge](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/tools/tool-bridge.ts)), ghi file phân đoạn kèm băm kiểm tra ([AtomicFileWriter](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/tools/atomic-file-writer.ts)) và các chiến lược lệnh shell đa nền tảng ([POSIX](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/tools/command-strategies/posix.ts) / [PowerShell](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/tools/command-strategies/powershell.ts)).
- [harness/](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/harness/): Cung cấp vòng lặp Agent khép kín phục vụ kiểm thử đánh giá benchmark và chạy kịch bản tự động hóa ngoại tuyến mà không cần Codex IDE.
- [temp-chat/](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/temp-chat/): Chế độ trò chuyện tạm thời không lưu lịch sử, bọc prompt với cú pháp 4-backtick và trích xuất dữ liệu DOM thời gian thực ([FastPathStreamBuffer](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/temp-chat/fastPathScraper.ts)).

---

## Dependency Rules

### Allowed (Phụ thuộc hợp lệ)

- `normalization` $\rightarrow$ `canonical-types`
- `prompts` $\rightarrow$ `templates`
- `browser` $\rightarrow$ `translation` (chỉ dùng semantic detector & scraper helpers)
- `tools` $\rightarrow$ `command-strategies`
- `session` $\rightarrow$ internal state & pure types

### Forbidden (Phụ thuộc bị nghiêm cấm)

- `tools` $\boldsymbol{\times}$ `browser`: Logic tool execution và OS scripting tuyệt đối không được dính líu đến Playwright hoặc browser context.
- `browser` $\boldsymbol{\times}$ `tool execution`: Browser chỉ nhận text và stream delta, không trực tiếp thực thi tool.
- `translation` $\boldsymbol{\times}$ `prompt assembly`: Tầng dịch ngữ pháp đầu ra không được phụ thuộc ngược vào prompt compiler hay prompt assembler.
- `session` $\boldsymbol{\times}$ `browser`: Quản lý phiên chỉ theo dõi logic và state, không được gọi browser.
- `prompt templates` $\boldsymbol{\times}$ `compiler`: Tầng template chỉ chứa hằng số tĩnh, cấm import ngược từ compiler engine.

> **QUY TẮC CỐT LÕI**: Tuyệt đối không được tạo Circular Dependency giữa bất kỳ module nào.

---

## Circular Dependency Policy

Bắt buộc tuân thủ:

1. **Không tạo dependency cycle**: Bất kỳ chu kỳ phụ thuộc nào ($A \rightarrow B \rightarrow A$ hoặc chuỗi dài hơn) đều bị cấm hoàn toàn.
2. **Kiểm tra chiều phụ thuộc (Direction Check)**: Trước khi thêm một import mới, kiểm tra đồ thị phụ thuộc để đảm bảo chỉ import từ tầng thấp hơn hoặc cùng tầng độc lập.
3. **Trích xuất Shared Utility**: Nếu hai module cần chia sẻ logic hoặc kiểu dữ liệu, bắt buộc phải trích xuất ra một file utility/types trung gian độc lập.
4. **Không giải quyết bằng Lazy Import**: Tuyệt đối không sử dụng `import()` động bên trong thân hàm để che giấu circular dependency, trừ khi có yêu cầu kiến trúc rõ ràng và được phê duyệt.

---

## Export Policy

### Ưu tiên: Explicit Named Exports

Mọi file và thư mục subsystem mới phải sử dụng cú pháp xuất tường minh:

```ts
export {
  MyClass,
  myFunction,
  type MyInterface,
};
```

### Không khuyến khích: Wildcard Re-export

```ts
export * from "..."; // Tránh dùng cho code mới
```

Ngoại lệ: Chỉ được sử dụng `export *` cho **các facade compatibility layers đã tồn tại** tại thư mục gốc nhằm đảm bảo tương thích ngược 100%.

---

## Backward Compatibility Policy

Các facade tương thích ngược tại thư mục gốc [src/adapters/m365-copilot/](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/) bắt buộc phải tiếp tục hoạt động ổn định:

- [prompt.ts](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/prompt.ts)
- [prompts.ts](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/prompts.ts)
- [prompt-strategy.ts](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/prompt-strategy.ts)
- [markdown.ts](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/markdown.ts)
- [output-translator.ts](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/output-translator.ts)
- [tool-bridge.ts](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/tool-bridge.ts)
- [strategies/*](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/strategies/)

**Quy định bất biến**: Không được xóa hoặc thay đổi hợp đồng public API của các facade này nếu chưa có kế hoạch di chuyển (migration plan) chi tiết và được kiểm thử toàn diện.

---

## Refactoring Rules

Khi thực hiện bất kỳ công việc refactor nào, Agent phải tuân thủ nghiêm ngặt quy trình 6 bước:

1. **Dependency Mapping trước**: Lập bản đồ phụ thuộc của các module dự định chỉnh sửa.
2. **Xác định Public APIs**: Liệt kê toàn bộ các symbols (classes, functions, types, constants) đang được export cho bên ngoài.
3. **Tạo Compatibility Layer**: Duy trì facade hoặc adapter để các import cũ không bị đứt gãy.
4. **Chạy test**: Chạy toàn bộ test suites liên quan để kiểm chứng chức năng.
5. **Chạy Facade Audit**: Kiểm tra bài test toàn vẹn API (`m365-architecture-integrity.test.ts`).
6. **Xác nhận không có circular dependency**: Chạy công cụ kiểm tra chu kỳ để đảm bảo đồ thị phụ thuộc vẫn là Directed Acyclic Graph (DAG).

> **Cảnh báo**: Nghiêm cấm di chuyển (move/rename) hàng loạt các file mà không tạo lớp tương thích bảo toàn các đường dẫn import hiện có.

---

## Testing Requirements

Mọi thay đổi trong [src/adapters/m365-copilot/](file:///d:/HUYTVDEV/codex-chatgpt-web/src/adapters/m365-copilot/) bắt buộc phải chạy và vượt qua các bộ kiểm thử:

```bash
# Kiểm tra bộ test adapter M365 (140+ bài test)
bun test tests/m365-*.test.ts

# Kiểm tra bộ test chuẩn hóa Codex wire/payload
bun test tests/codex-*.test.ts

# Kiểm tra bộ test prompt & token limits
bun test tests/prompt-strategy.test.ts
```

*(Lưu ý trên môi trường Windows PowerShell, có thể chạy lọc theo tiền tố: `bun test tests/m365`, `bun test tests/codex`, `bun test tests/prompt-strategy.test.ts`)*

Nếu có thay đổi về mặt cấu trúc file hoặc thêm/sửa đổi imports, bắt buộc phải chạy kiểm tra cổng kiến trúc:

```bash
node scratch/dependency-map.js
```

hoặc sử dụng bộ công cụ CI đã cấu hình trong dự án:

```bash
bun run check:architecture
# tương đương: node scripts/check-circular-deps.js && bun test tests/m365-architecture-integrity.test.ts
```

---

## Public API Contract

Khi thêm hoặc xóa bất kỳ export nào:

1. **Cập nhật Inventory Public API**: Đăng ký các symbol mới vào bảng danh mục API chính thức của phân hệ.
2. **Cập nhật Facade tương ứng**: Bảo đảm facade tại thư mục gốc tiếp tục re-export symbol đó nếu nó nằm trong hợp đồng tương thích.
3. **Bảo toàn Consumer**: Đảm bảo toàn bộ consumer (các file trong `src/`, `tests/` và Launcher) không bị gãy interface.

> **Backward compatibility là yêu cầu bắt buộc, không phải là tùy chọn.**

---

## Technical Debt Roadmap

### 1. `browser-worker.ts`

- **Trạng thái**: Ứng viên refactor tiếp theo.
- **Hiện trạng**: Đang quản lý đồng thời kết nối CDP, DOM injection và streaming loop.
- **Mục tiêu phân rã**:
  ```text
  browser/
  ├── cdp/         # Kết nối CDP, session attachment, lifecycle
  ├── dom/         # Selector query, ProseMirror input, button actions
  └── streaming/   # Quan sát Live DOM, streaming delta, điều kiện ngắt
  ```
- **Trigger kích hoạt**:
  - Quy mô file vượt quá **1500 LOC**.
  - Độ phức tạp giao thức CDP tăng thêm (network intercepting, multi-tab multiplexing).

### 2. `output-translator.ts`

- **Trạng thái**: Tiếp tục duy trì và mở rộng theo kiến trúc phân rã detectors.
- **Mục tiêu**:
  ```text
  translation/
  └── detectors/
      ├── patch/   # Codex Unified Diff format
      ├── json/    # OpenAI Function Call JSON
      ├── xml/     # XML <tool_call> envelope
      └── bash/    # Shell terminal commands
  ```
- **Trigger kích hoạt**:
  - Bổ sung detector mới.
  - Hỗ trợ thêm tool execution protocol mới.

### 3. `CI Dependency Gate`

- **Khuyến nghị duy trì**:
  ```bash
  node scratch/dependency-map.js
  ```
  hoặc:
  ```bash
  node scripts/check-circular-deps.js
  ```
  hoặc:
  ```bash
  madge --circular src/adapters/m365-copilot
  ```
- **Quy tắc**: Tự động từ chối (Fail-fast build & PR gate) nếu phát hiện bất kỳ chu kỳ phụ thuộc nào (Cycles > 0).

---

## Agent Behavior

Khi được giao nhiệm vụ sửa đổi hoặc phát triển tính năng mới trong codebase:

1. **Đọc module liên quan trước**: Nắm rõ mục đích và triển khai hiện tại của file cần sửa.
2. **Hiểu dependency graph trước khi sửa**: Xác định file này đang được ai import và đang import những ai.
3. **Ưu tiên sửa tối thiểu**: Chỉ sửa đúng những gì cần thiết để đạt mục tiêu, tránh lan man.
4. **Không refactor ngoài phạm vi**: Tuyệt đối không tự ý refactor cấu trúc thư mục hoặc đổi tên hàm ngoài phạm vi yêu cầu của người dùng.
5. **Không tự ý đổi public API**: Giữ nguyên tên hàm, số lượng tham số, kiểu dữ liệu trả về của các API công khai.
6. **Không tự ý xóa compatibility facade**: Giữ nguyên tất cả các file facade hiện có tại thư mục gốc.
7. **Giữ kiến trúc modular hiện tại**: Luôn phân loại mã nguồn mới vào đúng thư mục phân hệ phù hợp.

**Quy trình xử lý khi phát hiện rủi ro kiến trúc**:
Nếu phát hiện giải pháp được yêu cầu có nguy cơ tạo circular dependency hoặc breaking change:
- Nêu rõ rủi ro kiến trúc tiềm ẩn.
- Mô tả chi tiết mức độ ảnh hưởng (impact assessment).
- Đề xuất kế hoạch chuyển đổi an toàn (migration plan).
- Chờ người dùng xác nhận trước khi sửa đổi mã nguồn.

---

## Success Criteria

Một thay đổi của AI Agent chỉ được coi là **hoàn thành đạt chuẩn** khi đáp ứng đủ 5 tiêu chí:

1. ✅ **Build pass**: Trình biên dịch TypeScript không phát sinh lỗi cú pháp hay kiểu dữ liệu (`bun run typecheck` hoặc bun test).
2. ✅ **Test pass**: 100% các bài kiểm thử liên quan vượt qua thành công.
3. ✅ **Không có circular dependency**: Script kiểm tra chu kỳ xác nhận `Cycles = 0`.
4. ✅ **Không phá vỡ public API**: Bài kiểm tra Facade Architecture Integrity đạt 100% Green.
5. ✅ **Không làm suy giảm modular boundaries**: Ranh giới giữa các phân hệ được giữ gìn nguyên vẹn, tuân thủ đúng Dependency Rules.
