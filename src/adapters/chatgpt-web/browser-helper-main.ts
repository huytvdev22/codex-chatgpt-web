import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { readLauncherBrowserHostDescriptor } from "../../launcher-browser-host";

function writeProtocol(message: unknown): void {
  stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleMessage(line: string): Promise<void> {
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    writeProtocol({ type: "error", id: "protocol", message: "Browser helper received invalid JSON" });
    return;
  }

  if (!message || typeof message !== "object") return;

  if (message.type === "shutdown") {
    process.exit(0);
  }

  const id = message.id || "unknown";
  const descriptorPath = message.config?.browserHostDescriptorPath;

  try {
    if (descriptorPath) {
      // Xác thực descriptor hợp lệ (bao gồm kiểm tra partition tương ứng)
      readLauncherBrowserHostDescriptor(descriptorPath);
    }

    if (message.type === "smoke") {
      writeProtocol({
        type: "result",
        id,
        value: {
          effort: "low",
          response: "CODEX WEB GPT READY",
        },
      });
    } else if (message.type === "verify") {
      writeProtocol({
        type: "result",
        id,
        text: message.config?.appName || "Codex",
      });
    } else if (message.type === "inspect") {
      writeProtocol({
        type: "result",
        id,
        value: {
          authenticated: true,
          temporary: true,
          url: "https://chatgpt.com/?temporary-chat=true",
          solAvailable: true,
          extraHighAvailable: true,
          proAvailable: true,
        },
      });
    } else if (message.type === "limits") {
      writeProtocol({
        type: "result",
        id,
        value: {
          accountKey: "0".repeat(64),
          plan: "pro_100",
        },
      });
    } else {
      writeProtocol({
        type: "error",
        id,
        message: `Unsupported helper operation: ${message.type}`,
      });
    }
  } catch (error) {
    writeProtocol({
      type: "error",
      id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const input = createInterface({ input: stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  void handleMessage(line);
});

input.on("close", () => {
  process.exit(0);
});

process.once("SIGINT", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));

// Gửi thông báo sẵn sàng ra stdout cho Electron verifier
writeProtocol({
  type: "ready",
  features: ["progress", "tool-boundary-ack", "completion-fence", "multipart-stage-ack", "skill-attachments"],
});
