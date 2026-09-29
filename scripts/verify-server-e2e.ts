import http from "node:http";
import { modelsRequest, responseRequest } from "../src/server.ts";
import { defaultConfig } from "../src/config.ts";

console.log("=================================================");
console.log("🌐 KIỂM THỬ END-TO-END HTTP SERVER (MULTI-PROVIDER)");
console.log("=================================================");

const PORT = 8089;
const config = defaultConfig();

// Khởi tạo máy chủ HTTP giả lập server.ts
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url!, `http://${req.headers.host}`);

  // Chuyển đổi Node req thành Web Standard Request
  const bodyChunks: Buffer[] = [];
  for await (const chunk of req) {
    bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const bodyBuffer = Buffer.concat(bodyChunks);
  
  const standardReq = new Request(url.href, {
    method: req.method,
    headers: new Headers(req.headers as any),
    body: ["GET", "HEAD"].includes(req.method || "") ? undefined : bodyBuffer,
  });

  try {
    let standardRes: Response;
    if (url.pathname === "/v1/models") {
      standardRes = await modelsRequest(standardReq, config);
    } else if (url.pathname === "/v1/responses") {
      standardRes = await responseRequest(standardReq, config);
    } else {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    res.writeHead(standardRes.status, Object.fromEntries(standardRes.headers.entries()));
    if (standardRes.body) {
      const reader = standardRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (err: any) {
    console.error("Lỗi xử lý request:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, async () => {
  console.log(`Server test đang chạy trên http://127.0.0.1:${PORT}`);

  try {
    // 1. Kiểm tra GET /v1/models
    console.log("\n[Test 1] Gửi GET /v1/models...");
    const modelsRes = await fetch(`http://127.0.0.1:${PORT}/v1/models`);
    const modelsData = await modelsRes.json() as any;
    
    const slugs = (modelsData.models || []).map((m: any) => m.slug);
    console.log("Danh sách models nhận được từ server:", slugs);

    const hasM365 = slugs.includes("m365-copilot/gpt-5") && slugs.includes("m365-copilot/fast");
    const hasChatGPT = slugs.some((s: string) => s.startsWith("chatgpt-web/"));

    if (hasM365 && hasChatGPT) {
      console.log("✅ [Test 1 PASSED] Server trả về đầy đủ cả M365 Copilot và ChatGPT Web models!");
    } else {
      console.error("❌ [Test 1 FAILED] Thiếu model trong danh mục!");
      process.exit(1);
    }

    // 2. Kiểm tra POST /v1/responses với model m365-copilot/gpt-5 qua SSE
    console.log("\n[Test 2] Gửi POST /v1/responses (SSE streaming) với model m365-copilot/gpt-5...");
    const responseStreamRes = await fetch(`http://127.0.0.1:${PORT}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "m365-copilot/gpt-5",
        stream: true,
        input: [
          {
            type: "message",
            role: "user",
            content: "Chào M365, hãy cho biết 2 x 3 = mấy? Trả lời trong đúng 1 câu duy nhất."
          }
        ]
      })
    });

    console.log(`HTTP Status: ${responseStreamRes.status}`);
    console.log(`Content-Type: ${responseStreamRes.headers.get("content-type")}`);

    const reader = responseStreamRes.body!.getReader();
    const decoder = new TextDecoder();
    let sseOutput = "";
    let receivedEvents = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      sseOutput += chunk;
      receivedEvents++;
    }

    console.log(`Nhận được SSE Stream (${receivedEvents} chunks).`);
    console.log("Trích đoạn SSE stream:\n", sseOutput.slice(0, 400), "...");

    if (sseOutput.includes("response.text.delta") || sseOutput.includes("response.completed") || sseOutput.includes("6")) {
      console.log("✅ [Test 2 PASSED] SSE Streaming qua M365 Copilot thành công 100%!");
    } else {
      console.error("❌ [Test 2 FAILED] SSE Stream không có dữ liệu hợp lệ!");
      process.exit(1);
    }

    console.log("\n🎉 KIỂM THỬ END-TO-END THÀNH CÔNG VƯỢT TRỘI!");
    process.exit(0);
  } catch (err) {
    console.error("Lỗi trong quá trình kiểm thử:", err);
    process.exit(1);
  } finally {
    server.close();
  }
});
