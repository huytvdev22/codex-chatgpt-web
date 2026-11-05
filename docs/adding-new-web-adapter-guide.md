# Cẩm Nang Chuẩn Hóa Tích Hợp Web Adapter Mới (SOP)

Tài liệu này là quy trình chuẩn (Standard Operating Procedure - SOP) từ đầu đến cuối để tích hợp một AI Web Adapter mới (như Claude Web, Perplexity, DeepSeek...) vào hệ thống `codex-chatgpt-web`.

Kể từ sau đợt chuẩn hóa kiến trúc **Shared Web Turn Engine**, mọi Web Provider đều tuân theo phân tầng thống nhất:

```text
ProviderAdapter (src/adapters/base.ts)
    ↓
WebProviderAdapter (src/adapters/web/web-provider-adapter.ts)
    ↓
WebTurnEngine (src/adapters/web/engine.ts)
    ↓
WebProviderDefinition (src/adapters/web/definition.ts)
    ↓
Provider-specific Drivers & Policies (conversation, capability, attachments, browser, response, policies)
```

> **Nguyên tắc vàng khi thêm Provider mới:**
>
> ```text
> Khảo sát website
> → Triển khai provider-specific browser worker & capability picker
> → Khai báo WebProviderDefinition (drivers + policies)
> → Kế thừa WebProviderAdapter
> → Đăng ký model tại src/models/ và tích hợp Launcher/Server
> → Chạy bộ contract tests & architecture gates
> ```
>
> **TUYỆT ĐỐI KHÔNG** tự viết lại `runTurn()`, không tự gọi `startLauncherBrowserTurn`/`endLauncherBrowserTurn`, `runWebProtocolRetry`, `parseStrictWebResponse`, `validateWebProtocolResponse` hay `emitWebProtocolResponse` trong `src/adapters/<provider>/index.ts`. Toàn bộ điều phối vòng đời lượt chạy đã thuộc về `WebTurnEngine`.

---

