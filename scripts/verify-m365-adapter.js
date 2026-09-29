import { isM365ModelSlug, availableM365ModelRoutes } from "../src/m365-models.ts";
import { createM365CopilotAdapter } from "../src/adapters/m365-copilot/index.ts";

console.log("=================================================");
console.log("🚀 KIỂM THỬ TÍCH HỢP M365 COPILOT ADAPTER");
console.log("=================================================");

// 1. Kiểm tra Model Catalog M365
console.log("\n[Test 1] Kiểm tra cấu hình Model Catalog M365...");
const routes = availableM365ModelRoutes();
console.log("Danh sách route M365:", routes.map(r => r.slug));

if (routes.length >= 2 && isM365ModelSlug("m365-copilot/gpt-5") && !isM365ModelSlug("chatgpt-web/gpt-5.6")) {
  console.log("✅ [Test 1 PASSED] Model routes và prefix detection hoạt động chính xác!");
} else {
  console.error("❌ [Test 1 FAILED] Lỗi kiểm tra model routes!");
  process.exit(1);
}

// 2. Kiểm tra Title Guard (Phản hồi tức thì yêu cầu sinh tiêu đề của Codex)
console.log("\n[Test 2] Kiểm tra Title Guard (5ms response)...");
const adapter = createM365CopilotAdapter();

const titleRequest = {
  modelId: "m365-copilot/gpt-5",
  context: {
    systemPrompt: ["Respond with a title and description for this conversation."],
    messages: [
      {
        role: "user",
        content: "Viết hàm tính tổng hai số bằng JavaScript",
        timestamp: Date.now()
      }
    ]
  },
  stream: true,
  options: {}
};

let titleText = "";
let titleDone = false;
const startTime = Date.now();

await adapter.runTurn(
  titleRequest,
  { headers: new Headers() },
  (event) => {
    if (event.type === "text_delta") {
      titleText += event.text;
    } else if (event.type === "done") {
      titleDone = true;
    }
  }
);

const durationMs = Date.now() - startTime;
console.log(`Thời gian phản hồi Title Guard: ${durationMs}ms`);
console.log(`Kết quả tiêu đề: \n"${titleText}"`);

if (titleDone && titleText.includes("title:") && durationMs < 50) {
  console.log("✅ [Test 2 PASSED] Title Guard phản hồi siêu tốc thành công!");
} else {
  console.error("❌ [Test 2 FAILED] Title Guard không hoạt động như mong đợi!");
  process.exit(1);
}

// 3. Kiểm tra Prompt thực tế gửi vào Brave Browser tab M365
console.log("\n[Test 3] Kiểm tra gửi câu hỏi thực tế vào tab M365 Copilot trên Brave Browser...");

const codingRequest = {
  modelId: "m365-copilot/gpt-5",
  context: {
    systemPrompt: ["Bạn là trợ lý lập trình chuyên nghiệp."],
    messages: [
      {
        role: "user",
        content: "Viết một hàm TypeScript tính số Fibonacci thứ n (dùng vòng lặp tối ưu O(n)). Trả lời ngắn gọn chỉ code và giải thích 1 câu.",
        timestamp: Date.now()
      }
    ]
  },
  stream: true,
  options: {}
};

console.log("Đang gửi prompt vào M365 Copilot...");
let responseText = "";
let turnDone = false;
let deltaCount = 0;
const turnStartTime = Date.now();

await adapter.runTurn(
  codingRequest,
  { headers: new Headers() },
  (event) => {
    if (event.type === "text_delta") {
      deltaCount++;
      responseText += event.text;
      process.stdout.write(event.text);
    } else if (event.type === "done") {
      turnDone = true;
      console.log("\n\n📊 Thống kê token:", event.usage);
    } else if (event.type === "error") {
      console.error("\n❌ Lỗi:", event.message);
    }
  }
);

const turnDuration = ((Date.now() - turnStartTime) / 1000).toFixed(1);
console.log(`\nThời gian hoàn thành: ${turnDuration}s (${deltaCount} streaming chunks)`);

if (turnDone && responseText.length > 0) {
  console.log("✅ [Test 3 PASSED] M365 Copilot Adapter hoạt động hoàn hảo 100%!");
} else {
  console.error("❌ [Test 3 FAILED] Không nhận được câu trả lời từ M365 Copilot!");
  process.exit(1);
}

console.log("\n🎉 TẤT CẢ CÁC BÀI KIỂM THỬ ĐỀU THÀNH CÔNG RỰC RỠ!");
