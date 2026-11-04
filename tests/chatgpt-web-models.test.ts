import { describe, expect, test } from "bun:test";
import {
  findModelProvider,
  isProviderModel,
  listModelRoutes,
  requireModelRoute,
  resolveModelMode,
  resolveModelReasoning,
} from "../src/models/model-registry";
import { routeChatGptWebRequest } from "../src/server";
import type { CodexParsedRequest } from "../src/types";

function parsed(reasoning: "low" | "high"): CodexParsedRequest {
  return {
    modelId: "chatgpt-web",
    context: { messages: [] },
    stream: false,
    options: { reasoning },
    _rawBody: {
      model: "chatgpt-web",
      reasoning: { effort: reasoning },
    },
  };
}

describe("ChatGPT Web model đơn giản", () => {
  test("chỉ công bố một model ChatGPT Web", () => {
    const routes = listModelRoutes("chatgpt-web");

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      slug: "chatgpt-web",
      displayName: "ChatGPT (Web)",
      backendModel: "chatgpt-web",
      contextWindow: 100_000,
      autoCompactTokenLimit: 90_000,
      defaultReasoningLevel: "low",
    });
    expect(routes[0]?.reasoningLevels).toEqual([
      { effort: "low", description: "Normal", mode: "normal" },
      { effort: "high", description: "Thinking", mode: "thinking" },
    ]);
  });

  test("nhận dạng model qua registry chung", () => {
    expect(findModelProvider("chatgpt-web")?.id).toBe("chatgpt-web");
    expect(isProviderModel("chatgpt-web", "chatgpt-web")).toBeTrue();
    expect(isProviderModel("m365-copilot", "chatgpt-web")).toBeFalse();
    expect(() => requireModelRoute("chatgpt-web/legacy")).toThrow("Model không tồn tại");
  });

  test("ánh xạ low thành Normal và high thành Thinking", () => {
    const route = requireModelRoute("chatgpt-web");

    expect(resolveModelReasoning(route, "low")).toEqual({
      effort: "low",
      description: "Normal",
      mode: "normal",
    });
    expect(resolveModelReasoning(route, "high")).toEqual({
      effort: "high",
      description: "Thinking",
      mode: "thinking",
    });
    expect(resolveModelMode("chatgpt-web", "low")).toBe("normal");
    expect(resolveModelMode("chatgpt-web", "high")).toBe("thinking");
  });

  test("server giữ một backend identity và chuyển reasoning", () => {
    const normal = parsed("low");
    const normalRoute = routeChatGptWebRequest(normal, {} as never);
    expect(normalRoute.slug).toBe("chatgpt-web");
    expect(normal.modelId).toBe("chatgpt-web");
    expect(normal.options.reasoning).toBe("low");

    const thinking = parsed("high");
    const thinkingRoute = routeChatGptWebRequest(thinking, {} as never);
    expect(thinkingRoute.slug).toBe("chatgpt-web");
    expect(thinking.modelId).toBe("chatgpt-web");
    expect(thinking.options.reasoning).toBe("high");
  });
});
