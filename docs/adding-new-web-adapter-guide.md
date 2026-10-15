# Cẩm Nang Chuẩn Hóa Tích Hợp Web Adapter Mới (SOP)

Tài liệu này là quy trình chuẩn (Standard Operating Procedure - SOP) từ đầu đến cuối để tích hợp một AI Web Adapter mới (như Gemini Web, Claude Web, Perplexity, DeepSeek...) vào hệ thống `codex-chatgpt-web`.

Mọi Web Adapter trong hệ thống đều tuân thủ nguyên tắc: **Unified Protocol (`<webResponse>`), Native-first Tool Forwarding, Clean Extraction, và Tích hợp Launcher mượt mà.**

---

## Mục lục
1. [Khảo sát Giao diện Web của AI Target (DOM Selectors)](#1-khảo-sát-giao-diện-web-của-ai-target)
2. [Cấu hình Model Catalog & Mức độ Thinking](#2-cấu-hình-model-catalog--mức-độ-thinking)
3. [Tự động hóa Chọn Model & Cấp độ Tư duy (Capability Picker)](#3-tự-động-hóa-chọn-model--cấp-độ-tư-duy-capability-picker)
4. [Tái sử dụng Prompt Pipeline & Kịch bản Hội thoại](#4-tái-sử-dụng-prompt-pipeline--kịch-bản-hội-thoại)
5. [Cơ chế Trích xuất Nội dung Đa tầng (Copy Button Salvage)](#5-cơ-chế-trích-xuất-nội-dung-đa-tầng-copy-button-salvage)
6. [Bóc tách Nghiêm ngặt (Strict Parser), Quarantine & Format Retry](#6-bóc-tách-nghiêm-ngặt-strict-parser-quarantine--format-retry)
7. [Chuẩn hóa Tên Công cụ & Tham số (Tool Normalizer & Bridge)](#7-chuẩn-hóa-tên-công-cụ--tham-số-tool-normalizer--bridge)
8. [Tích hợp Giao diện Launcher Electron](#8-tích-hợp-giao-diện-launcher-electron)
9. [Định tuyến Server & Router](#9-định-tuyến-server--router)
10. [Checklist Kiểm thử Hoàn chỉnh](#10-checklist-kiểm-thử-hoàn-chỉnh)

---

## 1. Khảo sát Giao diện Web của AI Target
Mở trình duyệt DevTools trên trang web AI đích và thu thập các Selector sau (đặt vào `src/adapters/<adapter-name>/selectors.ts`):

- **`appUrl`**: Đường dẫn trang chính (ví dụ: `https://gemini.google.com/app`).
- **`composerInput`**: Khung soạn thảo tin nhắn (ví dụ: `rich-textarea div[contenteditable="true"]`, `textarea`, `div[role="textbox"]`).
- **`sendButton`**: Nút gửi prompt (ví dụ: `button[aria-label*="Gửi" i]`, `button[aria-label*="Send" i]`).
- **`stopButton`**: Nút dừng khi đang sinh văn bản.
- **`responseContainer`**: Vùng chứa câu trả lời của AI (`model-response`, `message-content`, `div[role="article"]`).
- **`codeContainer`**: Vùng chứa code block Markdown (`code[data-test-id="code-content"]`, `pre code`).
- **`codeBlockHeader`**: Header của code block chứa tên ngôn ngữ và nút copy (`.code-block-decoration`, `.buttons`).
- **`codeCopyButton`**: Nút "Sao chép mã" bên trong code block (`gem-icon-button[data-test-id="gem-copy-button"] button`, `button[aria-label*="Sao chép mã" i]`).
- **`modelSelectorButton`**: Nút mở menu chuyển đổi model.
- **`modelOptionItem`**: Thẻ chọn model trong menu.

---

## 2. Cấu hình Model Catalog & Mức độ Thinking
File quản lý: `src/model-catalog.ts` và file model riêng `src/<name>-models.ts`.

1. **Định nghĩa danh sách Model**:
   Mọi model mới phải hỗ trợ đủ 3 mức tư duy trong `supported_reasoning_efforts`:
   ```typescript
   export const GEMINI_MODEL_DEFINITIONS: ModelDefinition[] = [
     {
       id: "gemini-web/3.8-flash",
       display_name: "Gemini 2.5 Flash",
       description: "Model mặc định tốc độ cao, hỗ trợ tư duy sâu",
       supported_reasoning_efforts: [
         { effort: "low", description: "Tư duy nhanh" },
         { effort: "medium", description: "Tư duy tiêu chuẩn" },
         { effort: "high", description: "Tư duy chuyên sâu" },
       ],
       default_reasoning_effort: "medium",
     },
     // ... các model route khác
   ];
   ```
2. **Đồng bộ Catalog tự động**:
   Trong hàm `ensureManagedModelCatalogFile()`, đảm bảo kiểm tra danh sách model của adapter mới:
   - Nếu catalog cũ thiếu model hoặc thiếu mức reasoning, tự động ghi đè/bổ sung vào `~/.codex-m365-copilot/catalog.json`.

---

## 3. Tự động hóa Chọn Model & Cấp độ Tư duy (Capability Picker)
File quản lý: `src/adapters/<adapter-name>/capability-picker.ts`.

Quy trình tự động hóa thao tác trên giao diện:
1. **Tìm nút Trigger Menu**:
   - Lưu ý các Web Component bọc ngoài (ví dụ `<gem-button>` bọc ngoài `<button>`). Cần tìm đúng thẻ cha mang `data-test-id` hoặc `aria-label`.
2. **Mở Menu & Chờ Render**:
   - Click trigger button và chờ phần tử menu xuất hiện (`role="menu"` hoặc `[data-visible="true"]`).
3. **Chọn Model**:
   - Tìm option tương ứng với slug được yêu cầu, scroll vào tầm nhìn (`scrollIntoViewIfNeeded`) và click.
4. **Chọn Thinking Level (nếu là Accordion / Submenu)**:
   - Nếu cấp độ tư duy nằm trong accordion xổ dọc (như `gem-menu-item[value="thinking_level"]`), kiểm tra thuộc tính `aria-expanded="true"`:
     - Nếu chưa mở: click để mở accordion.
     - Sau khi mở: click chọn đúng item `Thấp` / `Trung bình` / `Cao` dựa vào `reasoningEffort`.
5. **Đóng Menu An toàn**:
   - Nhấn phím `Escape` hoặc click ra ngoài để đóng menu, tránh che khuất khung nhập prompt.

---

## 4. Tái sử dụng Prompt Pipeline & Kịch bản Hội thoại
**TUYỆT ĐỐI KHÔNG VIẾT LẠI PROMPT TỪ ĐẦU!** Tất cả các adapter đều dùng chung hệ thống Prompt của M365 Copilot.

Trong `src/adapters/<adapter-name>/index.ts`:
```typescript
import { CodexRawPayload, CodexPayloadNormalizer } from "../m365-copilot/normalization";
import { M365PromptCompiler } from "../m365-copilot/prompts";

private compilePrompt(parsed: CodexParsedRequest, isNewConversation: boolean): string {
  const rawPayload = CodexRawPayload.from(parsed._rawBody || parsed);
  const normalized = CodexPayloadNormalizer.normalize(rawPayload);
  
  // Khởi tạo Compiler với tên trợ lý động
  const compiler = new M365PromptCompiler({ assistantName: "<Tên Trợ Lý>" });
  const compileResult = compiler.compile({
    normalized,
    parsed,
    isNewConversation,
    assistantName: "<Tên Trợ Lý>",
  });
  
  return compileResult.finalPrompt;
}
```

Hệ thống sẽ tự động cung cấp:
- **Turn 1**: Chào hỏi + Thỏa thuận giao thức `<webResponse>` + Danh sách công cụ chi tiết (Available Tools Inventory).
- **Turn 2+**: Danh sách công cụ rút gọn + Kết quả tool trước đó trong thẻ `<tool_result id="...">`.
- **Plan Mode**: Kích hoạt giao diện duyệt `<proposed_plan>` khi người dùng yêu cầu `/plan`.
- **Interactive Interview Wizard**: Hỗ trợ gọi tool `request_user_input`.

---

## 5. Cơ chế Trích xuất Nội dung Đa tầng (Copy Button Salvage)
File quản lý: `src/adapters/<adapter-name>/<name>-browser-worker.ts`.

Khi AI sinh câu trả lời trong khối Markdown transport fence, giao diện web thường sinh DOM phức tạp kèm rác trang trí. Giải pháp cứu dữ liệu 2 tầng:

### Bước 1: Cài đặt Clipboard Hook trước khi gửi Prompt
```typescript
await page.evaluate(() => {
  const win = window as any;
  win.__last_copied_code = "";
  if (navigator.clipboard) {
    const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text: string) => {
      win.__last_copied_code = text;
      try { return originalWriteText(text); } catch { return Promise.resolve(); }
    };
  }
  document.addEventListener("copy", (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text/plain") || window.getSelection()?.toString();
    if (text) win.__last_copied_code = text;
  }, { capture: true });
});
```

### Bước 2: Khi AI trả lời xong, áp dụng 2 tầng bóc tách:
- **Tầng 1 (Ưu tiên số 1 - Chuẩn 100% nguyên bản)**:
  Tìm nút `codeCopyButton` (nút "Sao chép mã" của block code Markdown) và click vào đó:
  ```typescript
  await copyBtn.click();
  const text = await page.evaluate(() => (window as any).__last_copied_code);
  ```
  Nhận ngay payload Markdown/XML nguyên bản mà **không cần quyền OS clipboard** và **không ghi đè clipboard của user**.
- **Tầng 2 (Dự phòng thông minh)**:
  Nếu không có nút copy, đọc DOM từ `responseContainer` và tự động bóc tách loại bỏ các phần tử rác trang trí (`.code-block-decoration`, `.buttons`, nút download mã...).

---

## 6. Bóc tách Nghiêm ngặt (Strict Parser), Quarantine & Format Retry
File quản lý: `src/adapters/<adapter-name>/index.ts`.

1. **Quarantine (Cách ly)**:
   Không emit text trực tiếp ra Codex trong lúc AI đang gõ để tránh rò rỉ thẻ `<webResponse>` hoặc thẻ suy nghĩ `<thought>`.
2. **Strict Parser (`parseStrictM365Response`)**:
   - Nếu là câu trả lời (`final_answer`): Bóc sạch thẻ `<webResponse>`, gửi text thuần sạch đẹp sang Codex.
   - Nếu là gọi công cụ (`tool_calls`): Trích xuất các thẻ `<tool_call>` hoặc `<custom_tool_call name="apply_patch">`.
3. **Format Retry (Tự sửa lỗi định dạng)**:
   - Nếu AI trả về sai format hoặc gọi tool không hợp lệ: gửi `buildM365FormatRetryPrompt({ code, message })` yêu cầu AI phát lại cùng nội dung theo đúng chuẩn format (tối đa 2-3 lần).

---

## 7. Chuẩn hóa Tên Công cụ & Tham số (Tool Normalizer & Bridge)
File quản lý: `src/adapters/m365-copilot/tools/argument-normalizer.ts` & `tool-bridge.ts`.

1. **Bổ sung Alias Tên Công cụ**:
   Các mô hình AI thường gọi tên công cụ theo thói quen (`execute_command`, `bash`, `shell`, `terminal` thay vì `exec_command`).
   Bổ sung alias vào `TOOL_NAME_ALIASES`:
   ```typescript
   execute_command: "exec_command",
   bash: "exec_command",
   shell: "exec_command",
   terminal: "exec_command",
   run_cmd: "exec_command",
   ```
2. **Chuẩn hóa Tham số**:
   Tự động ánh xạ `command` -> `cmd`, `file` -> `path`, `patch` -> `input`.
3. **Emit Native Tool Calls qua M365ToolBridge**:
   Khi phát hiện tool calls, luôn chuẩn hóa qua `M365ToolBridge.mapToolCall(call, clientTools)` trước khi emit ra Codex:
   ```typescript
   for (const rawCall of protocolResult.calls) {
     const mapped = M365ToolBridge.mapToolCall(rawCall, clientTools);
     emit({
       type: "tool_call_start",
       id: callId,
       name: mapped.name,
     });
     emit({
       type: "tool_call_delta",
       arguments: typeof mapped.arguments === "string" ? mapped.arguments : JSON.stringify(mapped.arguments),
     });
     emit({ type: "tool_call_end" });
   }
   ```

---

## 8. Tích hợp Giao diện Launcher Electron

1. **Khai báo Partition độc lập**:
   Trong `launcher/electron/browser-host.cjs`:
   - Định nghĩa URL: `<NAME>_CHAT_URL`.
   - Tạo phân vùng độc lập: `persist:codex-<name>-web`.
   - Thêm vào mảng `allowedPartitions` trong cả Electron lẫn Core descriptor validation (`src/launcher-browser-host.ts`).
2. **Khởi tạo WebContentsView**:
   - `this.<name>View = new WebContentsView({ webPreferences: { partition: ... } })`.
   - Xử lý `switchProvider(provider)` để ẩn/hiện view và set bounds chuẩn xác.
3. **Quy trình Xác thực & Smoke Test**:
   - `probeAuthentication()`: Kiểm tra URL, phát hiện nút đăng nhập hoặc composer.
   - `runSmokeTest()`: Gửi prompt xác nhận `CODEX WEB GPT READY`, kiểm tra câu trả lời xuất hiện trong DOM.
4. **Giao diện Người dùng Launcher (`launcher/src/App.tsx`)**:
   - Thêm tab điều hướng trên Sidebar.
   - Thêm màn hình Setup 2 bước (Đăng nhập -> Smoke Test).
   - Thêm nút đổi provider trong Settings.

---

## 9. Định tuyến Server & Router
File quản lý: `src/server.ts`.

1. **Đăng ký Routes**:
   Bổ sung `available<Name>ModelRoutes()` vào endpoint `/models` để Codex IDE hiển thị danh sách model.
2. **Định tuyến Turn**:
   Trong router điều phối, kiểm tra nếu `is<Name>ModelSlug(modelId)` thì khởi tạo và ủy quyền lượt chạy cho `<Name>WebAdapter`.

---

## 10. Checklist Kiểm thử Hoàn chỉnh

Chạy lần lượt các bước sau để xác nhận tích hợp thành công:

1. **Typecheck toàn bộ codebase**:
   ```bash
   bun run typecheck
   ```
2. **Chạy Unit Tests của Adapter**:
   ```bash
   bun test tests/<name>-web-adapter.test.ts
   ```
   Đảm bảo các test case sau đều xanh:
   - Nhận diện model slug & capability.
   - Model Catalog trả về đủ 3 mức reasoning.
   - Bóc tách strict-parser từ thẻ `<webResponse>`.
   - Chuẩn hóa alias tool (`execute_command` -> `exec_command(cmd)`).
3. **Build Launcher UI**:
   ```bash
   bun run --cwd launcher build
   ```
4. **Chạy Thử nghiệm Trực quan**:
   ```bash
   bun run --cwd launcher start
   ```
   - Đăng nhập thành công trên giao diện Launcher.
   - Nút Smoke Test báo xanh (Passed).
   - Gửi thử lệnh từ Codex IDE: kiểm tra AI chọn đúng model, chạy tool lệnh terminal và bóc tách câu trả lời sạch đẹp không còn thẻ XML.