## Mục lục
1. [Cấu trúc Thư mục của một Web Adapter Chuẩn](#1-cấu-trúc-thư-mục-của-một-web-adapter-chuẩn)
2. [Khảo sát Giao diện Web của AI Target (DOM Selectors)](#2-khảo-sát-giao-diện-web-của-ai-target-dom-selectors)
3. [Tự động hóa Chọn Model & Cấp độ Tư duy (Capability Picker)](#3-tự-động-hóa-chọn-model--cấp-độ-tư-duy-capability-picker)
4. [Trích xuất Phản hồi, Copy-Button Salvage & Raw Stream Quarantine](#4-trích-xuất-phản-hồi-copy-button-salvage--raw-stream-quarantine)
5. [Quản lý Hội thoại với `GenericConversationStore`](#5-quản-lý-hội-thoại-với-genericconversationstore)
6. [Khai báo `WebProviderDefinition`, Lifecycle Policies & Kế thừa `WebProviderAdapter`](#6-khai-báo-webproviderdefinition-lifecycle-policies--kế-thừa-webprovideradapter)
7. [Prompt Pipeline, Protocol `<webResponse>` & Tool Bridge Dùng Chung](#7-prompt-pipeline-protocol-webresponse--tool-bridge-dùng-chung)
8. [Đăng ký Model tại `src/models/` & Định tuyến Server](#8-đăng-ký-model-tại-srcmodels--định-tuyến-server)
9. [Tích hợp Giao diện Launcher Electron](#9-tích-hợp-giao-diện-launcher-electron)
10. [Checklist Kiểm thử & Cổng Kiến trúc (Architecture Gates)](#10-checklist-kiểm-thử--cổng-kiến-trúc-architecture-gates)

---

## 1. Cấu trúc Thư mục của một Web Adapter Chuẩn

Mỗi provider trong `src/adapters/<provider-name>/` chỉ chứa các file xử lý tương tác đặc thù với trang web đích:

```text
src/adapters/<provider-name>/
├── index.ts                 # Kế thừa WebProviderAdapter, khai báo WebProviderDefinition
├── browser-worker.ts        # Điều khiển Playwright Page, gửi prompt, trích xuất rawResponse
├── capability-picker.ts     # (Tuỳ chọn) Chọn model / chế độ tư duy trên UI
├── conversation-store.ts    # (Tuỳ chọn) Khóa hội thoại & lưu trữ qua GenericConversationStore
└── selectors.ts             # Bộ DOM selectors và hàm kiểm tra URL/conversationId
```

Không đặt logic điều phối protocol, prompt compiler hay tool bridge vào thư mục của provider.

---

## 2. Khảo sát Giao diện Web của AI Target (DOM Selectors)

Mở trình duyệt DevTools trên trang web AI đích và thu thập các Selector sau (đặt vào `src/adapters/<provider-name>/selectors.ts`):

- **`appUrl` / `newChatUrl`**: Đường dẫn trang chính (ví dụ: `https://gemini.google.com/app`).
- **`composerInput`**: Khung soạn thảo tin nhắn (`rich-textarea div[contenteditable="true"]`, `textarea`, `div[role="textbox"]`).
- **`sendButton`**: Nút gửi prompt (`button[aria-label*="Gửi" i]`, `button[aria-label*="Send" i]`).
- **`stopButton`**: Nút dừng khi đang sinh văn bản.
- **`responseContainer`**: Vùng chứa câu trả lời của AI (`model-response`, `message-content`, `div[role="article"]`).
- **`codeContainer`**: Vùng chứa code block Markdown (`code[data-test-id="code-content"]`, `pre code`).
- **`codeBlockHeader`**: Header của code block chứa tên ngôn ngữ và nút copy (`.code-block-decoration`, `.buttons`).
- **`codeCopyButton`**: Nút "Sao chép mã" bên trong code block (`button[aria-label*="Copy" i]`, `button[aria-label*="Sao chép mã" i]`).
- **`modelSelectorButton`** & **`modelOptionItem`**: Nút mở menu và thẻ chọn model/reasoning.

> **Ranh giới bắt buộc:** Tuyệt đối không đưa selector DOM riêng của provider vào `src/adapters/web/`. Cổng `bun run check:architecture` sẽ kiểm tra ranh giới này.

---

## 3. Tự động hóa Chọn Model & Cấp độ Tư duy (Capability Picker)

File quản lý: `src/adapters/<provider-name>/capability-picker.ts`.

Quy trình tự động hóa thao tác trên giao diện:
1. **Tìm nút Trigger Menu**: Lưu ý các Web Component bọc ngoài (ví dụ `<gem-button>` bọc ngoài `<button>`). Cần tìm đúng thẻ cha mang `data-test-id` hoặc `aria-label`.
2. **Mở Menu & Chờ Render**: Click trigger button và chờ phần tử menu xuất hiện (`role="menu"` hoặc `[data-visible="true"]`).
3. **Chọn Model**: Tìm option tương ứng với slug được yêu cầu, scroll vào tầm nhìn (`scrollIntoViewIfNeeded`) và click.
4. **Chọn Thinking Level (nếu là Toggle / Accordion / Submenu)**:
   - Kiểm tra trạng thái hiện tại trước khi click để tránh tắt nhầm chế độ đang bật.
   - Chọn đúng mức `low` / `medium` / `high` dựa vào `reasoningEffort` do `WebCapabilityPickerDriver` phân giải.
5. **Đóng Menu An toàn**: Nhấn phím `Escape` hoặc click ra ngoài để đóng menu, tránh che khuất khung nhập prompt.

---

## 4. Trích xuất Phản hồi, Copy-Button Salvage & Raw Stream Quarantine

File quản lý: `src/adapters/<provider-name>/browser-worker.ts`.

Browser worker chỉ có nhiệm vụ thực thi một attempt trên `Page` và trả về:

```ts
export interface WebBrowserTurnExecutionOutput {
  rawResponse: string;
  conversationId?: string;
}
```

### 4.1. Raw Stream Quarantine (Cách ly luồng thô)
Trong lúc AI đang sinh phản hồi trên trình duyệt, worker có thể theo dõi DOM/stream nội bộ (hoặc dùng `FastPathStreamBuffer`, `SemanticMarkdownBuffer`, `webHtmlToMarkdown` từ `src/adapters/web/protocol`), nhưng **TUYỆT ĐỐI KHÔNG** emit trực tiếp các chunk thô chưa qua kiểm duyệt ra Codex (`onChunk: () => {}`). Việc này ngăn rò rỉ thẻ `<webResponse>`, `<tool_call>` hoặc `<thought>` ra màn hình người dùng.

### 4.2. Cơ chế Trích xuất Nội dung Đa tầng (Copy Button Salvage)
Khi AI sinh câu trả lời trong khối Markdown transport fence, giao diện web thường sinh DOM phức tạp kèm rác trang trí. Giải pháp cứu dữ liệu 2 tầng:

1. **Bước 1 — Cài đặt Clipboard Hook trước khi gửi Prompt:**
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
2. **Bước 2 — Khi AI trả lời xong, áp dụng 2 tầng bóc tách:**
   - **Tầng 1 (Ưu tiên số 1 - Chuẩn 100% nguyên bản):** Tìm nút `codeCopyButton` của block code Markdown ngoài cùng, click vào đó và đọc `window.__last_copied_code`. Nhận ngay payload Markdown/XML nguyên bản mà không cần quyền OS clipboard và không ghi đè clipboard của user.
   - **Tầng 2 (Dự phòng thông minh):** Nếu không có nút copy, đọc DOM từ `responseContainer`, loại bỏ các phần tử rác trang trí (`.code-block-decoration`, `.buttons`...) hoặc chuyển đổi qua `webHtmlToMarkdown()`.

---

## 5. Quản lý Hội thoại với `GenericConversationStore`

Không tự viết lại class Map/TTL lưu trữ hội thoại. Hãy tái sử dụng `deriveStableConversationKey` và `GenericConversationStore` từ `src/adapters/web/conversation`:

```typescript
// src/adapters/<provider-name>/conversation-store.ts
import type { CodexParsedRequest } from "../../types";
import {
  deriveStableConversationKey,
  GenericConversationStore,
} from "../web/conversation";

export function myProviderConversationKey(
  parsed: CodexParsedRequest,
  explicitKey?: string,
): string {
  return deriveStableConversationKey(parsed, "<provider-name>", explicitKey);
}

export const defaultMyProviderConversationStore = new GenericConversationStore();
```

---

## 6. Khai báo `WebProviderDefinition`, Lifecycle Policies & Kế thừa `WebProviderAdapter`

File quản lý: `src/adapters/<provider-name>/index.ts`.

### 6.1. Bảng Quyết định Lifecycle & Error Policies (`WebProviderPolicies`)

Khi khai báo `policies` trong `WebProviderDefinition`, cần chọn rõ các chính sách sau:

| Policy | Giá trị | Khi nào sử dụng |
| :--- | :--- | :--- |
| `launcherFailureMode` | `"fail-closed"` (mặc định) hoặc `"fallback-local"` | Dùng `"fail-closed"` khi bắt buộc chạy trên tab của Launcher (ChatGPT, Qwen, AI Studio, M365). Dùng `"fallback-local"` nếu cho phép mở Chrome cục bộ khi Launcher tắt (Gemini). |
| `manageLauncherLeaseInEngine` | `true` (mặc định) hoặc `false` | Đặt `true` để `runtime-lifecycle.ts` tự động `startLauncherBrowserTurn` / `endLauncherBrowserTurn` quanh toàn lượt. Chỉ đặt `false` nếu worker tự quản lý lease theo từng attempt (như M365). |
| `closeLauncherConnectionOnEnd` | `true` (mặc định) hoặc `false` | Đặt `true` để đóng kết nối Playwright CDP trong `finally`. Đặt `false` nếu cần giữ nguyên kết nối sau khi gửi `phase=end` (như Google AI Studio). |
| `emitErrorEventOnFailure` | `true` (mặc định) hoặc `false` | Đặt `true` nếu muốn engine phát `{ type: "error", message }` trước khi xử lý ngoại lệ. Đặt `false` nếu tầng caller/server đã tự chuyển exception thành sự kiện lỗi (Qwen, AI Studio) để tránh nhân đôi thông báo lỗi. |
| `rethrowError` | `true` (mặc định) hoặc `false` | Đặt `true` để ném lại lỗi cho caller. Đặt `false` nếu adapter tự kết thúc lượt bằng sự kiện `error` (trừ trường hợp bị abort giữa chừng vẫn ném `AbortError`). |
| `maxFormatRetries` | `number` hoặc `() => number` (mặc định `2`) | Số lần tự động gửi prompt sửa lỗi định dạng `<webResponse>` trên cùng hội thoại. |
| `enableEarlyExitOnFinalAnswer` | `boolean` (mặc định `false`) | Bật khi cần ngắt sớm nếu tin nhắn cuối cùng trong context đã là câu trả lời hoàn tất của assistant. |
| `enableToolLoopGuard` | `boolean` (mặc định `false`) | Bật bộ bảo vệ chống lặp vô hạn công cụ (`conversationGuard`, `MAX_TOOL_ITERATIONS`, `getMaxIdenticalToolCalls`). |

### 6.2. Mẫu Triển khai `src/adapters/<provider-name>/index.ts`

```typescript
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../base";
import { LocalBrowserRuntime } from "../web/local-browser-runtime";
import { WebProviderAdapter } from "../web/web-provider-adapter";
import { MyProviderBrowserWorker } from "./browser-worker";
import {
  defaultMyProviderConversationStore,
  myProviderConversationKey,
} from "./conversation-store";
import { isValidMyProviderConversationId } from "./selectors";

export interface MyProviderAdapterOptions {
  userDataDir?: string;
  headless?: boolean;
  descriptorPath?: string;
  maxFormatRetries?: number;
}

export class MyProviderWebAdapter extends WebProviderAdapter {
  override readonly name = "my-provider-web";

  constructor(options?: MyProviderAdapterOptions) {
    const resolvedOptions: MyProviderAdapterOptions = {
      userDataDir: options?.userDataDir || join(homedir(), ".codex-my-provider-web"),
      headless: options?.headless ?? false,
      maxFormatRetries: options?.maxFormatRetries ?? 2,
      ...options,
    };
    const localBrowser = new LocalBrowserRuntime({
      profileDir: resolvedOptions.userDataDir!,
      headless: resolvedOptions.headless,
      logPrefix: "my-provider-adapter",
    });
    const worker = new MyProviderBrowserWorker();

    super(
      {
        id: "my-provider-web",
        assistantName: "MyProvider",
        logPrefix: "my-provider-adapter",
        abortMessage: "MyProvider turn aborted before start",
        policies: {
          launcherFailureMode: "fail-closed",
          emitErrorEventOnFailure: false,
          rethrowError: true,
          maxFormatRetries: resolvedOptions.maxFormatRetries ?? 2,
        },
        conversation: {
          resolveConversationKey: ({ parsed, threadId }) =>
            myProviderConversationKey(parsed, threadId),
          resolveState: ({ threadId, leaseConversationId, hasPriorAssistantReply }) => {
            const storedId = defaultMyProviderConversationStore.getConversationId(threadId);
            const rawId = leaseConversationId || storedId;
            const existingConversationId = isValidMyProviderConversationId(rawId || "")
              ? rawId
              : undefined;
            const isNewConversation = !hasPriorAssistantReply && !existingConversationId;
            return { existingConversationId, isNewConversation };
          },
          onConversationUpdated: ({ threadId, conversationId }) => {
            if (isValidMyProviderConversationId(conversationId || "")) {
              defaultMyProviderConversationStore.setConversationId(threadId, conversationId!);
              return conversationId;
            }
            return undefined;
          },
          resolveEndTurnBinding: ({ finalStatus, activeConversationId }) => {
            const isValid = isValidMyProviderConversationId(activeConversationId || "");
            return {
              connectorBound: finalStatus === "completed" && isValid,
              conversationId: isValid ? activeConversationId : undefined,
            };
          },
        },
        capability: {
          resolveReasoningEffort: parsed => parsed.options.reasoning || "medium",
        },
        browser: {
          descriptorPath: resolvedOptions.descriptorPath,
          launcherProviderId: "qwen", // hoặc thêm provider ID mới vào WebLauncherProviderId
          connectorIdentity: "my-provider-web",
          executeTurn: async ({
            page,
            prompt,
            attempt,
            incoming,
            reasoningEffort,
            existingConversationId,
            isNewConversation,
          }) => {
            if (!page) {
              throw new Error("[my-provider-adapter] Không có trình duyệt khả dụng.");
            }
            return worker.executeTurn(page, {
              prompt,
              signal: incoming.abortSignal,
              reasoningEffort: (reasoningEffort || "medium") as "low" | "medium" | "high",
              conversationId: existingConversationId,
              isNewConversation,
              onChunk: () => {},
            });
          },
        },
        response: {
          createCallId: () =>
            `call_myprovider_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        },
      },
      localBrowser,
    );
  }
}

export function createMyProviderWebAdapter(
  options?: MyProviderAdapterOptions,
): ProviderAdapter {
  return new MyProviderWebAdapter(options);
}
```

---

## 7. Prompt Pipeline, Protocol `<webResponse>` & Tool Bridge Dùng Chung

Khi kế thừa `WebProviderAdapter`, `WebTurnEngine` (`src/adapters/web/engine.ts`) đã **tự động thực hiện toàn bộ** các bước sau mà provider không cần viết lại:

1. **Biên dịch Prompt (`compileWebPrompt`)**:
   - **Turn 1 (`isNewConversation = true`)**: Khởi tạo handshake `<webResponse>` + danh sách công cụ đầy đủ.
   - **Turn 2+ (`isNewConversation = false`)**: Danh sách công cụ rút gọn + kết quả thực thi tool (`<tool_result id="...">`).
   - Hỗ trợ sẵn Plan Mode (`<proposed_plan>`) và Interactive Interview (`request_user_input`).
   - Chỉ khai báo `definition.compilePrompt` nếu provider có yêu cầu biên dịch đặc thù riêng.
2. **Phân tích & Xác thực Giao thức (`parseStrictWebResponse` + `validateWebProtocolResponse`)**:
   - Sử dụng các API chuẩn trung lập tại `src/adapters/web/protocol` (`parseStrictWebResponse`, `StrictWebResponseResult`, `StrictWebToolCall`, `WebProtocolErrorCode`).
   - *Lưu ý:* Các tên cũ `parseStrictM365Response`, `M365ToolBridge` chỉ là alias tương thích ngược; **không sử dụng tên `M365*` khi viết code cho adapter mới**.
   - Nếu provider cần lọc rác UI trước khi parse hoặc cho phép fallback văn bản tự nhiên, cấu hình qua `response.sanitizeRawResponse` và `response.tolerantNaturalTextFallback`.
3. **Vòng lặp Tự sửa lỗi Định dạng (`runWebProtocolRetry`)**:
   - Tự động gửi prompt sửa lỗi trên cùng cuộc hội thoại (`attempt > 0` tự động nhận `isNewConversation: false` và `existingConversationId: activeConversationId`, đồng thời không gửi lại image attachments).
4. **Chuẩn hóa & Phát Sự kiện Công cụ (`WebToolBridge` + `emitWebProtocolResponse`)**:
   - Mọi tool call được chuẩn hóa tên và tham số qua `src/adapters/web/tools/argument-normalizer.ts` và kiểm tra an toàn qua `SafeCommandGuard` + `WebToolBridge.mapToolCall()`.

---

## 8. Đăng ký Model tại `src/models/` & Định tuyến Server

Quản lý model hiện được tập trung tại thư mục `src/models/`:

1. **Đăng ký Provider & Route trong `src/models/model-registry.ts`**:
   - Bổ sung định danh vào `ModelProviderId`.
   - Khai báo cấu hình trong `MODEL_PROVIDERS` (bao gồm `exactSlugs`, `slugPrefixes`, `routes` với đầy đủ `contextWindow`, `autoCompactTokenLimit`, `inputModalities` và `reasoningLevels`).
2. **Đồng bộ Model Catalog trong `src/models/model-catalog.ts`**:
   - Đảm bảo `augmentNativeModelCatalog()` và `syncManagedModelCatalogFile()` xuất đầy đủ các model route mới cho Codex model picker.
3. **Định tuyến Request trong `src/server.ts`**:
   - Dùng `isProviderModel(modelId, "<provider-id>")` trong `responseRequest()` để ủy quyền lượt gọi sang `handle<Provider>ResponseRequest()` và gọi `adapter.runTurn(parsed, incoming, emit)`.

---

## 9. Tích hợp Giao diện Launcher Electron

1. **Khai báo Partition & Surface Manager**:
   - Tạo surface manager tại `launcher/electron/<name>-surface-manager.cjs` và kết nối vào `launcher/electron/browser-host.cjs`.
   - Tạo phân vùng độc lập: `persist:codex-<name>-web` và thêm vào danh sách partition hợp lệ trong cả Electron lẫn `src/launcher-browser-host.ts`.
   - Bổ sung provider vào `WebLauncherProviderId` (`src/adapters/web/definition.ts`) và `LauncherTurnActivity` (`src/launcher-browser-host.ts`).
2. **Quy trình Xác thực & Smoke Test**:
   - `probeAuthentication()`: Kiểm tra URL, phát hiện nút đăng nhập hoặc composer.
   - `runSmokeTest()`: Gửi prompt xác nhận `CODEX WEB GPT READY`, kiểm tra câu trả lời xuất hiện trong DOM.
3. **Giao diện Người dùng Launcher (`launcher/src/App.tsx`)**:
   - Thêm provider vào Sidebar, màn hình Setup (Đăng nhập -> Smoke Test -> Install into Codex) và Settings.

---

## 10. Checklist Kiểm thử & Cổng Kiến trúc (Architecture Gates)

Trước khi hoàn tất tích hợp một Web Adapter mới, **BẮT BUỘC** vượt qua toàn bộ các cổng kiểm tra sau:

1. **Kiểm tra Kiến trúc & Ranh giới Module (`check:architecture`)**:
   ```bash
   bun run check:architecture
   ```
   Đảm bảo:
   - Không có circular dependency (`Cycles = 0`).
   - `src/adapters/web/` không import ngược bất kỳ provider nào và không chứa selector DOM đặc thù của provider.
   - `src/adapters/<provider>/index.ts` kế thừa `WebProviderAdapter` (`extends WebProviderAdapter`) và **không** gọi trực tiếp các hàm điều phối cấp thấp (`startLauncherBrowserTurn`, `endLauncherBrowserTurn`, `runWebProtocolRetry`, `emitWebProtocolResponse`, `validateWebProtocolResponse`, `parseStrictWebResponse`).
   - Bổ sung adapter mới vào danh sách `providerFacades` trong `tests/m365-architecture-integrity.test.ts` và test kế thừa trong `tests/web-turn-engine.test.ts`.

2. **Chạy Bộ Contract Tests của `WebTurnEngine` & Unit Tests của Adapter**:
   ```bash
   bun test tests/web-turn-engine.test.ts tests/<provider>-web-adapter.test.ts
   ```
   Các kịch bản bắt buộc phải có:
   - Nhận diện model slug & phân giải reasoning effort.
   - Khôi phục hội thoại (`resolveState`, `onConversationUpdated`, `resolveEndTurnBinding`).
   - Quarantine luồng stream thô (không rò rỉ `<webResponse>` hoặc `<tool_call>` qua `onChunk`).
   - Tự động retry khi sai định dạng (`attempt > 0` giữ nguyên `conversationId` và `isNewConversation: false`).
   - Xử lý hủy lượt (`AbortSignal`) và giải phóng browser surface trong `finally`.

3. **Kiểm tra Build Runtime & Launcher**:
   ```bash
   git diff --check
   bun run build
   bun run launcher:build
   ```

4. **Kiểm thử Trực quan End-to-End**:
   - Mở Launcher, đăng nhập tài khoản Web Provider và chạy Smoke Test báo xanh (`Passed`).
   - Gửi yêu cầu từ Codex IDE: xác nhận chọn đúng model/reasoning, thực thi được tool call (`exec_command`, `apply_patch`), và hiển thị final answer Markdown sạch sẽ.
